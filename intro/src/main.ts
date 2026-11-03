/**
 * The Unpacking — phase-1 animatic.
 *
 * Boot order is the product's, not the animatic's: the page and its input are
 * real from first paint, this module is loaded after it, and nothing on the page
 * depends on anything below. That is why the intro can be skipped without the
 * Builder noticing.
 *
 * Review knobs (query string):
 *   ?intro=force   play even though this browser has seen it
 *   ?intro=off     do not play at all
 *   ?again         same as force
 *   ?t=2.4         build, then freeze at 2.4 s (for stills)
 *   ?paused=1      build and hold on frame 0 for scrubbing
 *   ?speed=0.25    start at a slower playback speed
 *   ?theme=dark    pin the dark palette, same as the transport's Dark button
 *   ?reduced=1     take the reduced-motion path without changing an OS setting
 */

import "./tokens.css";
import "./page.css";
import "./intro.css";
import "./transport.css";

import { gsap } from "gsap";

import { buildSample } from "./sample";
import { buildScene, type Scene } from "./scene";
import { buildTimeline, TOTAL, type PageRefs, type TimelineHandle } from "./timeline";
import { createTransport } from "./transport";
import { prefersReducedMotion } from "./util";

const SEEN_KEY = "unpackfund.intro.seen";
const REPLAY_AFTER_DAYS = 90;

const params = new URLSearchParams(location.search);
const forced = params.get("intro");
const freezeAt = params.get("t");
const startPaused = params.has("paused");
const initialSpeed = Number(params.get("speed") ?? 1) || 1;
const forcedTheme = params.get("theme");
const forcedReduced = params.has("reduced");

if (forcedTheme === "dark" || forcedTheme === "light") {
  document.documentElement.dataset.theme = forcedTheme;
}

const root = must<HTMLDivElement>("intro-root");
const transportHost = must<HTMLElement>("transport");
const input = must<HTMLInputElement>("ticker");

const refs: PageRefs = {
  h1: must("builder-h1"),
  header: must("page-header"),
  prose: must("page-prose"),
  footer: must("page-footer"),
  form: must("builder-form"),
  hint: must("ticker-hint"),
  madeBy: must("made"),
};

let scene: Scene | null = null;
let handle: TimelineHandle | null = null;
let transport: ReturnType<typeof createTransport> | null = null;
let grainTween: gsap.core.Tween | null = null;
let finished = false;
let skipping = false;
let startTime = 0;

// ---------------------------------------------------------------- boot

void boot();

async function boot(options: { replay?: boolean } = {}): Promise<void> {
  wireBuilder();

  if (!options.replay && (!shouldPlay() || forced === "off")) {
    document.documentElement.dataset.intro = "skipped";
    return;
  }

  document.documentElement.dataset.intro = "playing";

  // Fonts first: SplitText must break the headline where the real font breaks
  // it, and the card's mono ticker must not reflow mid-animation. A slow or
  // blocked font must not hold the intro hostage.
  await Promise.race([
    document.fonts.ready,
    new Promise((resolve) => setTimeout(resolve, 1200)),
  ]);

  if (forcedReduced || prefersReducedMotion()) {
    document.documentElement.dataset.intro = "reduced";
    finalFrameFade();
    rememberSeen();
    return;
  }

  window.scrollTo(0, 0);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  startTime = performance.now();
  build();

  if (freezeAt !== null) {
    const time = Number(freezeAt);
    if (Number.isFinite(time)) handle?.seek(time);
    transport?.setPlaying(false);
  } else if (startPaused) {
    handle?.seek(0);
    transport?.setPlaying(false);
  } else {
    handle?.tl.play();
    rememberSeen();
  }
}

function build(): void {
  const sample = buildSample();
  const built = buildScene(root, sample.dots, sample.pairs, sample.labelled, sample.funds, input);
  scene = built;

  handle = buildTimeline(built, refs, {
    tardy: sample.tardy,
    onFinish: () => finish({ natural: true }),
  });
  handle.tl.timeScale(initialSpeed);

  grainTween = gsap.to(built.grain, {
    backgroundPosition: "180px 180px",
    duration: 7,
    repeat: -1,
    ease: "none",
  });

  transport = createTransport(transportHost, handle, {
    dotCount: built.dots.length,
    tier: "svg (phase 1)",
    reduced: forcedReduced || prefersReducedMotion(),
    onReplay: replay,
  });

  transportHost.style.setProperty("--transport-h", `${transportHost.getBoundingClientRect().height}px`);
  document.documentElement.style.setProperty(
    "--transport-h",
    `${transportHost.getBoundingClientRect().height}px`,
  );

  handle.tl.eventCallback("onComplete", () => finish({ natural: true }));
  wireSkip();
  syncGrain();
}

// ---------------------------------------------------------------- skip

