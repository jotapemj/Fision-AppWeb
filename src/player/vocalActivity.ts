// Donde suena la voz de verdad = VocalActivity de Android: sobre la envolvente RMS (dBFS cada
// 10 ms, Track::computeEnvelope) del stem de voces. Umbral relativo al nivel de la cancion,
// silencios cortos puenteados y voz muy corta descartada. Tiempos en s de la cancion.

export const ENVELOPE_HOP_MS = 10; // Track::ENVELOPE_HOP_MS
const HOP = ENVELOPE_HOP_MS / 1000;
const RANGE_DB = 24;               // umbral bajo el percentil 95
const FLOOR_DB = -60;
const MIN_SILENCE_SEC = 0.25;      // huecos entre silabas
const MIN_SILENCE_FINE_SEC = 0.12; // pausas dentro del verso
const MIN_VOICE_SEC = 0.08;
const VALLEY_DB = 12;              // pausa que no llega a silencio (reverb, nota que decae)
const MIN_VALLEY_SEC = 0.12;
const CONSONANT_LEAD_SEC = 0.05;   // la palabra se enciende un poco antes del fin del valle

/** Gira los tramos de `value` mas cortos que `minLen` frames (solo interiores). */
function bridge(v: boolean[], value: boolean, minLen: number) {
  let i = 0;
  while (i < v.length) {
    if (v[i] !== value) { i++; continue; }
    let j = i;
    while (j < v.length && v[j] === value) j++;
    if (i > 0 && j < v.length && j - i < minLen) for (let k = i; k < j; k++) v[k] = !value;
    i = j;
  }
}

export class VocalActivity {
  private readonly voiced: boolean[];
  private readonly voicedFine: boolean[];
  private readonly level: Float32Array; // envolvente suavizada en 3 frames

  private constructor(voiced: boolean[], voicedFine: boolean[], level: Float32Array) {
    this.voiced = voiced; this.voicedFine = voicedFine; this.level = level;
  }

  /** Varias voces (principal + coros): la mas fuerte en cada frame. null sin voz audible. */
  static fromEnvelopes(...envs: (Float32Array | null | undefined)[]): VocalActivity | null {
    let db: Float32Array | null = null;
    for (const e of envs) {
      if (!e?.length) continue;
      if (!db) { db = e.slice(); continue; }
      const n = Math.min(db.length, e.length), m = new Float32Array(n);
      for (let i = 0; i < n; i++) m[i] = Math.max(db[i], e[i]);
      db = m;
    }
    return VocalActivity.fromEnvelope(db);
  }

  static fromEnvelope(db: Float32Array | null): VocalActivity | null {
    if (!db?.length) return null;
    const audible = db.filter((v) => v > -80);
    if (audible.length < 50) return null;
    audible.sort();
    const n = audible.length, loud = audible[Math.min(n - 1, Math.trunc(n * 0.95))];
    const thr = Math.max(loud - RANGE_DB, FLOOR_DB);
    const v = Array.from(db, (x) => x > thr), fine = v.slice();
    bridge(v, false, Math.round(MIN_SILENCE_SEC / HOP));
    bridge(v, true, Math.round(MIN_VOICE_SEC / HOP));
    bridge(fine, false, Math.round(MIN_SILENCE_FINE_SEC / HOP));
    bridge(fine, true, Math.round(MIN_VOICE_SEC / HOP));
    const level = new Float32Array(db.length);
    for (let i = 0; i < db.length; i++) {
      const a = Math.max(0, i - 1), b = Math.min(db.length - 1, i + 1);
      let sum = 0;
      for (let k = a; k <= b; k++) sum = Math.fround(sum + db[k]); // float como Java
      level[i] = sum / (b - a + 1);
    }
    return new VocalActivity(v, fine, level);
  }

  private frame(sec: number) { return Math.max(0, Math.min(this.voiced.length - 1, Math.round(sec / HOP))); }

  /** Ultimo regreso de la voz tras silencio en [from, to]; NaN si no hay. */
  lastOnsetIn(from: number, to: number) { return this.lastOnset(this.voiced, from, to); }

  /** Onset de una palabra dentro del verso tras una pausa (valle o mascara fina), solo si quedan
   *  `minRemain` s hasta `to` para cantarla (si no, la pausa iba despues). NaN si no hay. */
  innerOnsetIn(from: number, to: number, minRemain: number) {
    const valley = this.valleyEndIn(from, to, minRemain);
    if (!Number.isNaN(valley)) return Math.max(from, valley - CONSONANT_LEAD_SEC);
    const m = this.lastOnset(this.voicedFine, from, to);
    return !Number.isNaN(m) && to - m >= minRemain ? m : NaN;
  }

  /** Fin del ultimo valle en [from, to - minRemain]: nivel cantado junto a `from` - 12 dB, >= 0.12 s. */
  private valleyEndIn(from: number, to: number, minRemain: number) {
    const lv = this.level;
    let ref = -Number.MAX_VALUE;
    for (let i = this.frame(from - 0.4); i <= this.frame(from + 0.1); i++) ref = Math.max(ref, lv[i]);
    const thr = Math.fround(ref - VALLEY_DB);
    const a = this.frame(from), b = this.frame(to - minRemain), minLen = Math.round(MIN_VALLEY_SEC / HOP);
    let best = NaN, i = a;
    while (i <= b) {
      if (lv[i] >= thr) { i++; continue; }
      let j = i;
      while (j < lv.length && lv[j] < thr) j++;
      if (j - i >= minLen && j <= b) best = j * HOP;
      i = j;
    }
    return best;
  }

  private lastOnset(v: boolean[], from: number, to: number) {
    const a = this.frame(from), b = this.frame(to);
    for (let i = b; i > a; i--) if (v[i] && !v[i - 1]) return i * HOP;
    return NaN;
  }

  /** Fin del tramo con voz que empieza en `wordStart` (busca hasta `searchTo`), sin pasar de `limit`. */
  voiceEndAfter(wordStart: number, searchTo: number, limit: number) {
    let i = this.frame(wordStart);
    const s = this.frame(searchTo), lim = this.frame(limit), v = this.voiced;
    while (i <= s && !v[i]) i++;
    if (i > s) return NaN;
    while (i < lim && v[i]) i++;
    return i * HOP;
  }
}
