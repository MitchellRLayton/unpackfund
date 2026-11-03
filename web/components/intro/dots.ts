/**
 * dots.ts — the X-Ray's dot field: one InstancedArray of points, one draw call.
 *
 * The bake writes one record per company (7 x float32: weight, the dot in word A,
 * the dot in word B — NaN when the company is not in the second fund — and the dot
 * on the final rule). Everything else happens on the GPU: the CPU uploads the
 * records once and then only pushes uniforms. No buffer rewrite per frame, no
 * timers, no rAF — `render()` is the only side effect, and the film's ticker
 * decides when it happens.
 *
 * Geometry
 * --------
 * The boxes `setBoxes` hands us are camera-local CSS pixels: the canvas sits inside
 * the film's camera wrapper, so a CSS transform on that wrapper moves the DOM
 * letters and this canvas together. We therefore do **no** camera geometry of our
 * own — `setCamera` is optics only (sprite size, core bloom, focal defocus). Any
 * positional push here would drift the dots off the letters during the pull-back.
 *
 * An em position is mapped into its box with the font's own metrics:
 *
 *   x = box.left + (emX / advance) * box.width
 *   y = box.top + ((emY + ascender) / (ascender + descender)) * box.height
 *
 * i.e. the em box [-ascender, +descender] on a y-down baseline origin lands on the
 * box exactly, and x fills [0, advance] to the box width. The y term carries the
 * `+ ascender` offset so the em extent maps onto the box extent the same way x
 * does; the literal formula without it would place the whole word a full ascender
 * above its box. Ascender/descender are read as magnitudes, so either sign works.
 *
 * The rule shares word A's em frame ("em units of the ticker line, same origin"),
 * so it is mapped through A's box.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FieldData {
  count: number;
  /** Float32Array of 7 * count: [w, ax, ay, bx, by, rx, ry], y down, em units. */
  raw: Float32Array;
}

export interface DotsField {
  readonly lite: boolean;
  /** 0..1, dots in word A appear left-to-right behind the light's bar. */
  setScan(p: number): void;
  /** 0..1, B's dots lift out of A and fly to B's letter positions. */
  setTwice(p: number): void;
  /** 0..1, everything collapses onto the rule. */
  setCollapse(p: number): void;
  /** 0..1, optics only: size, core bloom and focal defocus. */
  setCamera(z: number): void;
  /** 0..1, glow strength. */
  setGlow(g: number): void;
  /** Font metrics of the ticker line, in em units (same type size for both words). */
  setMetrics(advance: number, ascender: number, descender: number): void;
  /** Length of the twice beat in ms, so the 60 ms impact squash stays 60 ms. */
  setTwiceBeat(ms: number): void;
  /** Screen-space boxes of the two words, in camera-local CSS pixels. */
  setBoxes(a: Box, b: Box): void;
  resize(): void;
  render(): void;
  destroy(): void;
}

type Rgba = readonly [number, number, number, number];

/** Floats per dot in the caller's array. */
const FLOATS_PER_DOT = 7;
/** Floats per dot in our own interleaved instance buffer (we add a validity flag). */
const FLOATS_PER_INSTANCE = 8;
/** Lite tier: fewer dots, and no focal blur at all. */
export const LITE_DOTS = 1200;
/** Portrait viewports draw at most this many dots. */
export const PORTRAIT_DOT_CAP = 2000;
/** How many frame times decideLite() needs before it will say lite. */
export const LITE_FRAME_SAMPLES = 30;
/** Worse than this average frame rate switches the field to the lite tier. */
export const LITE_MIN_FPS = 50;
/** A single frame longer than this is a stall (tab hidden, GC), not a frame time. */
const MAX_FRAME_SAMPLE_MS = 250;
/** Used until the film tells us its real twice beat via setTwiceBeat(). */
export const DEFAULT_TWICE_BEAT_MS = 900;
/** The last 60 ms of each dot's flight is squashed, however long the beat is. */
export const SQUASH_MS = 60;
/** Shortest beat we will divide by, so a stray 0 or negative cannot explode the window. */
const MIN_TWICE_BEAT_MS = 120;
/** Largest start delay of the twice stagger (largest weight flies first). */
const TWICE_STAGGER = 0.34;
/** Largest start delay of the collapse stagger (left of the rule lands first). */
const COLLAPSE_STAGGER = 0.3;
/** Cap on the device pixel ratio we render at. */
const MAX_DPR = 2;

