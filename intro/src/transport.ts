/**
 * Review furniture: a scrub bar, a playhead and a live timing readout.
 *
 * This is not part of the product. It exists so the six beats can be judged by
 * dragging rather than by watching, and so the numbers in the brief can be
 * checked against the numbers the timeline actually produces — the overlap
 * column is measured from the tweens, not from the plan.
 */

import { gsap } from "gsap";

import { overlapHealth, STORY, TOTAL, type BeatWindow, type TimelineHandle } from "./timeline";
import { dur, secs } from "./util";

export type TransportOptions = {
  dotCount: number;
  /** "full" | "lite" | "static" — which tier this visit would have taken. */
  tier: string;
  reduced: boolean;
  onReplay: () => void;
};

export type Transport = {
  sync: (time: number, playing: boolean) => void;
  setPlaying: (playing: boolean) => void;
  destroy: () => void;
};

const SPEEDS = [0.25, 0.5, 1] as const;

export function createTransport(
  host: HTMLElement,
  handle: TimelineHandle,
  options: TransportOptions,
): Transport {
  const { tl, windows } = handle;
  host.innerHTML = "";
  host.classList.add("transport--live");

  const health = overlapHealth(windows);

  const bar = document.createElement("div");
  bar.className = "transport__bar";
  host.appendChild(bar);

  const play = button("play", "Pause", "Pause or play the animatic (space)");
  const restart = button("restart", "Restart", "Play from the first frame (R)");
  const replay = button("replay", "Replay as a visitor", "Clear the first-visit flag and run again (U)");
  const speed = button("speed", "1×", "Playback speed");
  const theme = button("theme", "Dark", "Switch theme");

  const time = document.createElement("span");
  time.className = "transport__time";

  const beatName = document.createElement("span");
  beatName.className = "transport__beat";

  const meta = document.createElement("span");
  meta.className = "transport__meta";
  meta.textContent = `${options.dotCount} dots · ${options.tier} tier${options.reduced ? " · reduced motion" : ""}`;

  const hint = document.createElement("span");
  hint.className = "transport__hint";
  hint.textContent = "space play · ←/→ step · R restart · U replay";

  bar.append(
    group([play, restart]),
    group([speed]),
    time,
    beatName,
    spacer(),
    meta,
    group([theme, replay]),
  );

  const track = document.createElement("div");
  track.className = "transport__track";
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", "Timeline position");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", String(TOTAL));
  track.tabIndex = 0;

  const segments = document.createElement("div");
  segments.className = "transport__segments";
  STORY.forEach((beat) => {
    const segment = document.createElement("div");
    segment.className = "transport__segment";
    segment.style.flexGrow = String(beat.end - beat.start);
    segment.dataset.beat = beat.id;
    const label = document.createElement("span");
    label.textContent = beat.label;
    segment.appendChild(label);
    segments.appendChild(segment);
  });
  track.appendChild(segments);

  const playhead = document.createElement("div");
  playhead.className = "transport__playhead";
  track.appendChild(playhead);

  const fill = document.createElement("div");
  fill.className = "transport__fill";
  track.appendChild(fill);

  host.appendChild(track);

  // The readout: what the brief asked for beside what the timeline does.
  const table = document.createElement("table");
  table.className = "transport__table";
  table.innerHTML = `
    <thead>
      <tr>
        <th scope="col">beat</th>
        <th scope="col">brief</th>
        <th scope="col">content</th>
        <th scope="col">overlap</th>
        <th scope="col">length</th>
      </tr>
    </thead>
    <tbody></tbody>`;
  const body = table.querySelector("tbody")!;
  const rows = new Map<string, HTMLElement>();
  windows.forEach((window, index) => {
    const row = document.createElement("tr");
    row.dataset.beat = window.id;
    row.innerHTML = `
      <th scope="row">${window.label}</th>
      <td>${secs(window.storyStart)}–${secs(window.storyEnd)}</td>
      <td>${secs(window.contentStart)}–${secs(window.contentEnd)}</td>
      <td></td>
      <td>${dur(window.contentEnd - window.contentStart)}</td>`;
    const overlapCell = row.children[3] as HTMLElement;
    if (index === 0) {
      overlapCell.textContent = "—";
    } else {
      const overlap = window.overlap;
      const ok = overlap >= 0.15 && overlap <= 0.25;
      overlapCell.textContent = `${Math.round(overlap * 1000)} ms`;
      overlapCell.className = ok ? "is-ok" : "is-bad";
      overlapCell.title = ok ? "inside the brief's 150–250 ms" : "outside the brief";
    }
    body.appendChild(row);
    rows.set(window.id, row);
  });

  const summary = document.createElement("p");
  summary.className = "transport__summary";
  const measured = windows.map((w: BeatWindow) => w.overlap).slice(1);
  summary.innerHTML = health.ok
    ? `overlaps ${measured.map((value) => `${Math.round(value * 1000)}`).join(" / ")} ms — inside the brief's 150–250 ms`
    : `<strong>overlaps ${measured.map((value) => `${Math.round(value * 1000)}`).join(" / ")} ms — OUTSIDE the brief's 150–250 ms</strong>`;

  const foot = document.createElement("div");
  foot.className = "transport__foot";
  foot.append(table, summary, hint);
  host.appendChild(foot);

  // ---- behaviour
  let speedIndex = SPEEDS.length - 1;
  let dragging = false;

  const setPlaying = (playing: boolean): void => {
    play.textContent = playing ? "Pause" : "Play";
    host.classList.toggle("is-playing", playing);
  };

  play.addEventListener("click", () => {
    if (tl.progress() >= 1) tl.restart();
    else if (tl.paused()) tl.play();
    else tl.pause();
    setPlaying(!tl.paused());
  });
  restart.addEventListener("click", () => {
    tl.restart();
    setPlaying(true);
  });
  replay.addEventListener("click", () => options.onReplay());
  speed.addEventListener("click", () => {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    const value = SPEEDS[speedIndex]!;
    tl.timeScale(value);
    speed.textContent = `${value}×`;
  });
  theme.addEventListener("click", () => {
    const root = document.documentElement;
    const current = root.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    theme.textContent = next === "dark" ? "Light" : "Dark";
  });
  theme.textContent = document.documentElement.dataset.theme === "dark" ? "Light" : "Dark";

  const seekFromEvent = (event: PointerEvent): void => {
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    tl.pause();
    tl.time(ratio * TOTAL);
    setPlaying(false);
    sync(tl.time(), false);
  };

  track.addEventListener("pointerdown", (event) => {
    dragging = true;
    track.setPointerCapture(event.pointerId);
    seekFromEvent(event);
  });
  track.addEventListener("pointermove", (event) => {
    if (dragging) seekFromEvent(event);
  });
  track.addEventListener("pointerup", (event) => {
    dragging = false;
    track.releasePointerCapture(event.pointerId);
  });
  track.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 0.1 : 1 / 60;
    if (event.key === "ArrowRight") {
      tl.pause();
      tl.time(Math.min(TOTAL, tl.time() + step));
      setPlaying(false);
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === "ArrowLeft") {
      tl.pause();
      tl.time(Math.max(0, tl.time() - step));
      setPlaying(false);
      event.preventDefault();
      event.stopPropagation();
    }
  });

  // One ticker for the whole readout, so the numbers cannot drift from the
  // timeline's own clock.
  const tick = (): void => sync(tl.time(), !tl.paused());
  gsap.ticker.add(tick);

  function sync(current: number, playing: boolean): void {
    const ratio = Math.min(1, Math.max(0, current / TOTAL));
    playhead.style.left = `${ratio * 100}%`;
    fill.style.width = `${ratio * 100}%`;
    track.setAttribute("aria-valuenow", current.toFixed(2));
    time.textContent = `${secs(current)} / ${secs(TOTAL)}`;

    const active = STORY.find((beat) => current >= beat.start && current < beat.end) ?? STORY[STORY.length - 1]!;
    beatName.textContent = active.label;
    rows.forEach((row, id) => row.classList.toggle("is-current", id === active.id));

    if (playing !== !tl.paused()) setPlaying(!tl.paused());
    if (host.classList.contains("is-playing") !== playing) setPlaying(playing);
  }

  sync(tl.time(), !tl.paused());

  return {
    sync,
    setPlaying,
    destroy: () => {
      gsap.ticker.remove(tick);
      host.innerHTML = "";
      host.classList.remove("transport--live");
    },
  };
}

function button(kind: string, label: string, title: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `transport__btn transport__btn--${kind}`;
  element.textContent = label;
  element.title = title;
  element.setAttribute("aria-label", title);
  return element;
}

function group(children: HTMLElement[]): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = "transport__group";
  element.append(...children);
  return element;
}

function spacer(): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = "transport__spacer";
  return element;
}
