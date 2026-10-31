// Letra: filas, relevo de linea y karaoke (lyrics.md de Android, LyricsLinesAdapter).
import type { VocalActivity } from './vocalActivity.ts';

export interface Word { start: number; end: number; text: string; onset: number }
export interface LyricRow {
  type: 'text' | 'instrumental';
  start: number;
  end: number;
  onset: number;     // inicio corregido de la primera palabra (relevo y karaoke); seek usa start
  voicedEnd: number; // fin de la voz del verso (medido; sin medida = end)
  text: string;
  words: Word[];     // onset de cada palabra = cuando se canta de verdad
}

export const INSTRUMENTAL_GAP_SEC = 8.0;
/** Con la voz medida el hueco es silencio de verdad: basta uno mas corto. */
export const INSTRUMENTAL_GAP_VOICED_SEC = 4.0;
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

type RawW = { start: number; end: number; text: string };
type Seg = { start: number; end: number; text: string; words: RawW[] };

const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').length;
/** Tiempo minimo para cantar una palabra tras una pausa. */
const minRemain = (w: RawW) => 0.08 + 0.03 * letters(w.text);

/** Whisper no deja huecos: el silencio previo se lo come la 1a palabra. Con la voz medida, su
 *  ultimo regreso (o el valle); sin ella, si dura mas de lo estimado, onset = end - estimado. */
export function firstWordOnset(seg: Seg, va: VocalActivity | null = null): number {
  const w = seg.words[0];
  if (!w) return seg.start;
  if (va) {
    // El end de Whisper tampoco es fiable: se busca hasta la 2a palabra
    const to = seg.words.length > 1 ? seg.words[1].start : w.end + 0.4;
    let m = va.lastOnsetIn(w.start, Math.max(w.start, to - 0.05));
    if (!Number.isNaN(m)) return m;
    m = va.innerOnsetIn(w.start, Math.max(w.start, to - 0.05), minRemain(w));
    if (!Number.isNaN(m)) return m;
  }
  return Math.max(w.start, w.end - (0.25 + 0.07 * Math.max(1, letters(w.text))));
}

/** Cuando se canta cada palabra: una pausa a mitad de verso tambien se la come la siguiente. */
export function wordOnsets(seg: Seg, va: VocalActivity | null, first: number): number[] {
  const n = seg.words.length, out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) { out.push(first); continue; }
    const w = seg.words[i];
    let at = w.start;
    if (va) {
      const to = i + 1 < n ? seg.words[i + 1].start : w.end;
      const m = va.innerOnsetIn(w.start, Math.max(w.start, to - 0.05), minRemain(w));
      if (!Number.isNaN(m)) at = m;
    }
    out.push(Math.max(at, out[i - 1]));
  }
  return out;
}

/** Fin de la voz del verso: el tramo con voz de la ultima palabra, sin pasar de `limit` (notas sostenidas). */
export function voicedEnd(seg: Seg, va: VocalActivity | null, limit: number): number {
  const last = seg.words.at(-1);
  if (!va || !last) return seg.end;
  const end = va.voiceEndAfter(last.start, Math.max(last.start, last.end), limit);
  return Number.isNaN(end) ? seg.end : Math.max(last.start + KARAOKE_FADE_SEC, end);
}

// Inicios de frase comunes (es/ca/pt/it/fr/en/de, sin tildes)
const STARTERS = new Set(['y', 'e', 'o', 'que', 'porque', 'pero', 'mas', 'sobre', 'si', 'no',
  'ya', 'yo', 'tu', 'te', 'me', 'mi', 'se', 'es', 'el', 'la', 'los', 'las', 'un', 'una', 'en', 'de', 'con', 'por', 'para', 'cuando',
  'como', 'donde', 'aunque', 'todavia', 'hoy', 'ahora', 'hay', 'eu', 'voce', 'nao', 'ma', 'che', 'io', 'non', 'et', 'je',
  'il', 'elle', 'nous', 'vous', 'per', 'quan',
  'and', 'but', 'so', 'the', 'you', 'we', 'they', 'he', 'she', 'it', 'if', 'when', 'oh', 'now', 'und', 'ich', 'du', 'wir', 'aber']);

