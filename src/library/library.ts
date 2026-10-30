// Biblioteca: estado unificado por cancion (CloudRepository de Android), busqueda y filtro.
import type { LibraryEntry, LiveJob } from '../api/client.ts';

export type RowState =
  | { kind: 'downloaded' }
  | { kind: 'cloud' }
  | { kind: 'downloading'; pct: number }
  | { kind: 'queued'; position: number | null }
  | { kind: 'running' }
  | { kind: 'waiting_gpu' }
  | { kind: 'error'; code?: string };

export interface Row { entry: LibraryEntry; state: RowState }

export type Filter = 'all' | 'downloaded' | 'cloud';

export interface LibraryInput {
  entries: LibraryEntry[];
  downloaded: Set<string>;
  downloading: Map<string, number>; // hash -> 0..100
  jobs: LiveJob[];
  errors?: Map<string, string>; // hash -> error_code del ultimo job (en memoria, como Android)
}

function stateOf(e: LibraryEntry, inp: LibraryInput): RowState {
  const pct = inp.downloading.get(e.hash);
  if (pct !== undefined) return { kind: 'downloading', pct };
  // Lo que procesa el server manda sobre la copia local (reproceso en curso)
  const job = inp.jobs.find((j) => j.hash === e.hash && ['queued', 'running', 'waiting_gpu'].includes(j.state));
  if (job?.state === 'queued') return { kind: 'queued', position: job.position };
  if (job?.state === 'running') return { kind: 'running' };
  if (job?.state === 'waiting_gpu') return { kind: 'waiting_gpu' };
  if (inp.downloaded.has(e.hash)) return { kind: 'downloaded' };
  if (e.state === 'processing') return { kind: 'running' };
  if (e.state === 'error' || e.state === 'cancelled') return { kind: 'error', code: inp.errors?.get(e.hash) };
  return { kind: 'cloud' };
}

const busy = (s: RowState) => s.kind === 'queued' || s.kind === 'running' || s.kind === 'waiting_gpu';

/** Arriba lo que procesa el server; el resto por fecha de creacion (songs_sort_order), desempate por hash. */
export function buildRows(inp: LibraryInput, asc = false): Row[] {
  return inp.entries
    .map((entry) => ({ entry, state: stateOf(entry, inp) }))
    .sort((a, b) => Number(busy(b.state)) - Number(busy(a.state))
      || (asc ? a.entry.created_at.localeCompare(b.entry.created_at) : b.entry.created_at.localeCompare(a.entry.created_at))
      || a.entry.hash.localeCompare(b.entry.hash));
}

/** Sin tildes ni mayusculas (MainActivity.SearchBar). */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function search(rows: Row[], q: string): Row[] {
  const f = fold(q.trim());
  if (!f) return rows;
  return rows.filter((r) => fold(`${r.entry.title} ${r.entry.artist}`).includes(f));
}

export const isCloud = (s: RowState) => s.kind === 'cloud' || s.kind === 'downloading';

/** Que hace "Borrar" segun el estado (MainActivity.showBottomDialog / runDelete):
 *  en cola = sacarla de la cola; con copia = borrar la copia (sigue en la nube); solo en el server =
 *  DELETE /library/{h}; procesando o bajando = bloqueado (null). */
export type DeleteKind = 'queue' | 'local' | 'cloud';
export function deleteKind(s: RowState): DeleteKind | null {
  if (s.kind === 'queued') return 'queue';
  if (s.kind === 'downloaded') return 'local';
  if (s.kind === 'cloud' || s.kind === 'error') return 'cloud';
  return null;
}

export function applyFilter(rows: Row[], f: Filter): Row[] {
  if (f === 'downloaded') return rows.filter((r) => r.state.kind === 'downloaded');
  if (f === 'cloud') return rows.filter((r) => isCloud(r.state));
  return rows;
}

/** El filtro solo aparece si hay descargadas y en la nube a la vez. */
export function counts(rows: Row[]) {
  const downloaded = rows.filter((r) => r.state.kind === 'downloaded').length;
  const cloud = rows.filter((r) => isCloud(r.state)).length;
  return { all: rows.length, downloaded, cloud, showFilter: downloaded > 0 && cloud > 0 };
}