const FALLBACK_TABLE = "oklch(14% 0.02 255)";
const FALLBACK_LIGHT = "oklch(97% 0.01 230)";
const FALLBACK_DOT = "oklch(82% 0.02 240 / 0.75)";
const FALLBACK_TWICE = "oklch(74% 0.13 35)";

/* ------------------------------------------------------------------ */
/* Pure helpers — the parts the unit tests can reach without a GPU.    */
/* ------------------------------------------------------------------ */

/**
 * True when the record carries a real position in the second fund. The bake writes
 * NaN, NaN for a company that is not in B, and a dot must not be flown to a
 * position that does not exist.
 */
export function hasSecond(raw: Float32Array, index: number): boolean {
  if (index < 0) return false;
  if ((index + 1) * FLOATS_PER_DOT > raw.length) return false;
  const bx = raw[index * FLOATS_PER_DOT + 3];
  const by = raw[index * FLOATS_PER_DOT + 4];
  return (
    typeof bx === "number" &&
    typeof by === "number" &&
    !Number.isNaN(bx) &&
    !Number.isNaN(by)
  );
}

/**
 * The lite-tier decision. A four-core-or-smaller machine never gets the full tier;
 * otherwise the first 30 measured frames decide, and a short sample is not evidence.
 */
export function decideLite(
  hardwareConcurrency: number,
  frameMs: readonly number[],
): boolean {
  if (
    Number.isFinite(hardwareConcurrency) &&
    hardwareConcurrency > 0 &&
    hardwareConcurrency <= 4
  ) {
    return true;
  }
  if (frameMs.length < LITE_FRAME_SAMPLES) return false;
  let total = 0;
  for (let i = 0; i < frameMs.length; i += 1) {
    const dt = frameMs[i];
    total += typeof dt === "number" && dt > 0 ? dt : 0;
  }
  const average = total / frameMs.length;
  return average > 1000 / LITE_MIN_FPS;
}

/**
 * The impact squash window, as a fraction of the twice beat: 60 ms of a 2000 ms beat
 * is 0.03, of a 900 ms beat 0.0667. The film passes its real beat length, so the
 * squash stays 60 ms of wall clock however the timeline is retimed.
 */
export function squashWindow(beatMs: number): number {
  // A missing or nonsensical beat falls back to the default; a very short one is
  // floored so the squash can never swallow more than half a flight.
  const beat =
    Number.isFinite(beatMs) && beatMs > 0
      ? Math.max(beatMs, MIN_TWICE_BEAT_MS)
      : DEFAULT_TWICE_BEAT_MS;
  return Math.min(SQUASH_MS / beat, 1);
}

/** How many of the (weight-sorted) records to draw this frame. */
export function dotBudget(count: number, lite: boolean, portrait: boolean): number {
  let n = Number.isFinite(count) ? Math.floor(count) : 0;
  if (n < 0) n = 0;
  if (portrait) n = Math.min(n, PORTRAIT_DOT_CAP);
  if (lite) n = Math.min(n, LITE_DOTS);
  return n;
}

/**
 * Smallest sprite in CSS px, and the ramp's other end. The shader is generated from
 * these numbers, so it cannot drift from dotPointSize().
 */
const MIN_POINT_PX = 1.9;
const MAX_POINT_PX = 9;
const SIZE_EXPONENT = 0.65;

/**
 * Weight floor for the sprite size. The bake writes w = 0 for any company whose
 * weight rounds to zero basis points — 2,179 of VTI's 3,446 rows — so a linear ramp
 * would leave two-thirds of the letters empty and the film's central image hollow.
 * A zero-weight dot therefore draws at the size of a w = 0.12 dot: small, but present.
 */
