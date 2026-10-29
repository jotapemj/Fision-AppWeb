// Letra: filas, relevo de linea y karaoke (lyrics.md de Android).
// Fuera por ahora: VocalActivity (onsets por envolvente) y splitMergedSentences.

export interface Word { start: number; end: number; text: string; onset: number }
export interface LyricRow {
  type: 'text' | 'instrumental';
  start: number;
  end: number;
  onset: number;    // inicio corregido de la primera palabra (relevo y karaoke); seek usa start
  text: string;
  words: Word[];
}

export const INSTRUMENTAL_GAP_SEC = 8.0;
export const KARAOKE_FADE_SEC = 0.25;
const SWITCH_LEAD_SEC = 0.15;
const LAST_LINE_HOLD_SEC = 2;
/** Reloj de letra = posicion percibida + 130 - 80 ms (LYRICS_WORD_DELAY_MS). */
export const LYRICS_CLOCK_OFFSET_MS = 130 - 80;

interface RawWord { start?: unknown; end?: unknown; text?: unknown }
interface RawSeg { start?: unknown; end?: unknown; text?: unknown; words?: unknown }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Lyrics.sanitize: fuera segmentos y palabras nulos o con tiempos no finitos. */
export function sanitize(json: unknown): { segments: { start: number; end: number; text: string; words: { start: number; end: number; text: string }[] }[] } {
  const segs = Array.isArray((json as { segments?: unknown })?.segments) ? (json as { segments: unknown[] }).segments : [];
  const out = [];
  for (const s of segs as RawSeg[]) {
    if (!s || typeof s !== 'object') continue;
    const start = num(s.start), end = num(s.end);
    if (start === null || end === null) continue;
    const words = (Array.isArray(s.words) ? (s.words as RawWord[]) : [])
      .filter((w) => w && num(w.start) !== null && num(w.end) !== null && typeof w.text === 'string')
      .map((w) => ({ start: w.start as number, end: w.end as number, text: (w.text as string).trim() }))
      .filter((w) => w.text);
    out.push({ start, end, text: typeof s.text === 'string' ? s.text.trim() : words.map((w) => w.text).join(' '), words });
  }
  return { segments: out.sort((a, b) => a.start - b.start) };
}

/** Whisper no deja huecos: el silencio previo se lo come la 1a palabra. Si dura mas de lo estimado, onset = end - estimado. */
export function firstWordOnset(w: { start: number; end: number; text: string }): number {
  const est = 0.25 + 0.07 * w.text.replace(/[^\p{L}\p{N}]/gu, '').length;
  return w.end - w.start > est ? w.end - est : w.start;
}

export function buildRows(json: unknown, durationSec: number): LyricRow[] {
  const { segments } = sanitize(json);
  const rows: LyricRow[] = [];
  let prevEnd = 0;
  const gap = (a: number, b: number) => {
    if (b - a >= INSTRUMENTAL_GAP_SEC) rows.push({ type: 'instrumental', start: a, end: b, onset: a, text: '', words: [] });
  };
  for (const s of segments) {
    gap(prevEnd, s.start);
    const words: Word[] = s.words.map((w, i) => ({ ...w, onset: i === 0 ? firstWordOnset(w) : w.start }));
    rows.push({ type: 'text', start: s.start, end: s.end, onset: words[0]?.onset ?? s.start, text: s.text, words });
    prevEnd = Math.max(prevEnd, s.end);
  }
  if (segments.length) gap(prevEnd, durationSec);
  return rows;
}

/** Momento (s) en que la fila i toma el relevo: max(onset - 150 ms, fin anterior, ultima palabra anterior + fade), sin pasar de su onset. */
export function switchAt(rows: LyricRow[], i: number): number {
  const r = rows[i], prev = rows[i - 1];
  let t = r.onset - SWITCH_LEAD_SEC;
  if (prev?.type === 'text') {
    t = Math.max(t, prev.end);
    const last = prev.words.at(-1);
    if (last) t = Math.max(t, last.onset + KARAOKE_FADE_SEC);
  }
  return Math.max(0, Math.min(t, r.onset));
}

/** Fila activa para el reloj de letra `t` (s), o -1. */
export function activeRow(rows: LyricRow[], t: number): number {
  let i = -1;
  for (let k = 0; k < rows.length; k++) { if (switchAt(rows, k) <= t) i = k; else break; }
  if (i < 0) return -1;
  const r = rows[i];
  if (r.type === 'instrumental' && t > r.end) return -1;
  if (i === rows.length - 1 && r.type === 'text' && t > r.end + LAST_LINE_HOLD_SEC) return -1;
  return i;
}

/** Progreso 0..1 del fundido gris -> acento de una palabra. */
export const wordProgress = (w: Word, t: number) => Math.min(1, Math.max(0, (t - w.onset) / KARAOKE_FADE_SEC));

export const hasWords = (rows: LyricRow[]) => rows.some((r) => r.words.length > 0);
