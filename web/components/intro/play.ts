/**
 * play.ts — the seam between the film and the page.
 *
 * `play(host, opts)` is the whole contract. It builds the stage inside the curtain the server
 * painted, fetches the two baked artifacts, runs the 9.0 s film, and then always puts back what
 * it touched: the nodes it added, the inline styles it set on the page's own elements, the
 * shadow it put on the input. It resolves `"done"` when the film reached the page and
 * `"skipped"` when the visitor (or their settings) cut it short, and it never rejects — a film
 * that throws is a film that traps the visitor behind a sheet of paper.
 *
 * The host is not this module's to remove: `IntroCurtain` paints it, adopts it, and drops it
 * once this promise settles. Everything here lives under one `.intro` div inside it, which is
 * what makes the teardown a single `remove()`.
 *
 * **The page is never hidden.** The curtain is already opaque paper and already covers the
 * workspace, so the film paints its dark table over the curtain rather than over the page, and
 * the page's own header, headline and input stay in the DOM, at their real geometry, the whole
 * time. That is what makes the handoff a *swap* rather than a reveal: the film's rule and
 * headline are named for a View Transition, and the real h1 and a hairline over the input's
 * border are given the same names in the transition's update callback, so the browser animates
 * one into the other. The page is the thing that was behind the film all along.
 *
 * **Two ways to finish, one frame.** A completed film and a skip converge on
 * `applyFinalFrame()`: the stage is removed, the curtain cleared, the page named for the
 * swap. `runHandoff` is therefore idempotent, and `skip()` is a jump to the last frame rather
 * than a cut away from it.
 */

import "./intro.css";

import { createFoley, type Foley } from "./sound";
import { buildScreen, type FilmData, type FilmScreen } from "./screen";
import { buildTimeline, T, TOTAL_SECONDS, type TimelineHandle } from "./timeline";
import { parseCaption, parseDots, type Caption, type DotField } from "./types";

export type PlayResult = "done" | "skipped";

export interface PlayOptions {
  /**
   * A replay. The session gate decided to run the film again from the visitor's own key, so
   * this module reads and writes no storage — it never does, in either case.
   */
  forced?: boolean;
  /** Called at the instant playback actually begins. Never called on a skip. */
  onStart?: () => void;
}

/** The two requests the film makes. Both are same-origin static files. */
const CAPTION_URL = "/intro/caption.json";
const DOTS_URL = "/intro/dots.bin";

/** How long the film waits for its webfonts before it starts anyway. */
const FONT_WAIT_MS = 340;

/** A hard stop on the artifact fetch: the film plays without dots rather than wait. */
const DATA_TIMEOUT_MS = 2400;

/** The add-field's id. `HoldingsPane` owns it; this is a read, not a dependency. */
const INPUT_ID = "add-holding";

/** The page's real headline, the handoff's other half. */
const PAGE_HEADLINE = "h1.title";

/** View Transition names. Both halves of each pair must carry the same name. */
const RULE_NAME = "intro-rule";
const HEADLINE_NAME = "intro-headline";

/** The foley score, placed on the same clock as the timeline. */
const FOLEY_SCORE = {
  humStart: T("dark", 0.04),
  humEnd: T("handoff", 0.2),
  whirStart: T("scan", 0),
  whirEnd: T("scan", 1),
  clickAt: T("lights", 0.02),
};

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * Wait for the film's webfonts, but never past `deadline`.
 *
 * The letters are the bake's letters (see `screen.ts`), and a fallback face would be the wrong
 * width for the dots, so this is worth a few hundred milliseconds. It is not worth the film not
 * starting: past the deadline the stage is built and the film runs with whatever the browser
 * has, which is also slower than the dark beat that follows.
 */
async function untilFonts(deadline: number): Promise<void> {
  try {
    if (!("fonts" in document)) return;
    const remaining = (): number => Math.max(0, deadline - performance.now());
    const race = (work: Promise<unknown>): Promise<unknown> =>
      Promise.race([work.catch(() => undefined), delay(remaining())]);
    await race(document.fonts.ready);
    await race(document.fonts.load('800 48px "Intro Newsreader"'));
  } catch {
    /* a font that will not load is a font the film does without */
  }
}

