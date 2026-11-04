// Secciones de la cancion donde pulsa el fondo animado = BeatPulseMap de Android: nacen de la energia de la
// bateria. Las tranquilas no pulsan y el pulso crece en los beats que llevan a una fuerte. Sin contraste
// claro entre secciones pulsa toda la cancion, salvo donde la bateria calla.
import { DRUM_PARTS } from './stems.ts';

export const PULSE_FILE = 'pulse_map.txt';
export const MIN_BEATS = 32;
const FORMAT = 1;
const SMOOTH_BEATS = 8, MIN_SECTION_BEATS = 16, LEAD_BEATS = 8;
const SILENCE_RANGE_DB = 25, MIN_CONTRAST_DB = 6, NO_DRUMS_DB = -50;
const HISTOGRAM_BINS = 60, MIN_CLUSTER_SHARE = 0.05;

type Section = [ramp: number, start: number, end: number];

export class BeatPulseMap {
  readonly rampStarts: number[];
  readonly starts: number[];
  readonly ends: number[];

  private constructor(sections: Section[]) {
    this.rampStarts = sections.map((s) => s[0]);
    this.starts = sections.map((s) => s[1]);
    this.ends = sections.map((s) => s[2]);
  }

  /** 0 en una seccion tranquila, subiendo hasta 1 antes de una fuerte. */
  gainAt(timeSec: number) {
    for (let i = 0; i < this.starts.length; i++) {
      if (timeSec >= this.ends[i]) continue;
      if (timeSec < this.rampStarts[i]) return 0;
      if (timeSec >= this.starts[i]) return 1;
      return (timeSec - this.rampStarts[i]) / (this.starts[i] - this.rampStarts[i]);
    }
    return 0;
  }

  /** Secciones a partir de la potencia de la bateria en cada beat. */
  static fromPower(power: ArrayLike<number>, beats: readonly number[]): BeatPulseMap {
    const level = smoothedDb(power);
    const sorted = Float64Array.from(level).sort();
    const top = sorted[Math.trunc(0.95 * (sorted.length - 1))];
    if (top < NO_DRUMS_DB) return alwaysOn(beats);
    const silence = top - SILENCE_RANGE_DB;
    const split = contrastThreshold(sorted, silence);
    const threshold = Number.isNaN(split) ? silence : split;
    const on = Array.from(level, (l) => l >= threshold);
    absorbShortRuns(on, false);
    absorbShortRuns(on, true);
    return fromSections(on, beats);
  }

  serialize(sig: string) {
    const rows = this.starts.map((_, i) => [this.rampStarts[i], this.starts[i], this.ends[i]].map((v) => v.toFixed(3)).join(' '));
    return [`${FORMAT} ${sig}`, ...rows].join('\n') + '\n';
  }

  /** null si la cache no vale: falta, otra firma u otro formato. */
  static parse(text: string | null, sig: string): BeatPulseMap | null {
    if (!text) return null;
    const [head, ...rows] = text.split('\n').filter((l) => l.trim());
    if (head !== `${FORMAT} ${sig}` || !rows.length) return null;
    const sections: Section[] = [];
    for (const row of rows) {
      const v = row.trim().split(' ').map(Number);
      if (v.length !== 3 || v.some(Number.isNaN)) return null;
      sections.push(v as Section);
    }
    return new BeatPulseMap(sections);
  }

  static alwaysOn(beats: readonly number[]) { return new BeatPulseMap([[0, 0, beats[beats.length - 1] + 60]]); }
  static of(sections: Section[]) { return new BeatPulseMap(sections); }
}

const alwaysOn = BeatPulseMap.alwaysOn;

/** dB por beat, con la media de una ventana centrada. */
function smoothedDb(power: ArrayLike<number>) {
  const n = power.length, db = new Float64Array(n), out = new Float64Array(n);
  for (let i = 0; i < n; i++) db[i] = 10 * Math.log10(power[i] + 1e-12);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < SMOOTH_BEATS; k++) sum += db[Math.max(0, Math.min(n - 1, i - SMOOTH_BEATS / 2 + k))];
    out[i] = sum / SMOOTH_BEATS;
  }
  return out;
}

