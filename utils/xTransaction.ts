// Port of X's `x-client-transaction-id` generation (publicly reverse-engineered),
// so we can mint a valid token for replayed GraphQL reads without the user having
// to manually re-trigger the request on X. Runs in the MAIN world — it needs the
// page DOM (verification key + animation SVGs) and same-origin fetch.
//
// ⚠️ This is the most fragile, most ToS-aggressive part of the extension: it
// defeats an anti-automation control and X changes the scheme periodically. All
// failures are swallowed (return null) so callers fall back to a captured token.
/* eslint-disable @typescript-eslint/no-explicit-any */

const KEYWORD = 'obfiowerehiring';
const EXTRA = 3;
const EPOCH = 1682924400 * 1000;
const INDICES_RE = /\(\w\[(\d{1,2})\],\s*16\)/g;
// Matches X's webpack runtime mapping of the "ondemand.s" chunk → its hash.
const ONDEMAND_HASH_RE =
  /(\d+):\s*["']ondemand\.s["'][\s\S]*?\}\)\[e\]\s*\|\|\s*e\)\s*\+\s*["']\.["']\s*\+\s*\(\{[\s\S]*?\b\1:\s*["']([a-zA-Z0-9_-]+)["']/;
const TOTAL_TIME = 4096;

let ready = false;
let initPromise: Promise<boolean> | null = null;
let keyBytes: number[] = [];
let rowIndex = 0;
let keyByteIndices: number[] = [];
let animationKey = '';

function b64ToBytes(b64: string): number[] {
  const bin = atob(b64);
  const out: number[] = new Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: number[]): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b & 0xff);
  return btoa(bin);
}

async function sha256Bytes(input: string): Promise<number[]> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)];
}

const isEven = (n: number): number => (n % 2 === 0 ? 0 : -1);

function solve(value: number, min: number, max: number, rounding: boolean): number {
  const r = (value * (max - min)) / 255 + min;
  return rounding ? Math.floor(r) : Math.round(r * 100) / 100;
}

function calc(a: number, b: number, m: number): number {
  return 3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m;
}

function cubicValue(curves: number[], t: number): number {
  let startGradient = 0;
  let endGradient = 0;
  let start = 0;
  let mid = 0;
  let end = 1;
  if (t <= 0) {
    if (curves[0] > 0) startGradient = curves[1] / curves[0];
    else if (curves[1] === 0 && curves[2] > 0) startGradient = curves[3] / curves[2];
    return startGradient * t;
  }
  if (t >= 1) {
    if (curves[2] < 1) endGradient = (curves[3] - 1) / (curves[2] - 1);
    else if (curves[2] === 1 && curves[0] < 1) endGradient = (curves[1] - 1) / (curves[0] - 1);
    return 1 + endGradient * (t - 1);
  }
  while (start < end) {
    mid = (start + end) / 2;
    const xEst = calc(curves[0], curves[2], mid);
    if (Math.abs(t - xEst) < 1e-5) return calc(curves[1], curves[3], mid);
    if (xEst < t) start = mid;
    else end = mid;
  }
  return calc(curves[1], curves[3], mid);
}

function floatToHex(x: number): string {
  const result: string[] = [];
  let quotient = Math.floor(x);
  let fraction = x - quotient;
  while (quotient > 0) {
    quotient = Math.floor(x / 16);
    const remainder = Math.floor(x - quotient * 16);
    result.unshift(remainder > 9 ? String.fromCharCode(remainder + 55) : String(remainder));
    x = quotient;
  }
  if (fraction === 0) return result.join('');
  result.push('.');
  while (fraction > 0) {
    fraction *= 16;
    const integer = Math.floor(fraction);
    fraction -= integer;
    result.push(integer > 9 ? String.fromCharCode(integer + 55) : String(integer));
  }
  return result.join('');
}

const interpolate = (from: number[], to: number[], f: number): number[] =>
  from.map((v, i) => v * (1 - f) + to[i] * f);

function rotationMatrix(deg: number): number[] {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)];
}

function animate(frames: number[], targetTime: number): string {
  const fromColor = [...frames.slice(0, 3), 1];
  const toColor = [...frames.slice(3, 6), 1];
  const fromRotation = [0];
  const toRotation = [solve(frames[6], 60, 360, true)];
  const rest = frames.slice(7);
  const curves = rest.map((item, i) => solve(item, isEven(i), 1, false));
  const val = cubicValue(curves, targetTime);
  const color = interpolate(fromColor, toColor, val).map((v) => (v > 0 ? v : 0));
  const rotation = interpolate(fromRotation, toRotation, val);
  const matrix = rotationMatrix(rotation[0]);

  const strArr: string[] = color.slice(0, -1).map((v) => Math.round(v).toString(16));
  for (const value of matrix) {
    let rounded = Math.round(value * 100) / 100;
    if (rounded < 0) rounded = -rounded;
    const hex = floatToHex(rounded);
    strArr.push(hex.startsWith('.') ? `0${hex}`.toLowerCase() : hex || '0');
  }
  strArr.push('0', '0');
  return strArr.join('').replace(/[.-]/g, '');
}