function wireSkip(): void {
  const skip = (event: Event): void => {
    if (finished || skipping) return;
    if (!handle) return;
    const target = event.target as HTMLElement | null;
    // The review furniture and the Builder itself are not dismissible-by-key:
    // using them is the whole point.
    if (target?.closest("#transport")) return;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    skipping = true;
    skipIntro();
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("pointerdown", skip, true);
  window.addEventListener("wheel", skip, { passive: true, capture: true });
  window.addEventListener("touchstart", skip, { passive: true, capture: true });

  function onKeyDown(event: KeyboardEvent): void {
    // A keydown aimed at `window` or `document` has no `closest`; only an
    // Element can tell us whether the press belongs to the page or to us.
    const target = event.target instanceof Element ? event.target : null;
    const inTransport = Boolean(target?.closest("#transport"));
    const inField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target === input;

    if (event.key === "Escape") {
      event.preventDefault();
      skip(event);
      return;
    }
    if ((event.key === "u" || event.key === "U") && !inField && !inTransport) {
      event.preventDefault();
      replay();
      return;
    }
    if (event.key === "r" || event.key === "R") {
      if (!inField && !inTransport) {
        event.preventDefault();
        handle?.tl.restart();
        handle?.tl.play();
        transport?.setPlaying(true);
      }
      return;
    }
    if (inTransport) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Tab") return;
    skip(event);
  }
}

function skipIntro(): void {
  if (!handle) return;
  // Not a cut: the same timeline, run to its last frame in one frame.
  handle.tl.pause();
  handle.tl.progress(1);
  finish({ natural: false });
}

function finish(options: { natural: boolean }): void {
  if (finished) return;
  finished = true;
  grainTween?.kill();
  document.documentElement.dataset.intro = "done";

  // The page's own chrome is revealed by the last beat; the overlay is spent.
  // Drop its nodes too — a hundred and twenty dots that nothing will animate
  // again are just memory on a phone.
  root.style.display = "none";
  const retire = (): void => {
    if (!finished) return;
    root.replaceChildren();
    root.dataset.spent = "1";
  };
  window.setTimeout(retire, 400);

  if (options.natural) {
    // The handoff's last line from the brief: focus the input when the
    // transition finishes.
    input.focus({ preventScroll: true });
  }

  const elapsed = (performance.now() - startTime) / 1000;
  document.documentElement.dataset.runMs = String(Math.round(elapsed * 1000));
}

// ---------------------------------------------------------------- replay

function replay(): void {
  // Three ways in: a finished run whose nodes were retired, a run that never
  // started (reduced motion), or a run that is live right now. The first two
  // have to rebuild the stage from scratch; only the last can be restarted.
  const retiring = root.dataset.spent === "1";
  if (!handle || retiring) {
    handle?.tl.kill();
    transport?.destroy();
    grainTween?.kill();
    handle = null;
    scene = null;
    transport = null;
    grainTween = null;
    finished = false;
    skipping = false;
    root.style.display = "";
    delete root.dataset.spent;
    root.replaceChildren();
    void boot({ replay: true });
    return;
  }
  finished = false;
  skipping = false;
  root.style.display = "";
  grainTween?.play();
  handle.tl.restart();
  handle.tl.play();
  transport?.setPlaying(true);
  document.documentElement.dataset.intro = "playing";
  transportHost.style.setProperty("--transport-h", `${transportHost.getBoundingClientRect().height}px`);
}

// ---------------------------------------------------------------- reduced

function finalFrameFade(): void {
  const veil = document.createElement("div");
  veil.className = "veil";
  document.body.appendChild(veil);
  requestAnimationFrame(() => {
    veil.classList.add("veil--out");
    window.setTimeout(() => veil.remove(), 260);
  });
  refs.madeBy.style.transition = "opacity 200ms ease";
  refs.madeBy.style.opacity = "1";
}

// ---------------------------------------------------------------- grain

function syncGrain(): void {
  if (!grainTween || !handle) return;
  if (handle.tl.paused()) grainTween.pause();
  else grainTween.play();
  handle.tl.eventCallback("onUpdate", () => {
    if (grainTween && handle?.tl.paused()) grainTween.pause();
  });
}

// ---------------------------------------------------------------- builder

function wireBuilder(): void {
  const form = refs.form as HTMLFormElement;
  const chips = must<HTMLUListElement>("chips");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim().toUpperCase();
    if (!value) return;
    if (chips.children.length >= 6) chips.replaceChildren();
    const chip = document.createElement("li");
    chip.textContent = value;
    chips.appendChild(chip);
    input.value = "";
    input.focus();
  });
}

// ---------------------------------------------------------------- gate

function shouldPlay(): boolean {
  if (forced === "force" || params.has("again")) return true;
  const seen = readSeen();
  if (seen === null) return true;
  return Date.now() - seen > REPLAY_AFTER_DAYS * 86_400_000;
}

function readSeen(): number | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return null;
    const at = Date.parse(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    // Private mode, a blocked store, or a thrown quota: treat as a first visit,
    // because the failure mode we care about is showing the intro too often.
    return null;
  }
}

function rememberSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, new Date().toISOString());
  } catch {
    /* no persistence, no problem */
  }
}

// ---------------------------------------------------------------- resize

let resizeTimer = 0;
let lastPortrait = window.innerHeight > window.innerWidth * 1.05;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const portrait = window.innerHeight > window.innerWidth * 1.05;
    if (portrait === lastPortrait && Math.abs(window.innerWidth - (scene?.metrics.vw ?? 0)) < 80) return;
    lastPortrait = portrait;
    const progress = handle?.tl.progress() ?? 0;
    const playing = handle ? !handle.tl.paused() : false;
    if (!handle) return;
    transport?.destroy();
    handle.destroy();
    grainTween?.kill();
    root.innerHTML = "";
    finished = false;
    skipping = false;
    build();
    handle?.tl.progress(progress);
    if (playing) handle?.tl.play();
    else transport?.setPlaying(false);
  }, 260);
});

// ---------------------------------------------------------------- helpers

function must<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

// Keep the transport honest about the run length.
document.documentElement.style.setProperty("--run", `${TOTAL}s`);