export const MIN_DOT_WEIGHT = 0.12;

/**
 * Sprite diameter in CSS px, before device pixel ratio, camera push and squash.
 * Applies MIN_DOT_WEIGHT, so an unweighted company still gets a visible dot.
 */
export function dotPointSize(weight: number): number {
  const w = Math.max(clamp01(finite(weight, 0)), MIN_DOT_WEIGHT);
  return MIN_POINT_PX + (MAX_POINT_PX - MIN_POINT_PX) * Math.pow(w, SIZE_EXPONENT);
}

/* ------------------------------------------------------------------ */
/* Colour: OKLCH / hex / rgb to premultiplied-ready sRGB + alpha.      */
/* ------------------------------------------------------------------ */

function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

function encodeSrgb(value: number): number {
  const c = clamp01(value);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** OKLCH -> sRGB (the same matrices the browser uses, D65, no clipping surprises). */
function oklchToRgba(
  lightness: number,
  chroma: number,
  hue: number,
  alpha: number,
): Rgba {
  const h = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(h);
  const b = chroma * Math.sin(h);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime * lPrime * lPrime;
  const m = mPrime * mPrime * mPrime;
  const s = sPrime * sPrime * sPrime;
  return [
    encodeSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encodeSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encodeSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    clamp01(alpha),
  ];
}

function numbersIn(text: string): number[] {
  const out: number[] = [];
  const pattern = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?%?/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const token = match[0];
    const percent = token.endsWith("%");
    const value = Number.parseFloat(percent ? token.slice(0, -1) : token);
    if (Number.isFinite(value)) out.push(percent ? value / 100 : value);
    match = pattern.exec(text);
  }
  return out;
}

function fromHex(text: string): Rgba | null {
  const body = text.slice(1);
  const pairs =
    body.length === 3 || body.length === 4
      ? body.split("").map((c) => Number.parseInt(c + c, 16))
      : body.length === 6 || body.length === 8
        ? (body.match(/.{2}/g) ?? []).map((c) => Number.parseInt(c, 16))
        : [];
  if (pairs.length !== 3 && pairs.length !== 4) return null;
  if (pairs.some((v) => !Number.isFinite(v))) return null;
  const [r = 0, g = 0, b = 0, a = 255] = pairs;
  return [r / 255, g / 255, b / 255, a / 255];
}

/**
 * Parse one CSS colour token. Only the syntax the intro tokens use is supported —
 * oklch(), hex and rgb()/rgba() — and anything else yields null so the caller can
 * fall back. No canvas, no DOM, so this is testable and available before paint.
 */
function fromCss(value: string | null | undefined): Rgba | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text.length === 0) return null;
  if (text.startsWith("#")) return fromHex(text);
  const open = text.indexOf("(");
  if (open < 0 || !text.endsWith(")")) return null;
  const fn = text.slice(0, open).trim();
  const body = text.slice(open + 1, -1);
  const parts = body.split("/");
  const main = numbersIn(parts[0] ?? "");
  const alpha = parts.length > 1 ? (numbersIn(parts[1] ?? "")[0] ?? 1) : 1;
  if (main.length < 3) return null;
  const [first = 0, second = 0, third = 0, fourth] = main;
  if (fn === "oklch") {
    return oklchToRgba(clamp01(first), Math.max(0, second), third, clamp01(alpha));
  }
  if (fn === "rgb" || fn === "rgba") {
    const scale = (v: number): number => clamp01(Math.abs(v) > 1 ? v / 255 : v);
    return [scale(first), scale(second), scale(third), clamp01(fourth ?? alpha)];
  }
  return null;
}

function parseColor(value: string | null | undefined, fallback: string): Rgba {
  return fromCss(value) ?? fromCss(fallback) ?? [1, 1, 1, 1];
}

