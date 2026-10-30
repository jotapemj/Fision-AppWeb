// Diagramas de acordes (paquete chords de Android): ChordSymbol, ChordShapes, VoicingPicker y
// PianoVoicing. Datos: chords-db (MIT, David Rubert) en public/chords. Sin DOM.
import type { BeatCell } from './chords.ts';

export const MAJOR = 'major', MINOR = 'minor';

/** Acorde reducido a clase de altura de la raiz, calidad (sufijo de chords-db) y bajo (-1 = la raiz). */
export interface ChordSymbol { root: number; quality: string; bass: number }

const mod12 = (v: number) => ((v % 12) + 12) % 12;

/** Clase de altura de la nota al principio de `s` ("C", "F#", "Bb") y cuantos caracteres ocupa. */
export function pitchClass(s: string): [number, number] {
  if (!s) return [-1, 0];
  const base = ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as Record<string, number>)[s[0].toUpperCase()];
  if (base === undefined) return [-1, 0];
  const acc = s[1];
  if (acc === '#' || acc === '♯') return [mod12(base + 1), 2];
  if (acc === 'b' || acc === '♭') return [mod12(base - 1), 2];
  return [base, 1];
}

/** Sufijo de la app / BTC -> sufijo de chords-db; lo desconocido cae a la triada por la que empieza. */
export function normalizeQuality(q: string): string {
  switch (q) {
    case '': case 'maj': return MAJOR;
    case 'm': case 'min': return MINOR;
    case '7': case 'm7': case 'maj7': case '6': case 'm6': case 'm7b5': case 'dim': case 'dim7': case 'aug':
    case 'sus2': case 'sus4': case 'mmaj7': case '9': case 'm9': case 'add9': return q;
    case 'hdim7': return 'm7b5';
    case 'minmaj7': case 'mM7': return 'mmaj7';
    case 'sus': return 'sus4';
    case 'min7': return 'm7';
    case 'min6': return 'm6';
    case 'maj6': return '6';
    default: return q.startsWith('m') && !q.startsWith('maj') ? MINOR : MAJOR;
  }
}

/** chords.txt ("F#;7", "Am7b5/G", "N") transpuesto `semi`; null = no suena acorde. */
export function parseSymbol(raw: string | null, semi = 0): ChordSymbol | null {
  if (raw == null) return null;
  let s = raw.replace(/;/g, '').trim();
  if (!s || s === 'N' || s === 'X') return null;
  let bassPart: string | null = null;
  const slash = s.indexOf('/');
  if (slash >= 0) { bassPart = s.slice(slash + 1); s = s.slice(0, slash); }
  const [root, len] = pitchClass(s);
  if (root < 0) return null;
  let bass = -1;
  if (bassPart != null) { const [b] = pitchClass(bassPart); if (b >= 0 && b !== root) bass = mod12(b + semi); }
  return { root: mod12(root + semi), quality: normalizeQuality(s.slice(len)), bass };
}

/** Una forma de tocarlo. Trastes relativos a baseFret (1 = baseFret), 0 al aire, -1 muda. */
export interface Position {
  frets: number[];
  fingers: number[] | null;
  baseFret: number;
  barres: number[];
  handFret: number;   // traste absoluto pisado mas bajo (0 = todo al aire)
  difficulty: number; // dedos + cejilla 1.5 + apertura 0.5 + mudas 0.3
}

export function makePosition(frets: number[], fingers: number[] | null, baseFret: number, barres: number[]): Position {
  let lo = Infinity, hi = 0, muted = 0;
  const used = new Set<number>();
  frets.forEach((f, i) => {
    if (f < 0) { muted++; return; }
    if (f === 0) return;
    const abs = baseFret + f - 1;
    lo = Math.min(lo, abs); hi = Math.max(hi, abs);
    if (fingers && i < fingers.length && fingers[i] > 0) used.add(fingers[i]);
  });
  const handFret = lo === Infinity ? 0 : lo, span = lo === Infinity ? 0 : hi - lo;
  // Aritmetica float32 como Java (el coste decide empates)
  const f = Math.fround;
  const difficulty = f(f(f(used.size + (barres.length ? 1.5 : 0)) + f(span * 0.5)) + f(muted * f(0.3)));
  return { frets, fingers, baseFret, barres, handFret, difficulty };
}

export interface Shape { positions: Position[]; bassShown: boolean }

export type Instrument = 'piano' | 'guitar' | 'ukulele';
export const STRINGS: Record<'guitar' | 'ukulele', number> = { guitar: 6, ukulele: 4 };

interface DbPosition { frets: number[]; fingers?: number[]; baseFret?: number; barres?: number[] }
interface Db { chords: Record<string, { key: string; suffix: string; positions: DbPosition[] }[]> }

export class ChordShapes {
  private index = new Map<string, Position[]>();

  constructor(db: Db) {
    for (const list of Object.values(db.chords)) for (const c of list) {
      const [pc] = pitchClass(c.key);
      if (pc < 0) continue;
      let quality = c.suffix, bass = -1;
      const slash = c.suffix.indexOf('/');
      // Inversiones (/E, m/G): se indexan con su bajo
      if (slash >= 0) {
        const q = c.suffix.slice(0, slash);
        quality = q === '' ? MAJOR : q === 'm' ? MINOR : q;
        [bass] = pitchClass(c.suffix.slice(slash + 1));
        if (bass < 0 || bass === pc) bass = -1;
      }
      const list2 = c.positions.map((p) => makePosition(p.frets, p.fingers ?? null, p.baseFret ?? 1, p.barres ?? []));
      if (list2.length) this.index.set(`${pc}|${quality}|${bass}`, list2);
    }
  }

