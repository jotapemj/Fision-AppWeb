// Render offline del export = ExportManager de Android: mezcla stem a stem (volumen + paneo
// por defecto o actuales), FX por stem con su cola (modulo fision_export), metronomo encima,
// recorte de la cola y el mismo limitador que el motor. Tono y tempo NO se aplican (como Android).

/** Lo que se usa del modulo Emscripten de export (engine/export_api.cpp). */
export interface ExportModule {
  FS: { writeFile(p: string, d: Uint8Array): void; unlink(p: string): void };
  HEAPF32: Float32Array;
  stringToNewUTF8(s: string): number;
  _free(p: number): void;
  _fx_decode(path: number): number;
  _fx_pcm(): number;
  _fx_pcm_sr(): number;
  _fx_pcm_ch(): number;
  _fx_pcm_free(): void;
  _fx_src(): number;
  _fx_out(): number;
  _fx_new(sr: number, filter: number, echo: number, echoDelayMs: number, send: number, room: number): number;
  _fx_free(h: number): void;
  _fx_process(h: number, hasSrc: number, frames: number, volL: number, volR: number): void;
}

export interface Pcm { data: Float32Array; sr: number; ch: number; frames: number }
/** FX de un stem ya resueltos (eco en ms con el BPM de la cancion). */
export interface FxParams { filter: number; echo: number; echoMs: number; reverb: number; room: number }

const CHUNK = 4096;               // StemFxOffline.CHUNK
export const TAIL_SECONDS = 6;    // sitio para la cola de eco y reverb
const TAIL_FLOOR = 1e-4;          // por debajo, la cola es silencio (~-80 dBFS)

export const fxIsActive = (f: FxParams | null | undefined): f is FxParams => !!f && (f.filter !== 0 || f.echo > 0 || f.reverb > 0);
export const fxHasTail = (f: FxParams | null | undefined) => !!f && (f.echo > 0 || f.reverb > 0);

/** Volumen + paneo como balance (ExportManager.mixOneStem; DEFAULT = 0.75 los dos). */
export function stemGains(volume: number, pan: number): [number, number] {
  const v = volume * 0.01;
  if (pan > 0) return [v * (100 - pan) * 0.01, v];
  if (pan < 0) return [v, v * (100 - Math.abs(pan)) * 0.01];
  return [v, v];
}

/** FLAC o WAV -> float intercalado (dr_flac / WavReader del motor). */
export function decode(M: ExportModule, name: string, bytes: Uint8Array): Pcm {
  const path = `/x_${name}`;
  M.FS.writeFile(path, bytes);
  const p = M.stringToNewUTF8(path);
  const frames = M._fx_decode(p);
  M._free(p);
  M.FS.unlink(path);
  if (!frames) throw new Error(`decode_failed:${name}`);
  const ch = M._fx_pcm_ch(), sr = M._fx_pcm_sr(), ptr = M._fx_pcm() >> 2;
  const data = M.HEAPF32.slice(ptr, ptr + frames * ch);
  M._fx_pcm_free();
  return { data, sr, ch, frames };
}

/** Suma el stem seco a `out` (estereo). */
function addDry(pcm: Pcm, out: Float32Array, volL: number, volR: number) {
  const { data: d, ch } = pcm, n = Math.min(pcm.frames, out.length >> 1);
  for (let f = 0; f < n; f++) {
    const l = d[f * ch], r = ch === 1 ? l : d[f * ch + 1];
    out[2 * f] += l * volL;
    out[2 * f + 1] += r * volR;
  }
}

/** StemFxOffline.mixInto: el stem por sus FX, a trozos, seguido de su cola (hasta 6 s). */
export function addWithFx(M: ExportModule, pcm: Pcm, fx: FxParams, out: Float32Array, volL: number, volR: number) {
  const h = M._fx_new(pcm.sr, fx.filter, fx.echo, fx.echoMs, Math.min(1, fx.reverb), fx.room);
  try {
    const outFrames = out.length >> 1, n = Math.min(pcm.frames, outFrames), { data: d, ch } = pcm;
    const tailEnd = Math.min(outFrames, n + Math.floor(TAIL_SECONDS * pcm.sr));
    for (let f = 0, k = 0; f < tailEnd; f += k) {
      const hasSrc = f < n;
      k = Math.min(CHUNK, (hasSrc ? n : tailEnd) - f); // el ultimo trozo del stem no se mezcla con la cola
      if (hasSrc) {
        const src = M.HEAPF32, s = M._fx_src() >> 2;
        for (let i = 0; i < k; i++) { const l = d[(f + i) * ch]; src[s + 2 * i] = l; src[s + 2 * i + 1] = ch === 1 ? l : d[(f + i) * ch + 1]; }
      }
      M._fx_process(h, hasSrc ? 1 : 0, k, volL, volR);
      const o = M._fx_out() >> 2, heap = M.HEAPF32;
      for (let i = 0; i < 2 * k; i++) out[2 * f + i] += heap[o + i];
    }
  } finally { M._fx_free(h); }
}