function readTokens(): { dot: Rgba; twice: Rgba; light: Rgba; table: Rgba } {
  let css: CSSStyleDeclaration | null = null;
  try {
    if (typeof document !== "undefined" && document.documentElement) {
      css = getComputedStyle(document.documentElement);
    }
  } catch {
    css = null;
  }
  const read = (name: string, fallback: string): Rgba => {
    let raw: string | null = null;
    try {
      raw = css ? css.getPropertyValue(name) : null;
    } catch {
      raw = null;
    }
    return parseColor(raw, fallback);
  };
  return {
    table: read("--intro-table", FALLBACK_TABLE),
    light: read("--intro-light", FALLBACK_LIGHT),
    dot: read("--intro-dot", FALLBACK_DOT),
    twice: read("--intro-twice", FALLBACK_TWICE),
  };
}

/* ------------------------------------------------------------------ */
/* Shaders.                                                            */
/* ------------------------------------------------------------------ */

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in float aWeight;
layout(location = 1) in vec2 aA;
layout(location = 2) in vec2 aB;
layout(location = 3) in vec2 aRule;
layout(location = 4) in float aHasB;

uniform vec4 uBoxA;        // left, top, width, height  (camera-local CSS px)
uniform vec4 uBoxB;
uniform float uAdvance;    // em units of the ticker line
uniform float uAscender;
uniform float uDescender;
uniform vec2 uView;        // canvas size, CSS px
uniform float uDpr;
uniform float uScan;
uniform float uTwice;
uniform float uCollapse;
uniform float uCamera;
uniform float uGlow;
uniform float uBlur;       // 0 = lite (no focal blur), 1 = full tier
uniform float uSquashWindow; // 60 ms as a fraction of the twice beat
uniform vec4 uDot;
uniform vec4 uTwiceColor;

out vec4 vColor;
out float vAlpha;
out float vBlur;
out float vCore;
out float vHeat;
out float vSquash;

const float PI = 3.14159265;

// Em position -> CSS px inside the word's own box. The em box
// [-ascender, +descender] on a y-down baseline origin fills the box vertically.
vec2 place(vec2 em, vec4 box) {
  float x = box.x + (em.x / max(uAdvance, 1e-4)) * box.z;
  float y = box.y + ((em.y + uAscender) / max(uAscender + uDescender, 1e-4)) * box.w;
  return vec2(x, y);
}