  /** Exacto -> sin el bajo de la inversion -> triada. */
  find(c: ChordSymbol | null): Shape | null {
    if (!c) return null;
    let p = this.index.get(`${c.root}|${c.quality}|${c.bass}`);
    if (p) return { positions: p, bassShown: true };
    p = this.index.get(`${c.root}|${c.quality}|-1`);
    if (!p) p = this.index.get(`${c.root}|${c.quality.startsWith('m') && !c.quality.startsWith('maj') ? MINOR : MAJOR}|-1`);
    return p ? { positions: p, bassShown: c.bass < 0 } : null;
  }
}

/** Zonas del mastil: Abierta, 3-7, 7-12, Auto. */
export const ZONES = [[0, 4], [3, 7], [7, 12], [0, 12]] as const;
export const ZONE_AUTO = 3;

const inZone = (p: Position, z: number) => (z === 0 ? p.baseFret === 1 && p.handFret <= ZONES[0][1] : p.handFret >= ZONES[z][0] && p.handFret <= ZONES[z][1]);

/** VoicingPicker.pick: la mas facil dentro de la zona; Auto = la que menos mueve la mano. */
export function pickVoicing(shape: Shape | null, zone: number, prev: Position | null): Position | null {
  if (!shape || !shape.positions.length) return null;
  const all = shape.positions, f = Math.fround;
  let best: Position | null = null, bestCost = Infinity;
  if (zone === ZONE_AUTO) {
    if (!prev) return pickVoicing(shape, 0, null);
    for (const p of all) { const c = f(f(Math.abs(p.handFret - prev.handFret) * f(1.2)) + f(p.difficulty * f(0.6))); if (c < bestCost) { bestCost = c; best = p; } }
    return best;
  }
  for (const p of all) {
    if (!inZone(p, zone)) continue;
    const c = f(p.difficulty + f(p.handFret * f(0.05)));
    if (c < bestCost) { bestCost = c; best = p; }
  }
  if (best) return best;
  // Nada en la zona: la mas cercana a ella
  const [from, to] = ZONES[zone];
  for (const p of all) {
    const d = p.handFret < from ? from - p.handFret : p.handFret > to ? p.handFret - to : 0;
    const c = f(d * 2 + p.difficulty);
    if (c < bestCost) { bestCost = c; best = p; }
  }
  return best;
}

export const PIANO_KEYS = 24;
const INTERVALS: Record<string, number[]> = {
  [MINOR]: [0, 3, 7], dim: [0, 3, 6], dim7: [0, 3, 6, 9], aug: [0, 4, 8], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], m7b5: [0, 3, 6, 10], mmaj7: [0, 3, 7, 11],
  sus2: [0, 2, 7], sus4: [0, 5, 7], '9': [0, 4, 7, 10, 14], m9: [0, 3, 7, 10, 14], add9: [0, 4, 7, 14],
};

/** PianoVoicing.keys: teclas 0..23 (C = 0); el bajo abajo y el resto encima; novenas una octava arriba si caben. */
export function pianoKeys(c: ChordSymbol | null): number[] {
  if (!c) return [];
  const iv = INTERVALS[c.quality] ?? [0, 4, 7], bass = c.bass >= 0 ? c.bass : c.root, out = new Set([bass]);
  for (const i of iv) {
    const pc = (c.root + i) % 12;
    if (pc === bass && i < 12) continue;
    let k = bass + mod12(pc - bass);
    if (k === bass) k += 12;
    if (i >= 12 && k + 12 < PIANO_KEYS) k += 12;
    if (k < PIANO_KEYS) out.add(k);
  }
  return [...out].sort((a, b) => a - b);
}

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LATIN_SHARP = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
const LATIN_FLAT = ['Do', 'Reb', 'Re', 'Mib', 'Mi', 'Fa', 'Solb', 'Sol', 'Lab', 'La', 'Sib', 'Si'];
/** ChordFormatter.noteName. */
export const noteName = (pc: number, latin: boolean, flat: boolean) => (latin ? (flat ? LATIN_FLAT : LATIN_SHARP) : (flat ? FLAT : SHARP))[mod12(pc)];

/** Un cambio de acorde: beat donde empieza y simbolo crudo. */
export interface Change { beat: number; raw: string; position: Position | null }

/** Linea de tiempo desde las celdas (cada una lleva el acorde solo donde empieza), sin repetidos seguidos. */
export function chordChanges(cells: BeatCell[]): Change[] {
  const out: Change[] = [];
  let last: string | null = null;
  cells.forEach((c, i) => { if (c.chord && c.chord !== last) { out.push({ beat: i, raw: c.chord, position: null }); last = c.chord; } });
  return out;
}

/** Posicion por cambio, en orden de cancion (Auto determinista ante seeks). */
export function assignVoicings(changes: Change[], shapes: ChordShapes | null, zone: number, semi: number) {
  let prev: Position | null = null;
  for (const c of changes) {
    c.position = shapes ? pickVoicing(shapes.find(parseSymbol(c.raw, semi)), zone, prev) : null;
    if (c.position) prev = c.position;
  }
}

/** Indice del cambio que suena en el beat (-1 = antes del primero). */
export function changeAt(changes: Change[], beat: number): number {
  let idx = -1;
  for (let i = 0; i < changes.length && changes[i].beat <= beat; i++) idx = i;
  return idx;
}