async function fetchText(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(url, { signal, credentials: "same-origin" });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function fetchBinary(
  url: string,
  signal: AbortSignal,
): Promise<ArrayBuffer | null> {
  try {
    const response = await fetch(url, { signal, credentials: "same-origin" });
    if (!response.ok) return null;
    return await response.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * Fetch and parse both artifacts. Every failure is local: a missing caption is a captionless
 * film, a corrupt `dots.bin` is a dotless one, and neither is an error the visitor sees.
 */
async function loadFilm(signal: AbortSignal): Promise<FilmData> {
  const [captionText, dotsBuffer] = await Promise.all([
    fetchText(CAPTION_URL, signal),
    fetchBinary(DOTS_URL, signal),
  ]);

  let caption: Caption | null = null;
  let dots: DotField | null = null;

  if (captionText !== null) {
    try {
      caption = parseCaption(JSON.parse(captionText) as unknown);
    } catch {
      caption = null;
    }
  }
  if (dotsBuffer !== null) {
    try {
      dots = parseDots(dotsBuffer);
    } catch {
      dots = null;
    }
  }

  return { caption, dots };
}

/** A hairline over the input's bottom border: the rule's half of the View Transition pair. */
function makeUnderline(input: HTMLElement): HTMLDivElement | null {
  const rect = input.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return null;
  const line = document.createElement("div");
  line.setAttribute("aria-hidden", "true");
  line.dataset.introHandoff = "rule";
  line.style.cssText = [
    "position:fixed",
    `left:${rect.left.toFixed(2)}px`,
    `top:${(rect.bottom - 1).toFixed(2)}px`,
    `width:${rect.width.toFixed(2)}px`,
    "height:2px",
    "border-radius:1px",
    "background:var(--rule-strong, currentColor)",
    "pointer-events:none",
    "z-index:70",
  ].join(";");
  document.body.appendChild(line);
  return line;
}

/** Remove any handoff artifact a previous play left behind (a doubled name aborts a swap). */
function resetStaleArtifacts(): void {
  try {
    for (const node of document.querySelectorAll<HTMLElement>("[data-intro-handoff]")) {
      node.remove();
    }
    for (const element of document.querySelectorAll<HTMLElement>(
      `${PAGE_HEADLINE}, #${INPUT_ID}`,
    )) {
      element.style.removeProperty("view-transition-name");
    }
  } catch {
    /* an unnameable page is a handoff without a morph, not a broken film */
  }
}

/**
 * Focus the add field, the way the last line of the brief asks.
 *
 * `IntroCurtain` holds the page `inert` while the film runs and lifts it when this promise
 * settles, which means a focus call made from in here is dropped on the floor on the first try.
 * One zero-delay retry lands after the curtain's release; the guard means a visitor who has
 * already clicked elsewhere is never dragged away from it.
 */
function focusWhenReachable(input: HTMLElement): void {
  const attempt = (): void => {
    if (!input.isConnected) return;
    input.focus({ preventScroll: true });
  };
  attempt();
  if (document.activeElement !== input) window.setTimeout(attempt, 0);
}

/**
 * Run the film.
 *
 * The visitor's own way out — a click, a tap, a key, a wheel, a scroll — is `requestSkip`,
 * which jumps the score to its last frame. Nothing in this function rejects and nothing in it
 * removes `host`; both are the contract with `IntroCurtain`.
 */
export async function play(
  host: HTMLElement,
  opts: PlayOptions = {},
): Promise<PlayResult> {
  if (typeof window === "undefined" || typeof document === "undefined") return "skipped";
  // Belt and braces: the session gate already refuses to start the film for a visitor who asked
  // for less motion, but a film that only respects that in one place is one refactor away from
  // not respecting it at all.
  if (prefersReducedMotion()) return "skipped";
  if (!host.isConnected) return "skipped";

  resetStaleArtifacts();

  const abort = new AbortController();
  const data = loadFilm(abort.signal);
  const dataTimer = window.setTimeout(() => abort.abort(), DATA_TIMEOUT_MS);

  let screen: FilmScreen | null = null;
  let handle: TimelineHandle | null = null;
  let foley: Foley | null = null;
  let skipped = false;
  let disposed = false;
  let result: PlayResult | null = null;
  let resolvePlay: (value: PlayResult) => void = () => {};
  const finished = new Promise<PlayResult>((resolve) => {
    resolvePlay = resolve;
  });
  const settle = (value: PlayResult): void => {
    if (result !== null) return;
    result = value;
    resolvePlay(value);
  };

  // ---- the handoff ---------------------------------------------------------
  let handoffStarted = false;
  let handoffSettled = false;
  let handoffAnimating = false;
  let handoffTimer = 0;
  let pageHeadline: HTMLElement | null = null;
  let pageInput: HTMLElement | null = null;
  let underlay: HTMLDivElement | null = null;

  const cleanupHandoff = (): void => {
    handoffAnimating = false;
    if (underlay !== null) {
      underlay.remove();
      underlay = null;
    }
    try {
      pageHeadline?.style.removeProperty("view-transition-name");
    } catch {
      /* the page moved on */
    }
  };

  const applyFinalFrame = (): void => {
    if (disposed) return;
    try {
      screen?.destroy();
    } catch {
      /* a stage that failed to build has nothing to remove */
    }
    screen = null;
    // The curtain was opaque paper; the last frame of the film is the same paper, so clearing
    // its background is what lets the real page through underneath the (now empty) host.
    try {
      host.style.backgroundColor = "transparent";
    } catch {
      /* best effort */
    }
  };

  const finishHandoff = (): void => {
    if (handoffSettled) return;
    handoffSettled = true;
    settle(skipped ? "skipped" : "done");
  };

  const prepareHandoff = (): void => {
    try {
      screen?.refs.rule.style.setProperty("view-transition-name", RULE_NAME);
      screen?.refs.headline.style.setProperty("view-transition-name", HEADLINE_NAME);
    } catch {
      /* a browser that refuses the name simply does not morph */
    }
  };

  const runHandoff = (): void => {
    if (handoffStarted) return;
    handoffStarted = true;
    pageHeadline = document.querySelector<HTMLElement>(PAGE_HEADLINE);
    pageInput = document.getElementById(INPUT_ID);

    const headline = pageHeadline;
    const input = pageInput;
    if (
      skipped ||
      headline === null ||
      input === null ||
      typeof document.startViewTransition !== "function"
    ) {
      applyFinalFrame();
      finishHandoff();
      return;
    }

    try {
      handoffAnimating = true;
      const transition = document.startViewTransition(() => {
        applyFinalFrame();
        try {
          underlay = makeUnderline(input);
          if (underlay !== null) underlay.style.viewTransitionName = RULE_NAME;
          headline.style.viewTransitionName = HEADLINE_NAME;
        } catch {
          /* the morph degrades to the crossfade */
        }
        // The names must survive until the new snapshot is taken, so this transition is
        // finished by its `ready` promise, not here.
      });
      void transition.ready.then(finishHandoff).catch(finishHandoff);
      void transition.finished.then(cleanupHandoff).catch(cleanupHandoff);
      handoffTimer = window.setTimeout(() => {
        cleanupHandoff();
        applyFinalFrame();
        finishHandoff();
      }, 1600);
    } catch {
      applyFinalFrame();
      finishHandoff();
    }
  };

  // ---- the visitor's way out ----------------------------------------------
  const listeners: Array<() => void> = [];
  const listen = (
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void => {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };

  const isStageControl = (event: Event): boolean => {
    const target = event.target;
    return target instanceof Element && target.closest(".intro__tools") !== null;
  };

  const requestSkip = (): void => {
    if (skipped || disposed) return;
    skipped = true;
    try {
      if (handle !== null) handle.skip();
      else {
        applyFinalFrame();
        finishHandoff();
      }
    } catch {
      try {
        applyFinalFrame();
      } catch {
        /* nothing left to remove */
      }
      finishHandoff();
    }
    // If the score was not there to run its cues, the final frame still has to land.
    window.setTimeout(() => {
      if (!handoffStarted) {
        applyFinalFrame();
        finishHandoff();
      }
    }, 120);
  };

  const onPointer = (event: Event): void => {
    if (isStageControl(event)) return;
    requestSkip();
  };

  const onKey = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key === "Escape") {
      requestSkip();
      return;
    }
    // Enter/Space on the Skip or sound button belong to that button, not to the film.
    if (isStageControl(event)) return;
    if (
      event.key === "Tab" ||
      event.key === "Shift" ||
      event.key === "Control" ||
      event.key === "Alt" ||
      event.key === "Meta"
    ) {
      return;
    }
    requestSkip();
  };

  let guard = 0;

  try {
    await untilFonts(performance.now() + FONT_WAIT_MS);
    if (disposed) return "skipped";

    screen = buildScreen(host);
    const stage = screen;
    foley = createFoley(FOLEY_SCORE);

    handle = buildTimeline(stage, {
      prepareHandoff,
      runHandoff,
      onFinish: () => {
        if (skipped) {
          applyFinalFrame();
          finishHandoff();
          return;
        }
        // The handoff has its own promise; this is the safety net for a browser that never
        // fired the View Transition's `ready`.
        if (!handoffStarted) runHandoff();
        settle("done");
      },
      cue: (name) => {
        foley?.hit(name);
      },
    });

    listen(document, "pointerdown", onPointer, { capture: true, passive: true });
    listen(document, "keydown", onKey, { capture: true });
    listen(window, "wheel", onPointer, { passive: true });
    listen(window, "touchstart", onPointer, { passive: true });
    listen(document, "scroll", onPointer, { capture: true, passive: true });
    listen(stage.refs.skip, "click", requestSkip);
    listen(stage.refs.sound, "click", (event) => {
      event.stopPropagation();
      if (foley === null) return;
      const on = foley.toggle(handle?.timeline.time() ?? 0);
      stage.setSound(on);
    });

    void data.then((payload) => {
      window.clearTimeout(dataTimer);
      if (disposed || screen !== stage) return;
      try {
        stage.attach(payload);
      } catch {
        /* a broken artifact is a film without dots, not a broken film */
      }
    });

    guard = window.setTimeout(
      () => {
        applyFinalFrame();
        finishHandoff();
      },
      (TOTAL_SECONDS + 2.5) * 1000,
    );

    opts.onStart?.();
    handle.play();
    await finished;
  } catch {
    try {
      applyFinalFrame();
    } catch {
      /* nothing left to remove */
    }
    settle("skipped");
  } finally {
    disposed = true;
    window.clearTimeout(dataTimer);
    window.clearTimeout(guard);
    abort.abort();
    for (const removeListener of listeners.splice(0)) {
      try {
        removeListener();
      } catch {
        /* the target went away */
      }
    }
    try {
      handle?.destroy();
    } catch {
      /* already dead */
    }
    handle = null;
    try {
      screen?.destroy();
    } catch {
      /* already dead */
    }
    screen = null;
    try {
      foley?.destroy();
    } catch {
      /* already closed */
    }
    foley = null;
    if (handoffTimer) window.clearTimeout(handoffTimer);
    // A transition in flight owns its own names and underlay; removing them before its new
    // snapshot would abort the swap, so it finishes the job itself.
    if (!handoffAnimating) cleanupHandoff();
  }

  // The closure above is the only writer of `result`; TypeScript cannot see through it.
  const outcome = (result as PlayResult | null) ?? "skipped";
  const input = pageInput;
  if (input !== null) {
    if (outcome === "done" || document.activeElement === document.body) {
      focusWhenReachable(input);
    }
  }
  return outcome;
}
