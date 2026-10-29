// Colores de la portada: port de androidx.palette (ColorCutQuantizer + Target) y de
// design/SongPalette.fromBitmap de Android. Sin DOM: recibe pixeles RGBA.

export type RGB = [number, number, number];
export type HSL = [number, number, number];

// ---------- ColorUtils (androidx.core) ----------
export function rgbToHsl([r8, g8, b8]: RGB): HSL {
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    s = d / (1 - Math.abs(2 * l - 1));
  }
  h = (h * 60) % 360;
  if (h < 0) h += 360;
  return [Math.min(360, Math.max(0, h)), Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, l))];
}

export function hslToRgb([h, s, l]: HSL): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s, m = l - 0.5 * c, x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const seg = Math.trunc(h / 60);
  let r = 0, g = 0, b = 0;
  switch (seg) {
    case 0: r = c + m; g = x + m; b = m; break;
    case 1: r = x + m; g = c + m; b = m; break;
    case 2: r = m; g = c + m; b = x + m; break;
    case 3: r = m; g = x + m; b = c + m; break;
    case 4: r = x + m; g = m; b = c + m; break;
    default: r = c + m; g = m; b = x + m; break;
  }
  const q = (v: number) => Math.min(255, Math.max(0, Math.round(v * 255)));
  return [q(r), q(g), q(b)];
}

