// Lado de la pagina del export: carpeta de destino (elegida una vez, como Music/Fision de Android),
// subcarpeta "Artista - Titulo" y el Worker. Sin File System Access (otros navegadores): descarga.
import type { ExportJob, FromWorker, ToWorker } from './job.ts';

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'readwrite' }): Promise<PermissionState>;
};
type PickerWindow = Window & { showDirectoryPicker?(o: { id?: string; mode?: 'readwrite'; startIn?: string }): Promise<DirHandle> };

const DB = 'fision-export', STORE = 'kv', KEY = 'dir';

export const canPickFolder = () => typeof (window as PickerWindow).showDirectoryPicker === 'function';

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((res) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onerror = () => res(undefined);
    r.onsuccess = () => {
      try { const q = fn(r.result.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }
      catch { res(undefined); }
    };
  });
}

/** Carpeta guardada (sin pedir permiso): para rotularla en el dialogo. */
export const savedFolder = () => idb<DirHandle>('readonly', (s) => s.get(KEY)).then((h) => h ?? null);

/** Carpeta con permiso de escritura: la guardada (pide permiso si hace falta) o una nueva.
 *  `pick` = elegir otra. null = el usuario cancelo. Llamar dentro del clic (gesto). */
export async function folder(pick = false): Promise<DirHandle | null> {
  let h = pick ? null : await savedFolder();
  if (h) {
    let st = await h.queryPermission({ mode: 'readwrite' }).catch(() => 'denied' as PermissionState);
    if (st !== 'granted') st = await h.requestPermission({ mode: 'readwrite' }).catch(() => 'denied' as PermissionState);
    if (st === 'granted') return h;
  }
  try { h = await (window as PickerWindow).showDirectoryPicker!({ id: 'fision-export', mode: 'readwrite', startIn: 'music' }); }
  catch { return null; }
  await idb('readwrite', (s) => s.put(h, KEY));
  return h;
}

/** Destino de un export: subcarpeta de la cancion dentro de la carpeta, o descarga. */
export interface Sink { write(name: string, data: Uint8Array): Promise<void> }

export async function folderSink(dir: FileSystemDirectoryHandle | null, song: string): Promise<Sink> {
  if (!dir) return { write: async (name, data) => download(name, data) };
  const sub = await dir.getDirectoryHandle(song, { create: true });
  return {
    async write(name, data) {
      const f = await (await sub.getFileHandle(name, { create: true })).createWritable();
      try { await f.write(data as BufferSource); await f.close(); }
      catch (e) { await f.abort().catch(() => {}); throw e; }
    },
  };
}

function download(name: string, data: Uint8Array) {
  const url = URL.createObjectURL(new Blob([data as BlobPart]));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface Running { done: Promise<number>; cancel(): void }

/** Lanza el Worker; cada fichero se escribe al llegar. cancel() lo termina (done -> 'cancelled'). */
export function runExport(job: ExportJob, sink: Sink, onProgress: (pct: number) => void): Running {
  const w = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
  let reject: (e: Error) => void = () => {};
  const done = new Promise<number>((res, rej) => {
    reject = rej;
    let writes = Promise.resolve();
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.pct);
      else if (m.type === 'file') writes = writes.then(() => sink.write(m.name, m.data));
      else if (m.type === 'done') writes.then(() => res(m.count), rej).finally(() => w.terminate());
      else { w.terminate(); rej(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message || 'worker')); };
  });
  const glue = new URL(`${import.meta.env.BASE_URL}engine/fision_export.mjs`, location.href).href;
  // Los bytes de los stems se transfieren (no se copian)
  const bufs = job.kind === 'stem' ? [job.stem.bytes.buffer] : job.stems.map((s) => s.bytes.buffer);
  if (job.kind !== 'separate' && job.metro) bufs.push(job.metro.bytes.buffer);
  w.postMessage({ type: 'run', job, glue } satisfies ToWorker, [...new Set(bufs)] as Transferable[]);
  return { done, cancel: () => { w.terminate(); reject(new Error('cancelled')); } };
}