void main() {
  float w = clamp(aWeight, 0.0, 1.0);
  vec2 posA = place(aA, uBoxA);
  vec2 onRule = place(aRule, uBoxA);   // the rule shares word A's em frame
  vec2 pos = posA;
  float flight = 0.0;
  float squash = 0.0;

  // --- twice: lift out of A, fly to B, largest weight first ------------
  if (aHasB > 0.5) {
    float delay = (1.0 - w) * ${TWICE_STAGGER.toFixed(4)};
    flight = clamp((uTwice - delay) / max(1.0 - delay, 1e-3), 0.0, 1.0);
    float e = flight * flight * (3.0 - 2.0 * flight);
    pos = mix(posA, place(aB, uBoxB), e);
    pos.y -= sin(PI * e) * uBoxA.z * 0.075 * (0.45 + 0.55 * w);
    // The last 60 ms of the flight is squashed, then released on landing. A dot that
    // started late has a proportionally shorter flight, so divide the beat-wide window
    // by its own flight span to keep the squash 60 ms of wall clock for every dot.
    float q = clamp(uSquashWindow / max(1.0 - delay, 1e-3), 0.0, 1.0);
    if (flight > 1.0 - q && flight < 1.0) {
      squash = sin(PI * (flight - (1.0 - q)) / q);
    }
  }

  // --- collapse: fall onto the rule, left to right ---------------------
  float nx = clamp(aRule.x / max(uAdvance, 1e-4), 0.0, 1.0);
  float delayC = nx * ${COLLAPSE_STAGGER.toFixed(4)};
  float collapse = clamp((uCollapse - delayC) / max(1.0 - delayC, 1e-3), 0.0, 1.0);
  collapse = collapse * collapse * (3.0 - 2.0 * collapse);
  pos = mix(pos, onRule, collapse);

  // --- scan gate: a dot never shows ahead of the light -----------------
  // The bar is the light's leading edge, derived from p alone so no extra state
  // is needed. Both the dot's word position and its drawn position must be behind
  // it, and the gate retires as soon as the dot leaves word A.
  float barX = uBoxA.x + uScan * uBoxA.z;
  float gate = step(posA.x, barX) * step(pos.x, barX);
  float inWord = 1.0 - clamp(max(uTwice, uCollapse), 0.0, 1.0);
  gate = mix(1.0, gate, inWord);
  float behind = clamp((barX - pos.x) / (14.0 * uDpr), 0.0, 1.0);
  float heat = gate * exp(-behind * 3.5) * inWord;

  // --- optics: camera push is size, core and defocus, never geometry ----
  vec2 uv = (pos - uView * 0.5) / max(uView, vec2(1.0));
  float depth = clamp(length(uv) * 2.0 * (0.25 + 1.05 * uCamera) * (1.0 - 0.45 * collapse), 0.0, 1.0);

  vec2 clip = (pos / max(uView, vec2(1.0))) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);

  float bMix = aHasB * flight;
  vColor = mix(uDot, uTwiceColor, bMix);

  // A zero-weight dot still draws: most of VTI's rows are w = 0 (see MIN_DOT_WEIGHT).
  float wSize = max(w, ${MIN_DOT_WEIGHT.toFixed(4)});
  float size = mix(${MIN_POINT_PX.toFixed(2)}, ${MAX_POINT_PX.toFixed(2)}, pow(wSize, ${SIZE_EXPONENT.toFixed(2)}));
  size *= uDpr * (1.0 + 0.42 * uCamera) * (1.0 + 0.3 * squash);
  size *= mix(1.24, 1.0, uBlur);              // fewer dots in lite: draw them a touch heavier
  gl_PointSize = clamp(size, 1.25 * uDpr, 40.0 * uDpr);

  // dots that stay behind in A step back while B's dots fly
  float dim = mix(1.0, 0.5, uTwice * (1.0 - aHasB));
  vAlpha = gate * dim * vColor.a;
  vBlur = depth * uBlur;
  vCore = clamp(0.35 + 0.65 * uGlow + 0.55 * heat, 0.0, 1.5);
  vHeat = heat;
  vSquash = squash;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec3 uTable;
uniform vec3 uLight;

in vec4 vColor;
in float vAlpha;
in float vBlur;
in float vCore;
in float vHeat;
in float vSquash;

out vec4 outColor;