export function luminance([r, g, b]: RGB): number {
  const f = (v: number) => { v /= 255; return v < 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// ---------- ColorCutQuantizer ----------
export interface Swatch { rgb: RGB; hsl: HSL; population: number }

const q5 = (v: number) => v >> 3;               // 8 -> 5 bits
const w8 = (v: number) => v << 3;               // 5 -> 8 bits (modifyWordWidth)
const pack = (r: number, g: number, b: number) => (r << 10) | (g << 5) | b;
const R = (c: number) => (c >> 10) & 31, G = (c: number) => (c >> 5) & 31, B = (c: number) => c & 31;

/** DEFAULT_FILTER: ni casi blanco, ni casi negro, ni la linea I roja (pieles). */
function allowed(hsl: HSL): boolean {
  const [h, s, l] = hsl;
  return !(l >= 0.95) && !(l <= 0.05) && !(h >= 10 && h <= 37 && s <= 0.82);
}
const swatchOf = (rgb: RGB, population: number): Swatch => ({ rgb, hsl: rgbToHsl(rgb), population });

export function quantize(rgba: Uint8ClampedArray | Uint8Array, maxColors = 16): Swatch[] {
  const hist = new Int32Array(1 << 15);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue; // transparente fuera
    hist[pack(q5(rgba[i]), q5(rgba[i + 1]), q5(rgba[i + 2]))]++;
  }
  const colors: number[] = [];
  for (let c = 0; c < hist.length; c++) {
    if (!hist[c]) continue;
    if (!allowed(rgbToHsl([w8(R(c)), w8(G(c)), w8(B(c))]))) { hist[c] = 0; continue; }
    colors.push(c);
  }
  if (colors.length <= maxColors) return colors.map((c) => swatchOf([w8(R(c)), w8(G(c)), w8(B(c))], hist[c]));

  interface Box { lo: number; hi: number; min: number[]; max: number[]; pop: number }
  const fit = (b: Box) => {
    b.min = [31, 31, 31]; b.max = [0, 0, 0]; b.pop = 0;
    for (let i = b.lo; i <= b.hi; i++) {
      const c = colors[i], v = [R(c), G(c), B(c)];
      for (let k = 0; k < 3; k++) { b.min[k] = Math.min(b.min[k], v[k]); b.max[k] = Math.max(b.max[k], v[k]); }
      b.pop += hist[c];
    }
  };
  const volume = (b: Box) => (b.max[0] - b.min[0] + 1) * (b.max[1] - b.min[1] + 1) * (b.max[2] - b.min[2] + 1);
  const box = (lo: number, hi: number) => { const b: Box = { lo, hi, min: [], max: [], pop: 0 }; fit(b); return b; };
  const boxes = [box(0, colors.length - 1)];
  // Cola por volumen: siempre se parte la caja mas grande
  while (boxes.length < maxColors) {
    boxes.sort((a, b) => volume(b) - volume(a));
    const b = boxes[0];
    if (b.hi - b.lo < 1) break;
    const len = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
    const dim = len[0] >= len[1] && len[0] >= len[2] ? 0 : len[1] >= len[0] && len[1] >= len[2] ? 1 : 2;
    const key = (c: number) => { const v = [R(c), G(c), B(c)]; const o = [v[dim], ...v.filter((_, k) => k !== dim)]; return (o[0] << 10) | (o[1] << 5) | o[2]; };
    const part = colors.slice(b.lo, b.hi + 1).sort((x, y) => key(x) - key(y));
    colors.splice(b.lo, part.length, ...part);
    const mid = b.pop / 2;
    let count = 0, split = b.hi - 1;
    for (let i = b.lo; i <= b.hi; i++) { count += hist[colors[i]]; if (count >= mid) { split = Math.min(b.hi - 1, i); break; } }
    const nb = box(split + 1, b.hi);
    b.hi = split; fit(b);
    boxes.push(nb);
  }
  const out: Swatch[] = [];
  for (const b of boxes) {
    let rs = 0, gs = 0, bs = 0, pop = 0;
    for (let i = b.lo; i <= b.hi; i++) { const c = colors[i], p = hist[c]; rs += p * R(c); gs += p * G(c); bs += p * B(c); pop += p; }
    const sw = swatchOf([w8(Math.round(rs / pop)), w8(Math.round(gs / pop)), w8(Math.round(bs / pop))], pop);
    if (allowed(sw.hsl)) out.push(sw);
  }
  return out;
}

// ---------- Palette targets ----------
interface Target { s: [number, number, number]; l: [number, number, number] }
const LIGHT: [number, number, number] = [0.55, 0.74, 1], NORMAL: [number, number, number] = [0.3, 0.5, 0.7], DARK: [number, number, number] = [0, 0.26, 0.45];
const VIBRANT: [number, number, number] = [0.35, 1, 1], MUTED: [number, number, number] = [0, 0.3, 0.4];
// Orden del Builder de androidx: cada target se queda su swatch (exclusivo)
const TARGETS: Record<string, Target> = {
  lightVibrant: { s: VIBRANT, l: LIGHT }, vibrant: { s: VIBRANT, l: NORMAL }, darkVibrant: { s: VIBRANT, l: DARK },
  lightMuted: { s: MUTED, l: LIGHT }, muted: { s: MUTED, l: NORMAL }, darkMuted: { s: MUTED, l: DARK },
};

export function pickTargets(sw: Swatch[]): Record<string, Swatch | null> {
  const used = new Set<Swatch>();
  const dom = Math.max(1, ...sw.map((s) => s.population));
  const out: Record<string, Swatch | null> = {};
  for (const [name, t] of Object.entries(TARGETS)) {
    let best: Swatch | null = null, bestScore = -Infinity;
    for (const s of sw) {
      const [, sat, l] = s.hsl;
      if (used.has(s) || sat < t.s[0] || sat > t.s[2] || l < t.l[0] || l > t.l[2]) continue;
      const score = 0.24 * (1 - Math.abs(sat - t.s[1])) + 0.52 * (1 - Math.abs(l - t.l[1])) + 0.24 * (s.population / dom);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (best) used.add(best);
    out[name] = best;
  }
  return out;
}

// ---------- SongPalette.fromBitmap ----------
export interface SongColors { accent: RGB; secondary: RGB; blobs: RGB[]; anchor: RGB }

const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

function normalizeAccent(hsl: HSL): RGB {
  const h: HSL = [hsl[0], Math.max(0.5, Math.min(0.9, hsl[1])), hsl[2]];
  const y = luminance(hslToRgb(h));
  if (y >= 0.20 && y <= 0.42) return hslToRgb(h);
  const target = y < 0.20 ? 0.20 : 0.42;
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; h[2] = mid; if (luminance(hslToRgb(h)) < target) lo = mid; else hi = mid; }
  h[2] = (lo + hi) / 2;
  return hslToRgb(h);
}

function deriveSecondary(accent: RGB): RGB {
  const h = rgbToHsl(accent);
  h[0] = (h[0] + 15) % 360; h[1] = Math.min(1, h[1] + 0.10); h[2] = 0.74;
  while (luminance(hslToRgb(h)) < 0.45 && h[2] < 0.88) h[2] += 0.02;
  return hslToRgb(h);
}

function toBlob(src: RGB, accentHue: number): RGB {
  const h = rgbToHsl(src);
  h[1] = Math.min(h[1], 0.65);
  h[2] = Math.max(0.22, Math.min(0.42, h[2]));
  if (hueDist(h[0], accentHue) < 25) h[2] = Math.min(h[2], 0.30);
  return hslToRgb(h);
}

/** null = portada sin color (gris): se usa el acento elegido. */
export function songColors(rgba: Uint8ClampedArray | Uint8Array): SongColors | null {
  const sw = quantize(rgba, 24);
  const named = pickTargets(sw);
  let best: Swatch | null = null, bestScore = -1;
  for (const s of sw) {
    const [, sat, l] = s.hsl;
    if (sat < 0.22 || l < 0.12 || l > 0.92) continue;
    let score = s.population * sat * sat;
    if (s === named.vibrant) score *= 1.5;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  if (!best) return null;
  const accent = normalizeAccent(best.hsl);
  const accentHue = rgbToHsl(accent)[0];
  const sources: RGB[] = [];
  const key = (c: RGB) => c.join(',');
  for (const n of ['vibrant', 'darkVibrant', 'lightVibrant', 'muted', 'darkMuted', 'lightMuted']) {
    const s = named[n];
    if (s && !sources.some((x) => key(x) === key(s.rgb))) sources.push(s.rgb);
  }
  sources.push(best.rgb);
  const blobs = [0, 1, 2].map((i) => toBlob(sources[Math.min(i, sources.length - 1)], accentHue));
  let anchor = blobs[0], far = -1;
  for (const b of blobs) { const d = hueDist(rgbToHsl(b)[0], accentHue); if (d > far) { far = d; anchor = b; } }
  if (far < 25) { anchor = blobs[0]; for (const b of blobs) if (luminance(b) < luminance(anchor)) anchor = b; }
  return { accent, secondary: deriveSecondary(accent), blobs, anchor };
}

export const cssRgb = (c: RGB) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