/** Nivel que mejor parte en dos los beats que suenan (Otsu), o NaN si los grupos estan demasiado cerca. */
function contrastThreshold(sorted: Float64Array, silence: number) {
  let first = 0;
  while (first < sorted.length && sorted[first] < silence) first++;
  const count = sorted.length - first;
  if (!count) return NaN;
  const lo = sorted[first], hi = sorted[sorted.length - 1];
  if (hi <= lo) return NaN;
  const width = (hi - lo) / HISTOGRAM_BINS, weight = new Float64Array(HISTOGRAM_BINS);
  for (let i = first; i < sorted.length; i++) weight[Math.min(HISTOGRAM_BINS - 1, Math.trunc((sorted[i] - lo) / width))]++;
  let bestScore = -1, bestSplit = NaN, bestContrast = 0;
  for (let split = 1; split < HISTOGRAM_BINS; split++) {
    let w0 = 0, w1 = 0, s0 = 0, s1 = 0;
    for (let b = 0; b < HISTOGRAM_BINS; b++) {
      const centre = lo + (b + 0.5) * width;
      if (b < split) { w0 += weight[b]; s0 += weight[b] * centre; } else { w1 += weight[b]; s1 += weight[b] * centre; }
    }
    if (w0 < MIN_CLUSTER_SHARE * count || w1 < MIN_CLUSTER_SHARE * count) continue;
    const contrast = s1 / w1 - s0 / w0, score = w0 * w1 * contrast * contrast;
    if (score > bestScore) { bestScore = score; bestSplit = lo + split * width; bestContrast = contrast; }
  }
  return bestContrast >= MIN_CONTRAST_DB ? bestSplit : NaN;
}

/** Los tramos de `value` mas cortos que una seccion pasan a ser como su entorno. */
function absorbShortRuns(on: boolean[], value: boolean) {
  const n = on.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && on[j] === on[i]) j++;
    if (on[i] === value && j - i < MIN_SECTION_BEATS && j - i < n) on.fill(!value, i, j);
    i = j;
  }
}

function fromSections(on: boolean[], beats: readonly number[]) {
  const n = on.length, sections: Section[] = [];
  let previousEnd = 0, i = 0;
  while (i < n) {
    if (!on[i]) { i++; continue; }
    let j = i;
    while (j < n && on[j]) j++;
    // Un beat de mas: el primero de la rampa ya pulsa
    const ramp = Math.max(previousEnd, i - LEAD_BEATS - 1);
    sections.push([beats[ramp], beats[i], j < n ? beats[j] : beats[n - 1] + 60]);
    previousEnd = j;
    i = j;
  }
  return sections.length ? BeatPulseMap.of(sections) : alwaysOn(beats);
}

/** Suma a `power` la potencia media (mono) de cada ventana: beats[i]..beats[i+1]; la ultima hasta el final. */
export function addBeatPower(pcm: { data: Float32Array; sr: number; ch: number; frames: number }, beats: readonly number[], power: Float64Array) {
  const { data, sr, ch, frames } = pcm, n = beats.length;
  const sums = new Float64Array(n), counts = new Float64Array(n);
  let w = 0;
  for (let f = 0; f < frames; f++) {
    while (w + 1 < n && f >= beats[w + 1] * sr) w++;
    if (f < beats[w] * sr) continue;
    let mono = 0;
    for (let c = 0; c < ch; c++) mono += data[f * ch + c];
    mono /= ch;
    sums[w] += mono * mono;
    counts[w]++;
  }
  for (let i = 0; i < n; i++) if (counts[i] > 0) power[i] += sums[i] / counts[i];
}

/** La bateria entera, o sus partes (y perc) si la separacion la dividio. */
export function drumFiles(names: readonly string[]) {
  const pick = (stem: string) => names.find((x) => x === `${stem}.flac`) ?? names.find((x) => x === `${stem}.wav`);
  const full = pick('drums');
  if (full) return [full];
  return [...DRUM_PARTS, 'perc'].map(pick).filter((x): x is string => !!x);
}

/** Valida la cache hasta que cambie la bateria o la rejilla de beats. */
export const signature = (files: readonly { size: number; lastModified: number }[], beats: number) =>
  [beats, ...files.flatMap((f) => [f.size, f.lastModified])].join('_');
