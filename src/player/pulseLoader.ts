// BeatPulseMap.loadOrAnalyze: mapa guardado con la cancion, o se mide en un Worker y se guarda.
// null = no se puede analizar (o se cancelo): el pulso sigue siempre encendido.
import type { SongStore } from '../lib/songStore.ts';
import { BeatPulseMap, drumFiles, MIN_BEATS, PULSE_FILE, signature } from './beatPulseMap.ts';

export async function loadPulseMap(store: SongStore, hash: string, beats: readonly number[], signal: AbortSignal): Promise<BeatPulseMap | null> {
  if (beats.length < MIN_BEATS) return null;
  const stats = await store.fileStats(hash);
  const drums = drumFiles(stats.map((s) => s.name));
  if (!drums.length) return null;
  const sig = signature(drums.map((n) => stats.find((s) => s.name === n)!), beats.length);
  const cached = BeatPulseMap.parse(await store.getText(hash, PULSE_FILE), sig);
  if (cached || signal.aborted) return cached;

  const files = await store.load(hash, (n) => drums.includes(n));
  if (signal.aborted) return null;
  const power = await measure(files, beats, signal);
  if (!power) return null;
  const map = BeatPulseMap.fromPower(power, beats);
  // Lo mejor posible: sin cache, la cancion se mide otra vez
  await store.putFile(hash, PULSE_FILE, new TextEncoder().encode(map.serialize(sig))).catch(() => {});
  return map;
}

function measure(files: { name: string; data: Uint8Array }[], beats: readonly number[], signal: AbortSignal) {
  return new Promise<Float64Array | null>((resolve) => {
    const w = new Worker(new URL('./pulse.worker.ts', import.meta.url), { type: 'module' });
    const end = (p: Float64Array | null) => { w.terminate(); resolve(p); };
    signal.addEventListener('abort', () => end(null), { once: true });
    w.onmessage = (e: MessageEvent<{ power: Float64Array | null }>) => end(e.data.power);
    w.onerror = () => end(null);
    const glue = new URL(`${import.meta.env.BASE_URL}engine/fision_export.mjs`, location.href).href;
    const payload = files.map((f) => ({ name: f.name, bytes: f.data }));
    w.postMessage({ glue, beats: [...beats], files: payload }, payload.map((f) => f.bytes.buffer as ArrayBuffer));
  });
}
