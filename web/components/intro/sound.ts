/**
 * sound.ts — the film's three foleys, synthesised, and the switch that lets them in.
 *
 * There are no audio files and no requests: a low room hum under the dark beat, a band-passed
 * noise whir riding the light bar through the scan, and a light-switch click when the room
 * comes on. All three are Web Audio graphs built on the spot from two oscillators and a second
 * of generated noise.
 *
 * **Sound is off until the visitor asks for it.** The `AudioContext` is not created at module
 * load or at any point in the film's start-up — only inside `toggle()`, which is called from a
 * click on the speaker button. That means the graph is always built inside a user gesture, so
 * no browser autoplay policy can refuse it, and a visitor who never touches the button has no
 * audio graph at all. Enabling sound mid-film is one case that must not arrive late: `toggle`
 * takes the timeline's current time and schedules whatever of the score is still ahead, so the
 * hum starts under the visitor's click rather than at 0.0 where it would have been.
 *
 * Every Web Audio call is wrapped: a browser without Web Audio, a refused context, or a
 * suspended one must degrade to "the switch did nothing", never to a film that traps the page.
 */

import { scanEase } from "./layout";

export type FoleyCue = "hum" | "whir" | "click";

/** Where the film's three foleys sit on its clock, in seconds. */
export interface FoleyScore {
  readonly humStart: number;
  readonly humEnd: number;
  readonly whirStart: number;
  readonly whirEnd: number;
  readonly clickAt: number;
}

export interface Foley {
  readonly enabled: boolean;
  readonly available: boolean;
  /** Toggle sound. `now` is the film's clock, so a mid-film enable can catch up. */
  toggle(now: number): boolean;
  /** Play a cue the timeline reached while sound was on. */
  hit(cue: FoleyCue): void;
  /** Fade everything out now: a skip, the end of the film, or a teardown. */
  silence(): void;
  destroy(): void;
}

/** How loud the whole film is when the visitor has asked for it. Quiet on purpose. */
const MASTER = 0.8;
const HUM_GAIN = 0.035;
const WHIR_GAIN = 0.045;
const CLICK_GAIN = 0.11;

/** Fades, in seconds. */
const FADE_IN = 0.6;
const FADE_OUT = 0.35;
const SILENCE_FADE = 0.06;

/** The scan's whir, as a band-pass sweep from the low end to the high end. */
const WHIR_LOW_HZ = 420;
const WHIR_HIGH_HZ = 1500;

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * Build the film's foley rig. Nothing is created until `toggle()` runs inside a click, so this
 * function is safe to call during film start-up.
 */
