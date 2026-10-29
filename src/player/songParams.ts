// Mezcla por cancion (tabla songParameters de Android). Solo local: movil y PC no la comparten.
// Stems como StemSettingsCodec: {"<stem>": {"v": 75, "p": 0}} solo con claves no default.
import type { MetroSpeed, Player } from './player.ts';
import { DEFAULT_VOLUME } from './stems.ts';

export interface SongParams {
  stems: Record<string, { v?: number; p?: number }>;
  pitch: number;
  tempoMilli: number;      // Tempo mult milli (1000 = 1x)
  metroOn: boolean;
  metroSpeed: MetroSpeed;  // Selected metronome (default 1 = 1x)
  metroVolume: number;     // default 100
  metroHalfB: boolean;     // Metronome half variant (0 = A)
  chordsBasic?: boolean;   // Chords basic mode
}

export function capture(p: Player): SongParams {
  const stems: SongParams['stems'] = {};
  for (const s of p.stems) {
    const e: { v?: number; p?: number } = {};
    if (s.volume !== DEFAULT_VOLUME) e.v = s.volume;
    if (s.pan !== 0) e.p = s.pan;
    if (Object.keys(e).length) stems[s.stem] = e;
  }
  return { stems, pitch: p.pitch, tempoMilli: Math.round(p.tempoMult * 1000), metroOn: p.metroOn,
    metroSpeed: p.metroSpeed, metroVolume: p.metroVolume, metroHalfB: p.metroHalfB, chordsBasic: p.chordsBasic };
}

const n = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);

/** Aplica lo guardado; lo que falte o no cuadre se queda en su default. */
export function restore(p: Player, saved: unknown) {
  if (!saved || typeof saved !== 'object') return;
  const sp = saved as Partial<SongParams>;
  for (const s of p.stems) {
    const e = sp.stems?.[s.stem];
    if (!e) continue;
    s.pan = Math.max(-100, Math.min(100, n(e.p, 0)));
    p.setVolume(s.stem, n(e.v, DEFAULT_VOLUME)); // aplica tambien el paneo
  }
  if (n(sp.pitch, 0)) p.setPitch(n(sp.pitch, 0));
  const tm = n(sp.tempoMilli, 1000);
  if (tm !== 1000) p.setTempoMult(tm / 1000);
  const speed = [0, 1, 2].includes(sp.metroSpeed as number) ? (sp.metroSpeed as MetroSpeed) : 1;
  p.setMetronome(sp.metroOn === true, speed, n(sp.metroVolume, 100));
  if (sp.metroHalfB === true) p.setHalfVariantB(true);
  if (sp.chordsBasic === true) p.chordsBasic = true;
}

/** Almacen clave/valor (IndexedDB en el navegador; en memoria en las pruebas). */
export interface ParamsStore { get(key: string): Promise<unknown>; put(key: string, v: SongParams): Promise<void> }

export function idbParamsStore(dbName = 'fision', store = 'songParams'): ParamsStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(dbName, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(store);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const d = await db();
    return new Promise<T>((res, rej) => { const q = fn(d.transaction(store, mode).objectStore(store)); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  };
  return {
    get: (key) => tx('readonly', (s) => s.get(key)).catch(() => null),
    put: async (key, v) => { await tx('readwrite', (s) => s.put(v, key)).catch(() => undefined); },
  };
}