/** Palabra sin puntuacion alrededor. */
const bare = (s: string) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();
const stripAccents = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');

/** Whisper a veces une dos frases ("...en pie Porque ya..."): se parte antes de una mayuscula
 *  tras una palabra sin puntuacion final, si no parece nombre propio (inicio comun o la palabra
 *  aparece en minuscula en otra parte de la letra). */
export function splitMergedSentences(segs: Seg[]): Seg[] {
  const lower = new Set<string>();
  for (const s of segs) for (const w of s.words) { const t = bare(w.text); if (t && isLower(t[0])) lower.add(t); }
  const sub = (s: Seg, from: number, to: number): Seg => {
    const words = s.words.slice(from, to);
    return { start: from === 0 ? s.start : words[0].start, end: to === s.words.length ? s.end : words[words.length - 1].end,
      text: words.map((w) => w.text.trim()).filter(Boolean).join(' '), words };
  };
  const out: Seg[] = [];
  for (const s of segs) {
    if (s.words.length < 2) { out.push(s); continue; }
    let from = 0;
    for (let i = 1; i < s.words.length; i++) {
      const prev = s.words[i - 1].text.trim(), t = bare(s.words[i].text);
      const capital = !!t && isUpper(t[0]);
      const prevOpen = !!prev && !'.!?,;:…'.includes(prev[prev.length - 1]);
      if (capital && prevOpen && t.length > 1 && (STARTERS.has(stripAccents(t.toLowerCase())) || lower.has(t.toLowerCase()))) {
        out.push(sub(s, from, i));
        from = i;
      }
    }
    out.push(from === 0 ? s : sub(s, from, s.words.length));
  }
  return out;
}

/** Filas de la letra (LyricsLinesAdapter.setLyrics). `va` = voz medida de la cancion, o null. */
export function buildRows(json: unknown, durationSec: number, va: VocalActivity | null = null): LyricRow[] {
  const segs = splitMergedSentences(sanitize(json).segments);
  const n = segs.length;
  if (!n) return [];
  const onset = segs.map((s) => firstWordOnset(s, va));
  const vEnd = segs.map((s, i) => voicedEnd(s, va, Math.max(i + 1 < n ? onset[i + 1] : durationSec > 0 ? durationSec : s.end + 10, s.end)));
  const minGap = va ? INSTRUMENTAL_GAP_VOICED_SEC : INSTRUMENTAL_GAP_SEC;
  const rows: LyricRow[] = [];
  const gap = (a: number, b: number) => {
    if (b - a >= minGap) rows.push({ type: 'instrumental', start: a, end: b, onset: a, voicedEnd: b, text: '', words: [] });
  };
  let prevEnd = 0;
  segs.forEach((s, i) => {
    gap(prevEnd, onset[i]);
    const on = wordOnsets(s, va, onset[i]);
    rows.push({ type: 'text', start: s.start, end: s.end, onset: onset[i], voicedEnd: vEnd[i], text: s.text, words: s.words.map((w, k) => ({ ...w, onset: on[k] })) });
    prevEnd = vEnd[i];
  });
  if (durationSec > 0) gap(prevEnd, durationSec);
  return rows;
}

/** Momento (s) en que la fila i toma el relevo (lyricsSwitchAt): max(onset - 150 ms, fin de la voz
 *  anterior, su ultima palabra + fade), sin pasar de su onset. */
export function switchAt(rows: LyricRow[], i: number): number {
  const r = rows[i], prev = rows[i - 1];
  let t = r.onset - SWITCH_LEAD_SEC;
  if (prev?.type === 'text') {
    let done = prev.voicedEnd;
    const last = prev.words.at(-1);
    if (last) done = Math.max(done, last.onset + KARAOKE_FADE_SEC);
    t = Math.max(t, done);
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