/** Corta tras la ultima muestra audible, nunca por debajo de `minSamples` (la cancion). */
export function trimTail(buf: Float32Array, minSamples: number, ch: number): Float32Array {
  let last = buf.length - 1;
  while (last >= minSamples && Math.abs(buf[last]) < TAIL_FLOOR) last--;
  let len = Math.max(minSamples, last + 1);
  len = Math.min(buf.length, Math.ceil(len / ch) * ch);
  return len === buf.length ? buf : buf.slice(0, len);
}

/** Mismo limitador que la salida del motor: lineal hasta 0.7, curva hasta 1, techo 0.95. */
export function softLimit(buf: Float32Array) {
  const thr = 0.7, ceil = 0.95, span = 1 - thr, delta = ceil - thr;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i], a = Math.abs(x);
    if (a <= thr) continue;
    if (a >= 1) { buf[i] = Math.sign(x) * ceil; continue; }
    const over = (a - thr) / span;
    buf[i] = Math.sign(x) * (thr + delta * (1 - (1 - over) * (1 - over)));
  }
}

export interface MixStem { name: string; bytes: Uint8Array; volL: number; volR: number; fx: FxParams | null }
export interface Metronome { name: string; bytes: Uint8Array; volume: number } // volume 0..1
export interface Rendered { samples: Float32Array; sr: number; ch: number }

/** Suma el metronomo (sin paneo) a los primeros `maxFrames`. */
function addMetronome(M: ExportModule, m: Metronome, out: Float32Array, maxFrames: number) {
  const pcm = decode(M, m.name, m.bytes);
  addDry({ ...pcm, frames: Math.min(pcm.frames, maxFrames) }, out, m.volume, m.volume);
}

/** ExportManager.mixStems: un stem cada vez (la memoria no pasa de un stem + la mezcla). */
export function mixdown(M: ExportModule, stems: MixStem[], metro: Metronome | null, progress: (k: number) => void = () => {}): Rendered {
  if (!stems.length) throw new Error('no_stems');
  const tailOn = stems.some((s) => fxHasTail(s.fx));
  let out: Float32Array | null = null, sr = 0, maxFrames = 0, tail = 0;
  stems.forEach((s, i) => {
    const pcm = decode(M, s.name, s.bytes);
    if (!out) { sr = pcm.sr; tail = tailOn ? Math.floor(TAIL_SECONDS * sr) : 0; out = new Float32Array((pcm.frames + tail) * 2); }
    if ((pcm.frames + tail) * 2 > out.length) { const big = new Float32Array((pcm.frames + tail) * 2); big.set(out); out = big; }
    maxFrames = Math.max(maxFrames, pcm.frames);
    if (fxIsActive(s.fx)) addWithFx(M, pcm, s.fx, out, s.volL, s.volR); else addDry(pcm, out, s.volL, s.volR);
    progress((i + 1) / stems.length);
  });
  if (metro) addMetronome(M, metro, out!, maxFrames);
  const samples = trimTail(out!, maxFrames * 2, 2);
  softLimit(samples);
  return { samples, sr, ch: 2 };
}

/** Un stem a volumen 1 por sus FX (estereo, con su cola) y, si se pide, el metronomo encima. */
export function renderStem(M: ExportModule, s: { name: string; bytes: Uint8Array; fx: FxParams | null }, metro: Metronome | null): Rendered {
  const pcm = decode(M, s.name, s.bytes);
  if (!fxIsActive(s.fx) && !metro) return { samples: pcm.data, sr: pcm.sr, ch: pcm.ch }; // tal cual
  const tail = fxHasTail(s.fx) ? Math.floor(TAIL_SECONDS * pcm.sr) : 0;
  let out: Float32Array = new Float32Array((pcm.frames + tail) * 2);
  if (fxIsActive(s.fx)) { addWithFx(M, pcm, s.fx, out, 1, 1); out = trimTail(out, pcm.frames * 2, 2); }
  else addDry(pcm, out, 1, 1);
  if (metro) addMetronome(M, metro, out, pcm.frames);
  softLimit(out);
  return { samples: out, sr: pcm.sr, ch: 2 };
}

/** WAV PCM16 (WavIO.writePcm16). */
export function wavPcm16({ samples, sr, ch }: Rendered): Uint8Array {
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, Math.round(x * 32767), true); }
  return new Uint8Array(buf);
}

/** Nombre sin caracteres que FAT/exFAT no admite (ExportManager.sanitize). */
export const sanitize = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim();
/** yyyyMMdd_HHmmss local: un export nunca pisa otro. */
export function timestamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
/** "Artista - Titulo" (buildExportDisplayName); sin los dos, el nombre del fichero. */
export const displayName = (title: string, artist: string, filename: string) =>
  title && artist ? `${artist} - ${title}` : (title || filename.replace(/\.[^.]+$/, '') || 'Export');
