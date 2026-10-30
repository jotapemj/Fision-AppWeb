// Playlists (cloud/PlaylistRepository + PlaylistErrors + PlayQueue de Android). Sin DOM.
import type { Playlist } from '../api/client.ts';
import type { Row } from './library.ts';

export const TITLE_MAX = 100, SONG_LIMIT = 2000, PLAYLIST_LIMIT = 200;
export const isValidId = (id: string) => /^[0-9a-f]{12}$/.test(id);

/** Lo que el server rechazaria, comprobado antes de enviar. null = vale. */
export function validate(title: string, songs: string[]): string | null {
  const t = title.trim();
  if (!t) return 'title_empty';
  if (t.length > TITLE_MAX) return 'title_length';
  if (songs.length > SONG_LIMIT) return 'song_limit';
  if (new Set(songs).size !== songs.length) return 'song_duplicate';
  return null;
}

/** Texto de un error: por `code`, nunca el `detail` del server. [clave i18n, argumentos]. */
export function errorKey(status: number, code: string, cover = false): [string, ...(string | number)[]] {
  if (status === 0 || code === 'network') return ['playlist_err_network'];
  if (cover && status === 413) return ['playlist_err_cover_too_large'];
  if (cover && status === 400) return ['playlist_err_cover_format'];
  if (status === 404) return ['playlist_err_gone'];
  switch (code) {
    case 'title_empty': return ['playlist_err_title_empty'];
    case 'title_length': return ['playlist_err_title_length', TITLE_MAX];
    case 'song_not_found': return ['playlist_err_song_not_found'];
    case 'song_duplicate': return ['playlist_err_song_duplicate'];
    case 'song_limit': return ['playlist_err_song_limit', SONG_LIMIT];
    case 'playlist_limit': return ['playlist_err_playlist_limit', PLAYLIST_LIMIT];
    default: return ['playlist_err_generic', status];
  }
}

/** Se pueden anadir las que estan en la nube (isInCloud: descargada, solo nube o bajando). */
export const pickable = (rows: Row[]) => rows.filter((r) => r.state.kind === 'downloaded' || r.state.kind === 'cloud' || r.state.kind === 'downloading');

/** Portadas del mosaico sin portada propia: 4 primeras; con 1-3 canciones, la primera. */
export const mosaicHashes = (songs: string[]) => (songs.length >= 4 ? songs.slice(0, 4) : songs.slice(0, 1));

/** Filas de la playlist en su orden; las que ya no estan en la biblioteca no salen. */
export function playlistRows(p: Playlist, rows: Row[]): Row[] {
  const by = new Map(rows.map((r) => [r.entry.hash, r]));
  return p.songs.map((h) => by.get(h)).filter((r): r is Row => !!r);
}

/** SongOrder.adjacent: con la cancion en la playlist activa, su orden (solo descargadas); si no, la biblioteca. */
export function adjacent(current: string, dir: 1 | -1, library: Row[], queue: string[] | null): string | null {
  const downloaded = new Set(library.filter((r) => r.state.kind === 'downloaded').map((r) => r.entry.hash));
  const order = queue && queue.includes(current) ? queue.filter((h) => downloaded.has(h) || h === current) : library.filter((r) => downloaded.has(r.entry.hash) || r.entry.hash === current).map((r) => r.entry.hash);
  const i = order.indexOf(current);
  return i >= 0 ? order[i + dir] ?? null : null;
}

/** Mover una cancion en la lista (reordenar arrastrando o con teclado). */
export function move<T>(list: T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
  return out;
}