export function createFoley(score: FoleyScore): Foley {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let enabled = false;
  let available = true;
  let destroyed = false;

  let hum: { stop: () => void; gain: GainNode } | null = null;
  let whir: { stop: () => void } | null = null;

  function makeNoise(ctx: AudioContext): AudioBuffer {
    const frames = Math.floor(ctx.sampleRate * 0.5);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < frames; index += 1) {
      channel[index] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  function ready(): { ctx: AudioContext; out: GainNode } | null {
    if (destroyed || context === null || master === null) return null;
    return { ctx: context, out: master };
  }

  // ---- the three foleys ----------------------------------------------------

  function startHum(at: number, fade: number): void {
    const rig = ready();
    if (rig === null || hum !== null) return;
    try {
      const { ctx, out } = rig;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(HUM_GAIN, at + fade);

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 220;
      filter.Q.value = 0.4;

      // Two sines a hair apart: the slow beat between them is what makes a room sound sized.
      const low = ctx.createOscillator();
      low.type = "sine";
      low.frequency.value = 54;
      const high = ctx.createOscillator();
      high.type = "sine";
      high.frequency.value = 109.6;

      low.connect(filter);
      high.connect(filter);
      filter.connect(gain);
      gain.connect(out);
      low.start(at);
      high.start(at);

      hum = {
        gain,
        stop: (): void => {
          try {
            gain.gain.cancelScheduledValues(ctx.currentTime);
            gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
            low.stop(ctx.currentTime + 0.36);
            high.stop(ctx.currentTime + 0.36);
          } catch {
            /* already stopped */
          }
        },
      };
    } catch {
      hum = null;
    }
  }

  function startWhir(at: number, duration: number): void {
    const rig = ready();
    if (rig === null || whir !== null || noise === null || duration <= 0.02) return;
    try {
      const { ctx, out } = rig;
      const source = ctx.createBufferSource();
      source.buffer = noise;
      source.loop = true;

      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.Q.value = 1.6;
      // The bar is fast–slow–fast, and the noise's centre follows it, so the ear hears the
      // carriage move rather than a held hiss.
      const steps = 32;
      const curve = new Float32Array(steps);
      for (let step = 0; step < steps; step += 1) {
        const position = scanEase(step / (steps - 1));
        curve[step] = WHIR_LOW_HZ + (WHIR_HIGH_HZ - WHIR_LOW_HZ) * position;
      }
      band.frequency.setValueCurveAtTime(curve, at, duration);

      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(WHIR_GAIN, at + 0.14);
      gain.gain.setValueAtTime(WHIR_GAIN, at + Math.max(0.16, duration - 0.22));
      gain.gain.linearRampToValueAtTime(0, at + duration);

      // A slight 11 Hz wobble: the carriage is a mechanism, not a tone.
      const wobble = ctx.createOscillator();
      wobble.type = "sine";
      wobble.frequency.value = 11;
      const wobbleDepth = ctx.createGain();
      wobbleDepth.gain.value = WHIR_GAIN * 0.35;
      wobble.connect(wobbleDepth);
      wobbleDepth.connect(gain.gain);

      source.connect(band);
      band.connect(gain);
      gain.connect(out);
      source.start(at);
      wobble.start(at);
      source.stop(at + duration + 0.02);
      wobble.stop(at + duration + 0.02);

      const node = source;
      whir = {
        stop: (): void => {
          try {
            gain.gain.cancelScheduledValues(ctx.currentTime);
            gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.08);
            node.stop(ctx.currentTime + 0.1);
          } catch {
            /* already stopped */
          }
        },
      };
      source.onended = (): void => {
        if (whir !== null && "stop" in whir) whir = null;
      };
    } catch {
      whir = null;
    }
  }

  function click(at: number): void {
    const rig = ready();
    if (rig === null) return;
    try {
      const { ctx, out } = rig;
      if (noise !== null) {
        const source = ctx.createBufferSource();
        source.buffer = noise;
        const high = ctx.createBiquadFilter();
        high.type = "highpass";
        high.frequency.value = 1800;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(CLICK_GAIN, at);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.03);
        source.connect(high);
        high.connect(gain);
        gain.connect(out);
        source.start(at);
        source.stop(at + 0.04);
      }
      // The body under the switch: a short low thump, so the click has weight.
      const thump = ctx.createOscillator();
      thump.type = "sine";
      thump.frequency.setValueAtTime(150, at);
      thump.frequency.exponentialRampToValueAtTime(70, at + 0.06);
      const body = ctx.createGain();
      body.gain.setValueAtTime(CLICK_GAIN * 0.6, at);
      body.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
      thump.connect(body);
      body.connect(out);
      thump.start(at);
      thump.stop(at + 0.08);
    } catch {
      /* the click is optional */
    }
  }

  // ---- the switch ----------------------------------------------------------

  function stopSources(): void {
    hum?.stop();
    hum = null;
    whir?.stop();
    whir = null;
  }

  function catchUp(now: number): void {
    const rig = ready();
    if (rig === null) return;
    const at = rig.ctx.currentTime + 0.02;
    if (now < score.humEnd) {
      startHum(at, Math.min(FADE_IN, Math.max(0.15, score.humEnd - now)));
    }
    if (now < score.whirEnd && now > score.whirStart - 0.1) {
      const begin = Math.max(now, score.whirStart);
      const remaining = score.whirEnd - begin;
      if (remaining > 0.1) startWhir(at + (begin - now), remaining);
    }
    if (now < score.clickAt) {
      click(rig.ctx.currentTime + (score.clickAt - now));
    }
  }

  function toggle(now: number): boolean {
    if (destroyed) return false;
    if (!enabled) {
      if (context === null) {
        const Constructor = audioContextConstructor();
        if (Constructor === null) {
          available = false;
          return false;
        }
        try {
          context = new Constructor();
          master = context.createGain();
          master.gain.value = 0;
          master.connect(context.destination);
          noise = makeNoise(context);
        } catch {
          context = null;
          master = null;
          available = false;
          return false;
        }
      }
      const rig = ready();
      if (rig === null) return false;
      enabled = true;
      try {
        void rig.ctx.resume();
        rig.out.gain.cancelScheduledValues(rig.ctx.currentTime);
        rig.out.gain.setValueAtTime(rig.out.gain.value, rig.ctx.currentTime);
        rig.out.gain.linearRampToValueAtTime(MASTER, rig.ctx.currentTime + 0.12);
      } catch {
        /* ramps are best effort */
      }
      catchUp(now);
      return true;
    }

    enabled = false;
    const rig = ready();
    if (rig !== null) {
      try {
        rig.out.gain.cancelScheduledValues(rig.ctx.currentTime);
        rig.out.gain.setValueAtTime(rig.out.gain.value, rig.ctx.currentTime);
        rig.out.gain.linearRampToValueAtTime(0, rig.ctx.currentTime + SILENCE_FADE);
      } catch {
        /* best effort */
      }
    }
    stopSources();
    return false;
  }

  return {
    get enabled(): boolean {
      return enabled;
    },
    get available(): boolean {
      return available;
    },
    toggle,
    hit(cue: FoleyCue): void {
      const rig = ready();
      if (!enabled || rig === null) return;
      const at = rig.ctx.currentTime + 0.02;
      try {
        if (cue === "hum") startHum(at, FADE_IN);
        else if (cue === "whir")
          startWhir(at, Math.max(0.2, score.whirEnd - score.whirStart));
        else click(at);
      } catch {
        /* a cue that fails is a cue that is not heard */
      }
    },
    silence(): void {
      const rig = ready();
      if (rig !== null) {
        try {
          rig.out.gain.cancelScheduledValues(rig.ctx.currentTime);
          rig.out.gain.setValueAtTime(rig.out.gain.value, rig.ctx.currentTime);
          rig.out.gain.linearRampToValueAtTime(0, rig.ctx.currentTime + FADE_OUT);
        } catch {
          /* best effort */
        }
      }
      stopSources();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      enabled = false;
      stopSources();
      const ctx = context;
      context = null;
      master = null;
      noise = null;
      if (ctx !== null) {
        try {
          void ctx.close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}
