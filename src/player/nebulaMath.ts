// Nebulosa sin DOM: semilla de las orbitas (java.util.Random), paleta del acento y pulso por beat.

/** java.util.Random minimo (nextFloat), para sembrar las mismas orbitas que Android. */
export class JavaRandom {
  private seed: bigint;
  constructor(seed: number) { this.seed = (BigInt(seed) ^ 0x5DEECE66Dn) & ((1n << 48n) - 1n); }
  private next(bits: number): number {
    this.seed = (this.seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
    return Number(this.seed >> BigInt(48 - bits));
  }
  nextFloat(): number { return this.next(24) / (1 << 24); }
}

export interface Orbit { phase: number; freq: number; rx: number; ry: number }

/** NebulaBackgroundView.init: fases repartidas 2pi/N + jitter; blob 0 rapido, 1-2 lentos. */
export function orbits(count = 3): Orbit[] {
  const rnd = new JavaRandom(1337);
  const out: Orbit[] = [];
  for (let i = 0; i < count; i++) {
    const phase = i * (2 * Math.PI / count) + rnd.nextFloat() * 0.6;
    const freq = i === 0 ? 0.06 + rnd.nextFloat() * 0.05 : 0.014 + rnd.nextFloat() * 0.020;
    const rx = 0.55 + rnd.nextFloat() * 0.20, ry = 0.50 + rnd.nextFloat() * 0.20;
    out.push({ phase, freq, rx, ry });
  }
  return out;
}

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const blend = (a: number[], b: number[], k: number) => a.map((v, i) => Math.round(v + (b[i] - v) * k));

/** SongPalette.fromAccent: blobs = acento, +30 % blanco, +40 % negro; ancla = acento. */
export function accentPalette(accent: string): { blobs: number[][]; anchor: number[] } {
  const p = hex(accent);
  return { blobs: [p, blend(p, [255, 255, 255], 0.30), blend(p, [0, 0, 0], 0.40)], anchor: p };
}

export const NEBULA_HALF_TIME_BPM = 130;

/**
 * Intensidad del pulso en un beat (posicion 1-based en el compas), o 0 si no pulsa.
 * 4/4 y 6/8: impares 0.35, pares 0.90. 3/4: downbeat 0.95, resto 0.30.
 * Tempo oido > 130 BPM: solo los beats 1 y 3 (en 3/4 el downbeat), a 0.90.
 */
export function pulseFor(pos: number, beatsPerBar: number, heardBpm: number | null): number {
  if (heardBpm !== null && heardBpm > NEBULA_HALF_TIME_BPM) {
    const strong = beatsPerBar === 3 ? pos === 1 : pos === 1 || pos === 3;
    return strong ? 0.90 : 0;
  }
  if (beatsPerBar === 3) return pos === 1 ? 0.95 : 0.30;
  return pos % 2 === 1 ? 0.35 : 0.90;
}

export const PULSE_DECAY_PER_SEC = 7;
export const decayPulse = (p: number, dtSec: number) => { const v = p * Math.exp(-dtSec * PULSE_DECAY_PER_SEC); return v < 0.005 ? 0 : v; };

/** Luminancia relativa (WCAG) de un color sRGB 0..255. */
const relLum = (c: number[]) => {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};

/** Tope del fondo (luminancia del peor punto, calculado como si todo se solapara). Calibrado con la e2e de
 *  contraste: 0.075 deja el peor texto en 4.54; 0.065 en 4.75. */
export const NEBULA_MAX_LUM = 0.065;
const PEAK_BLOB = [230 / 255, 195 / 255, 195 / 255], PEAK_ANCHOR = 240 / 255, VEIL_KEEP = 0.6;

/**
 * Tope de brillo (web, decision JP; Android no lo tiene): factor para el alpha de blobs y ancla tal que el peor
 * punto (todo sumado en 'lighter', pulso maximo, tras el velo .4) no pase de maxLum. 1 = no hace falta.
 */
export function brightnessCap(p: { blobs: number[][]; anchor: number[] }, maxLum = NEBULA_MAX_LUM): number {
  const sum = [0, 1, 2].map((ch) => p.blobs.reduce((s, c, i) => s + c[ch] * (PEAK_BLOB[i] ?? PEAK_BLOB[1]), 0) + p.anchor[ch] * PEAK_ANCHOR);
  const lumAt = (k: number) => relLum(sum.map((v) => Math.min(255, v * k) * VEIL_KEEP));
  if (lumAt(1) <= maxLum) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (lumAt(m) <= maxLum) lo = m; else hi = m; }
  return lo;
}