function get2dArray(doc: Document): number[][] {
  const frames = doc.querySelectorAll("[id^='loading-x-anim']");
  const frame = frames[keyBytes[5] % 4] as Element | undefined;
  const path = frame?.children[0]?.children[1];
  const d = path?.getAttribute('d');
  if (!d) throw new Error('animation path not found in home HTML');
  return d
    .slice(9)
    .split('C')
    .map((item) =>
      item
        .replace(/[^\d]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number),
    );
}

/** Find the ondemand.s chunk URL from X's inline webpack runtime. */
function resolveOnDemandUrl(doc: Document): string | null {
  const sources: string[] = [];
  for (const s of Array.from(doc.querySelectorAll('script'))) {
    const t = s.textContent || '';
    if (t.includes('ondemand.s')) sources.push(t);
  }
  sources.push(doc.documentElement.outerHTML);
  for (const src of sources) {
    const m = ONDEMAND_HASH_RE.exec(src);
    if (m) {
      return `https://abs.twimg.com/responsive-web/client-web/ondemand.s.${m[2]}a.js`;
    }
  }
  return null;
}

async function init(): Promise<boolean> {
  // The verification key, webpack runtime, and loading-animation SVGs only exist
  // in X's SERVER-RENDERED HTML — they're stripped once React hydrates — so fetch
  // a fresh copy and parse that, not the live DOM.
  const html = await (await fetch(`${location.origin}/`, { credentials: 'include' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // 1. verification key → bytes
  const key = doc.querySelector("[name='twitter-site-verification']")?.getAttribute('content');
  if (!key) throw new Error('no twitter-site-verification in home HTML');
  keyBytes = b64ToBytes(key);

  // 2. on-demand JS file → byte-index constants
  const url = resolveOnDemandUrl(doc);
  if (!url) throw new Error('ondemand.s chunk not found in home HTML');
  const js = await (await fetch(url)).text();
  const indices: number[] = [];
  let mm: RegExpExecArray | null;
  INDICES_RE.lastIndex = 0;
  while ((mm = INDICES_RE.exec(js))) indices.push(parseInt(mm[1], 10));
  if (indices.length < 2) throw new Error('no key-byte indices in ondemand file');
  rowIndex = indices[0];
  keyByteIndices = indices.slice(1);

  // 3. derive the animation key from the SVG frames
  const rIdx = keyBytes[rowIndex] % 16;
  let frameTime = keyByteIndices.reduce((acc, i) => acc * (keyBytes[i] % 16), 1);
  frameTime = Math.round(frameTime / 10) * 10;
  const frameRow = get2dArray(doc)[rIdx];
  if (!frameRow) throw new Error('animation frame row missing');
  animationKey = animate(frameRow, frameTime / TOTAL_TIME);

  ready = true;
  return true;
}

export async function ensureReady(): Promise<boolean> {
  if (ready) return true;
  if (!initPromise) {
    initPromise = init().catch((e) => {
      console.warn('[claude-for-x] transaction-id init failed', e);
      initPromise = null;
      return false;
    });
  }
  return initPromise;
}

/** Generate a fresh x-client-transaction-id for a request, or null on failure. */
export async function generateTransactionId(
  method: string,
  path: string,
): Promise<string | null> {
  if (!(await ensureReady())) return null;
  try {
    const timeNow = Math.floor((Date.now() - EPOCH) / 1000);
    const timeBytes = [0, 1, 2, 3].map((i) => (timeNow >> (i * 8)) & 0xff);
    const hashBytes = await sha256Bytes(`${method}!${path}!${timeNow}${KEYWORD}${animationKey}`);
    const rand = Math.floor(Math.random() * 256);
    const arr = [...keyBytes, ...timeBytes, ...hashBytes.slice(0, 16), EXTRA];
    const out = [rand, ...arr.map((b) => b ^ rand)];
    return bytesToB64(out).replace(/=+$/, '');
  } catch (e) {
    console.warn('[claude-for-x] transaction-id generate failed', e);
    return null;
  }
}
