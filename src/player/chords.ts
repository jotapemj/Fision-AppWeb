// Acordes: lectura, celdas por beat (PlayerActivity.buildBeatCells) y formato (ChordFormatter).
import type { LyricRow } from './lyrics.ts';

export interface ChordEvent { chord: string; time: number }
export interface BeatCell { time: number; pos: number; isDownbeat: boolean; chord: string | null }

/** "<acorde> <segundos>" por linea; N = sin acorde (se salta). */
export function parseChords(txt: string | null): ChordEvent[] {
  if (!txt) return [];
  const out: ChordEvent[] = [];
  for (const line of txt.split(/\r?\n/)) {
    const [chord, t] = line.trim().split(/\s+/);
    const time = parseFloat(t);
    if (!chord || !Number.isFinite(time) || chord === 'N') continue;
    out.push({ chord, time });
  }
  return out;
}

export function parseTimes(txt: string | null): number[] {
  return txt ? txt.split(/\r?\n/).map(parseFloat).filter((v) => Number.isFinite(v)) : [];
}

/** Celdas por beat: compas por moda de downbeats (3/4/6, si no 4), acorde cuantizado al beat mas cercano. */
export function buildBeatCells(beats: number[], downbeats: number[], chords: ChordEvent[]): { cells: BeatCell[]; beatsPerBar: number } {
  const n = beats.length;
  if (!n) return { cells: [], beatsPerBar: 4 };
  const f = Math.fround; // Android usa float32
  let beatsPerBar = 4;
  const pos = new Array<number>(n);
  if (downbeats.length) {
    const idx: number[] = [];
    let j = 0;
    for (const t of downbeats) {
      while (j + 1 < n && Math.abs(f(beats[j + 1]) - f(t)) < Math.abs(f(beats[j]) - f(t))) j++;
      idx.push(j);
    }
    const histo = new Array(8).fill(0);
    for (let i = 1; i < idx.length; i++) { const d = idx[i] - idx[i - 1]; if (d >= 2 && d < 8) histo[d]++; }
    let best = 4, cnt = -1;
    for (let i = 2; i < 8; i++) if (histo[i] > cnt) { cnt = histo[i]; best = i; }
    beatsPerBar = best === 3 || best === 4 || best === 6 ? best : 4;
    let k = 0;
    for (let i = 0; i < n; i++) {
      while (k + 1 < idx.length && idx[k + 1] <= i) k++;
      const anchor = idx[k];
      if (i < anchor) {
        let p = ((beatsPerBar - ((anchor - i) % beatsPerBar)) % beatsPerBar) + 1;
        if (p > beatsPerBar) p = 1;
        pos[i] = p;
      } else pos[i] = ((i - anchor) % beatsPerBar) + 1;
    }
  } else for (let i = 0; i < n; i++) pos[i] = (i % 4) + 1;

  const perBeat = new Array<string | null>(n).fill(null);
  for (const c of chords) {
    let nearest = 0, min = Math.abs(f(beats[0]) - f(c.time));
    for (let i = 1; i < n; i++) {
      const d = Math.abs(f(beats[i]) - f(c.time));
      if (d < min) { min = d; nearest = i; } else if (beats[i] > c.time) break;
    }
    perBeat[nearest] = c.chord; // el ultimo gana
  }
  let last: string | null = null;
  const cells = beats.map((time, i) => {
    let chord: string | null = null;
    const at = perBeat[i];
    if (at !== null && at !== last) { chord = at; last = at; }
    return { time, pos: pos[i], isDownbeat: pos[i] === 1, chord };
  });
  return { cells, beatsPerBar };
}

/** Beat que suena en `sec`: el ultimo con time <= sec, o -1. */
export function currentBeat(cells: BeatCell[], sec: number): number {
  let lo = 0, hi = cells.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cells[m].time <= sec) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/** Acorde que sigue sonando en la celda i (el ultimo que empezo antes o en ella). */
export function soundingChord(cells: BeatCell[], i: number): string | null {
  for (let k = i; k >= 0; k--) if (cells[k].chord) return cells[k].chord;
  return null;
}
export function nextChord(cells: BeatCell[], i: number): string | null {
  for (let k = i + 1; k < cells.length; k++) if (cells[k].chord) return cells[k].chord;
  return null;
}

// --- ChordFormatter ---
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LATIN_SHARP = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
const LATIN_FLAT = ['Do', 'Reb', 'Re', 'Mib', 'Mi', 'Fa', 'Solb', 'Sol', 'Lab', 'La', 'Sib', 'Si'];
const PITCH: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

function formatSingle(chord: string, semi: number, latin: boolean, flat: boolean): string {
  if (!chord || chord[0] < 'A' || chord[0] > 'G') return chord;
  const rootLen = chord.length >= 2 && (chord[1] === '#' || chord[1] === 'b') ? 2 : 1;
  const idx = PITCH[chord.slice(0, rootLen)];
  if (idx === undefined) return chord;
  const ni = (((idx + semi) % 12) + 12) % 12;
  let suffix = chord.slice(rootLen);
  // ';' = inicio de superindice en MusGlyphs (americano); en latino se quita
  if (latin) suffix = suffix.replace(/;/g, '');
  return (latin ? (flat ? LATIN_FLAT : LATIN_SHARP) : (flat ? FLAT : SHARP))[ni] + suffix;
}

export function formatChord(chord: string | null, semi = 0, latin = false, flat = false): string {
  if (!chord) return '';
  const s = chord.indexOf('/');
  if (s > 0) return formatSingle(chord.slice(0, s), semi, latin, flat) + '/' + formatSingle(chord.slice(s + 1), semi, latin, flat);
  return formatSingle(chord, semi, latin, flat);
}

/**
 * Acordes encima de la letra (solo web): cada cambio, ya cuantizado a su beat, va a la palabra
 * que suena en ese instante; si cae en el hueco antes de una linea (< 2 s), a su primera palabra.
 * En partes instrumentales no se pinta. Varios en la misma palabra: el ultimo.
 * Devuelve clave "fila:palabra" -> acorde.
 */
export function chordsOverWords(rows: LyricRow[], cells: BeatCell[]): Map<string, string> {
  const out = new Map<string, string>();
  const LEAD = 2;
  for (const c of cells) {
    if (!c.chord) continue;
    const t = c.time;
    let placed = false;
    for (let r = 0; r < rows.length && !placed; r++) {
      const row = rows[r];
      if (row.type !== 'text' || !row.words.length) continue;
      if (t < row.start - LEAD) break;
      if (t > row.end) continue;
      let w = 0;
      while (w + 1 < row.words.length && row.words[w + 1].start <= t) w++;
      out.set(`${r}:${w}`, c.chord);
      placed = true;
    }
  }
  return out;
}