void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  // impact squash: sample a taller span so the sprite reads shorter
  d.y /= 1.0 - 0.5 * clamp(vSquash, 0.0, 1.0);
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float r = sqrt(r2);

  // soft round sprite: a wide halo under a tight core, both widening with defocus
  float edge = 1.0 - smoothstep(mix(0.38, 0.0, vBlur), 1.0, r);
  float halo = exp(-r2 * mix(7.0, 2.2, vBlur));
  float core = exp(-r2 * mix(34.0, 9.0, vBlur)) * vCore;
  float shape = clamp(halo * 0.62 + core * 0.85, 0.0, 1.0) * edge;
  float a = shape * vAlpha;
  if (a < 0.003) discard;

  // the table colour is the seat under the dot, so overlaps separate on either ground
  vec3 tint = mix(uTable, vColor.rgb, clamp(halo * 1.1 + core * 1.3, 0.0, 1.0));
  tint += uLight * (core * 0.5 + vHeat * halo * 0.55);

  outColor = vec4(tint * a, a);   // premultiplied
}
`;

/* ------------------------------------------------------------------ */
/* GL plumbing.                                                        */
/* ------------------------------------------------------------------ */

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function buildProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  if (!vertex) return null;
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!fragment) {
    gl.deleteShader(vertex);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.detachShader(program, vertex);
  gl.detachShader(program, fragment);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function finite(value: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nowMs(): number {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch {
    /* fall through */
  }
  return Date.now();
}

function hardwareConcurrency(): number {
  try {
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.hardwareConcurrency === "number"
    ) {
      return navigator.hardwareConcurrency;
    }
  } catch {
    /* fall through */
  }
  return 0;
}

function viewportDpr(): number {
  try {
    if (typeof window !== "undefined") {
      const dpr = finite(window.devicePixelRatio, 1);
      return Math.min(Math.max(dpr, 1), MAX_DPR);
    }
  } catch {
    /* fall through */
  }
  return 1;
}

function isPortrait(): boolean {
  try {
    if (typeof window !== "undefined") return window.innerHeight > window.innerWidth;
  } catch {
    /* fall through */
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* The field.                                                          */
/* ------------------------------------------------------------------ */

export function createDotsField(
  canvas: HTMLCanvasElement,
  data: FieldData,
): DotsField | null {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
  } catch {
    return null;
  }
  if (!gl) return null;
  if (gl.isContextLost()) return null;

  const context = gl;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let vao: WebGLVertexArrayObject | null = null;

  try {
    program = buildProgram(context);
    if (!program) return null;

    const raw = data.raw;
    const available = Number.isFinite(raw.length)
      ? Math.floor(raw.length / FLOATS_PER_DOT)
      : 0;
    const requested = Number.isFinite(data.count) ? Math.floor(data.count) : 0;
    const count = Math.max(0, Math.min(available, requested));

    // Read one field, NaN-safe: a short or malformed array must not throw here.
    const at = (index: number): number => {
      const value = raw[index];
      return typeof value === "number" ? value : Number.NaN;
    };

    // Draw the heaviest dots first, because the lite and portrait caps are slices
    // of the buffer rather than a second upload. This sort happens once.
    const order: number[] = [];
    for (let i = 0; i < count; i += 1) order.push(i);
    const weightOf = (index: number): number => {
      const value = at(index * FLOATS_PER_DOT);
      return Number.isFinite(value) ? value : 0;
    };
    order.sort((p, q) => weightOf(q) - weightOf(p));

    const interleaved = new Float32Array(count * FLOATS_PER_INSTANCE);
    for (let slot = 0; slot < count; slot += 1) {
      const source = order[slot];
      if (source === undefined) continue;
      const record = source * FLOATS_PER_DOT;
      const hasB = hasSecond(raw, source);
      const base = slot * FLOATS_PER_INSTANCE;
      interleaved[base] = weightOf(source);
      interleaved[base + 1] = at(record + 1);
      interleaved[base + 2] = at(record + 2);
      // A company that is not in B still needs finite B values, or the flight would
      // emit NaN positions; it keeps A's position and never turns coral.
      interleaved[base + 3] = hasB ? at(record + 3) : at(record + 1);
      interleaved[base + 4] = hasB ? at(record + 4) : at(record + 2);
      interleaved[base + 5] = at(record + 5);
      interleaved[base + 6] = at(record + 6);
      interleaved[base + 7] = hasB ? 1 : 0;
    }

    buffer = context.createBuffer();
    vao = context.createVertexArray();
    if (!buffer || !vao) {
      const staleBuffer = buffer;
      const staleVao = vao;
      buffer = null;
      vao = null;
      if (staleBuffer) context.deleteBuffer(staleBuffer);
      if (staleVao) context.deleteVertexArray(staleVao);
      return null;
    }

    context.bindVertexArray(vao);
    context.bindBuffer(context.ARRAY_BUFFER, buffer);
    context.bufferData(context.ARRAY_BUFFER, interleaved, context.STATIC_DRAW);
    const stride = FLOATS_PER_INSTANCE * 4;
    const attrib = (location: number, size: number, offset: number): void => {
      context.enableVertexAttribArray(location);
      context.vertexAttribPointer(location, size, context.FLOAT, false, stride, offset);
      context.vertexAttribDivisor(location, 1);
    };
    attrib(0, 1, 0); // weight
    attrib(1, 2, 4); // dot in A
    attrib(2, 2, 12); // dot in B
    attrib(3, 2, 20); // dot on the rule
    attrib(4, 1, 28); // is in B
    context.bindVertexArray(null);
    context.bindBuffer(context.ARRAY_BUFFER, null);

    context.useProgram(program);
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.enable(context.BLEND);
    context.blendFunc(context.ONE, context.ONE_MINUS_SRC_ALPHA);
    context.clearColor(0, 0, 0, 0);

    const uniform = (name: string): WebGLUniformLocation | null =>
      context.getUniformLocation(program as WebGLProgram, name);
    const u = {
      boxA: uniform("uBoxA"),
      boxB: uniform("uBoxB"),
      advance: uniform("uAdvance"),
      ascender: uniform("uAscender"),
      descender: uniform("uDescender"),
      view: uniform("uView"),
      dpr: uniform("uDpr"),
      scan: uniform("uScan"),
      twice: uniform("uTwice"),
      collapse: uniform("uCollapse"),
      camera: uniform("uCamera"),
      glow: uniform("uGlow"),
      blur: uniform("uBlur"),
      squashWindow: uniform("uSquashWindow"),
      dot: uniform("uDot"),
      twiceColor: uniform("uTwiceColor"),
      table: uniform("uTable"),
      light: uniform("uLight"),
    };

    const tokens = readTokens();
    // uTable and uLight are vec3; the dot colours carry their own alpha as vec4.
    context.uniform3f(u.table, tokens.table[0], tokens.table[1], tokens.table[2]);
    context.uniform3f(u.light, tokens.light[0], tokens.light[1], tokens.light[2]);
    context.uniform4f(u.dot, tokens.dot[0], tokens.dot[1], tokens.dot[2], tokens.dot[3]);
    context.uniform4f(
      u.twiceColor,
      tokens.twice[0],
      tokens.twice[1],
      tokens.twice[2],
      tokens.twice[3],
    );

    const dotCount = count;
    let lite = decideLite(hardwareConcurrency(), []);
    let drawn = dotBudget(dotCount, lite, isPortrait());
    let destroyed = false;
    let lost = false;

    // Setters only. Every value below is a uniform or a size; nothing is animated here.
    let scan = 0;
    let twice = 0;
    let collapse = 0;
    let camera = 0;
    let glow = 0;
    let squashWindowRatio = squashWindow(DEFAULT_TWICE_BEAT_MS);
    let advance = 2;
    let ascender = 0.72;
    let descender = 0.2;
    let boxA: readonly [number, number, number, number] = [0, 0, 1, 1];
    let boxB: readonly [number, number, number, number] = [0, 0, 1, 1];
    // Until the canvas has a real layout size, assume a stage-shaped viewport rather
    // than a 1 px one, so a field created before layout draws something sane.
    let viewWidth = 1280;
    let viewHeight = 720;
    let pinned = false;
    let dpr = viewportDpr();

    // Lite measurement. This is the one piece of state the caller does not set: the
    // first 30 frame times at construction, which the brief asks us to sample.
    const frameMs: number[] = [];
    let lastFrameAt = 0;
    const sampleFrame = (): void => {
      const now = nowMs();
      if (lastFrameAt > 0 && frameMs.length < LITE_FRAME_SAMPLES) {
        const dt = now - lastFrameAt;
        if (dt > 0) frameMs.push(Math.min(dt, MAX_FRAME_SAMPLE_MS));
      }
      lastFrameAt = now;
    };

    const resize = (): void => {
      if (destroyed) return;
      try {
        // A zero-sized canvas means "not laid out yet": keep the last known size.
        const measuredWidth = Math.round(finite(canvas.clientWidth, 0));
        const measuredHeight = Math.round(finite(canvas.clientHeight, 0));
        if (measuredWidth > 1) viewWidth = measuredWidth;
        if (measuredHeight > 1) viewHeight = measuredHeight;
        if (measuredWidth > 1 && measuredHeight > 1) pinned = true;
        const cssWidth = viewWidth;
        const cssHeight = viewHeight;
        dpr = viewportDpr();
        const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
        const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        context.viewport(0, 0, pixelWidth, pixelHeight);
        drawn = dotBudget(dotCount, lite, isPortrait());
      } catch {
        /* a detached or zero-sized canvas must not break the film */
      }
    };

    // A lost context is terminal for this field: there are no GPU resources left to
    // draw with and the film falls back to a dotless stage. Rendering stops here.
    const onLost = (): void => {
      lost = true;
    };
    try {
      canvas.addEventListener("webglcontextlost", onLost, false);
    } catch {
      /* ignore */
    }

    resize();

    const field: DotsField = {
      get lite(): boolean {
        return lite;
      },
      setScan(p: number): void {
        scan = clamp01(finite(p, 0));
      },
      setTwice(p: number): void {
        twice = clamp01(finite(p, 0));
      },
      setCollapse(p: number): void {
        collapse = clamp01(finite(p, 0));
      },
      setCamera(z: number): void {
        camera = clamp01(finite(z, 0));
      },
      setGlow(g: number): void {
        glow = clamp01(finite(g, 0));
      },
      setMetrics(nextAdvance: number, nextAscender: number, nextDescender: number): void {
        advance = Math.max(finite(nextAdvance, advance), 1e-3);
        ascender = Math.abs(finite(nextAscender, ascender));
        descender = Math.abs(finite(nextDescender, descender));
      },
      setTwiceBeat(ms: number): void {
        squashWindowRatio = squashWindow(finite(ms, DEFAULT_TWICE_BEAT_MS));
      },
      setBoxes(a: Box, b: Box): void {
        const read = (
          box: Box | null | undefined,
          previous: readonly [number, number, number, number],
        ): readonly [number, number, number, number] => {
          if (!box) return previous;
          return [
            finite(box.left, previous[0]),
            finite(box.top, previous[1]),
            Math.abs(finite(box.width, previous[2])),
            Math.abs(finite(box.height, previous[3])),
          ];
        };
        boxA = read(a, boxA);
        boxB = read(b, boxB);
      },
      resize,
      render(): void {
        if (destroyed || lost) return;
        // The film owns resize(), but a field built before its canvas was laid out
        // would draw into a guessed viewport, so settle that once and then trust it.
        if (!pinned) resize();
        sampleFrame();
        if (!lite && decideLite(hardwareConcurrency(), frameMs)) {
          lite = true;
          drawn = dotBudget(dotCount, lite, isPortrait());
        }
        context.clear(context.COLOR_BUFFER_BIT);
        context.uniform4f(u.boxA, boxA[0], boxA[1], boxA[2], boxA[3]);
        context.uniform4f(u.boxB, boxB[0], boxB[1], boxB[2], boxB[3]);
        context.uniform1f(u.advance, advance);
        context.uniform1f(u.ascender, ascender);
        context.uniform1f(u.descender, descender);
        context.uniform2f(u.view, viewWidth, viewHeight);
        context.uniform1f(u.dpr, dpr);
        context.uniform1f(u.scan, scan);
        context.uniform1f(u.twice, twice);
        context.uniform1f(u.collapse, collapse);
        context.uniform1f(u.camera, camera);
        context.uniform1f(u.glow, glow);
        context.uniform1f(u.blur, lite ? 0 : 1);
        context.uniform1f(u.squashWindow, squashWindowRatio);
        // The instance attributes live in the VAO, so it has to be bound for the draw.
        context.bindVertexArray(vao);
        context.drawArraysInstanced(context.POINTS, 0, 1, drawn);
      },
      destroy(): void {
        if (destroyed) return;
        destroyed = true;
        try {
          canvas.removeEventListener("webglcontextlost", onLost, false);
        } catch {
          /* ignore */
        }
        try {
          if (buffer) context.deleteBuffer(buffer);
          if (vao) context.deleteVertexArray(vao);
          if (program) context.deleteProgram(program);
        } catch {
          /* the context may already be gone */
        }
        buffer = null;
        vao = null;
        program = null;
        try {
          context.getExtension("WEBGL_lose_context")?.loseContext();
        } catch {
          /* ignore */
        }
      },
    };

    return field;
  } catch {
    try {
      if (buffer) context.deleteBuffer(buffer);
      if (vao) context.deleteVertexArray(vao);
      if (program) context.deleteProgram(program);
    } catch {
      /* ignore */
    }
    return null;
  }
}
