// Cliente HTTP de FisionServer (contrato: docs/REFERENCE.md del server, API 2.x).
// Errores por `code`; nunca mostrar `detail` al usuario.

export interface Session { token: string; user: string; expiresAt: string }

export interface LibraryEntry {
  hash: string;
  filename: string;
  title: string;
  artist: string;
  cover_url: string | null;
  state: 'ready' | 'processing' | 'error' | 'cancelled';
  config?: Record<string, unknown>; // config_json vigente (para reprocesar o reintentar)
  created_at: string;
  updated_at: string;
}

export interface LiveJob {
  job_id: string;
  hash: string;
  filename: string;
  state: 'queued' | 'running' | 'waiting_gpu' | 'done' | 'error' | 'cancelled';
  position: number | null;
}

/** Playlist del server (resumen en la lista; con `songs` = hashes en orden en el detalle). */
export interface PlaylistSummary { id: string; title: string; count: number; has_cover: boolean; created_at: string; updated_at: string }
export interface Playlist extends PlaylistSummary { songs: string[] }

/** Respuesta de POST /jobs, /library/{h}/reprocess y /library/{h}/lyrics. */
export interface JobSubmit { hash: string; job_id?: string; state: string; cached?: boolean }
/** GET /jobs/{id}: error_code estable; error es texto libre en ingles (solo respaldo). */
export interface JobStatus { job_id: string; hash: string; state: LiveJob['state']; position: number | null; error?: string; error_code?: string }

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Campos extra del cuerpo de error (p. ej. job_id en 409 job_running). */
  readonly body: Record<string, unknown>;
  constructor(status: number, code: string, body: Record<string, unknown> = {}) { super(code); this.status = status; this.code = code; this.body = body; }
}

export interface TokenStore { get(): string | null; set(t: string | null): void }

export const localTokenStore: TokenStore = {
  get: () => { try { return localStorage.getItem('fision.token'); } catch { return null; } },
  set: (t) => { try { if (t) localStorage.setItem('fision.token', t); else localStorage.removeItem('fision.token'); } catch { /* sin storage */ } },
};

export class Api {
  /** Se llama cuando un 401 invalida el token guardado: la UI vuelve al login. */
  onUnauthorized: (() => void) | null = null;

  private base: string;
  private store: TokenStore;
  private fetchFn: typeof fetch;

  constructor(base = '', store: TokenStore = localTokenStore, fetchFn: typeof fetch = fetch.bind(globalThis)) {
    this.base = base; this.store = store; this.fetchFn = fetchFn;
  }

  get hasToken(): boolean { return !!this.store.get(); }

  async login(username: string, password: string): Promise<Session> {
    const r = await this.raw('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    // 401 en /login = credenciales malas, no sesion caducada
    if (r.status === 401) throw new ApiError(401, 'bad_credentials');
    return this.saveSession(await this.json(r));
  }

  /** Sesion deslizante: llamar al abrir la app. */
  async refresh(): Promise<Session> {
    return this.saveSession(await this.json(await this.authed('/auth/refresh', { method: 'POST' })));
  }

  logout(): void { this.store.set(null); }

  async library(): Promise<LibraryEntry[]> { return this.json(await this.authed('/library')); }

  async serverInfo(): Promise<{ version?: string; gpu?: boolean; gpu_name?: string }> { return this.json(await this.authed('/server/info')); }

  async job(id: string): Promise<JobStatus> { return this.json(await this.authed(`/jobs/${id}`)); }
  async cancelJob(id: string): Promise<void> { await this.authed(`/jobs/${id}`, { method: 'DELETE' }, [404]); }

  /** Reprocesar el audio guardado en el server con otra configuracion (form, sin subir nada). */
  async reprocess(hash: string, config: unknown): Promise<JobSubmit> {
    const body = new URLSearchParams({ config_json: JSON.stringify(config) });
    return this.json(await this.authed(`/library/${hash}/reprocess`, { method: 'POST', body }));
  }

  /** POST /jobs multipart (file + config_json) con progreso de subida. fetch no da progreso de
   *  subida: XMLHttpRequest. `signal` cancela. Mismo trato de 401 y errores que el resto. */
  uploadJob(file: Blob, filename: string, config: unknown, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<JobSubmit> {
    return new Promise((resolve, reject) => {
      const token = this.store.get();
      if (!token) { reject(new ApiError(401, 'unauthorized')); return; }
      const form = new FormData();
      form.append('file', file, filename);
      form.append('config_json', JSON.stringify(config));
      const x = new XMLHttpRequest();
      x.open('POST', this.base + '/jobs');
      x.setRequestHeader('Authorization', `Bearer ${token}`);
      x.upload.onprogress = (e) => onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size);
      x.onerror = () => reject(new ApiError(0, 'network'));
      x.onabort = () => reject(new ApiError(0, 'aborted'));
      x.onload = () => {
        let j: Record<string, unknown> = {};
        try { j = JSON.parse(x.responseText); } catch { /* sin JSON */ }
        if (x.status === 401) { this.store.set(null); this.onUnauthorized?.(); reject(new ApiError(401, 'unauthorized')); return; }
        if (x.status < 200 || x.status >= 300) { reject(new ApiError(x.status, typeof j.code === 'string' ? j.code : `http_${x.status}`, j)); return; }
        resolve(j as unknown as JobSubmit);
      };
      signal?.addEventListener('abort', () => x.abort());
      x.send(form);
    });
  }

  /** Jobs vivos de la cuenta (cola, procesando, esperando GPU). */
  async jobs(): Promise<LiveJob[]> { return this.json(await this.authed('/jobs')); }

  /** Letra actual; null si no existe (404). No fiarse del lyrics.json del zip. */
  async lyrics(hash: string): Promise<unknown | null> {
    const r = await this.authed(`/library/${hash}/lyrics`, {}, [404]);
    return r.status === 404 ? null : r.json();
  }

  async zip(hash: string, onProgress?: (done: number, total: number) => void): Promise<Uint8Array> {
    const r = await this.authed(`/library/${hash}/zip`);
    const total = Number(r.headers.get('content-length') || 0);
    if (!r.body || !onProgress) return new Uint8Array(await r.arrayBuffer());
    const chunks: Uint8Array[] = [];
    let done = 0;
    for (const reader = r.body.getReader(); ;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      chunks.push(value);
      done += value.length;
      onProgress(done, total);
    }
    const all = new Uint8Array(done);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    return all;
  }

  /** Portada como Blob (la ruta exige token: un <img> no puede pedirla). */
  async cover(e: LibraryEntry): Promise<Blob | null> {
    if (!e.cover_url) return null;
    const r = await this.authed(e.cover_url, {}, [404]);
    return r.status === 404 ? null : r.blob();
  }

  // --- playlists (el server manda; PUT sustituye titulo y canciones) ---

  async playlists(): Promise<PlaylistSummary[]> { return this.json(await this.authed('/playlists')); }
  async playlist(id: string): Promise<Playlist> { return this.json(await this.authed(`/playlists/${id}`)); }
  async createPlaylist(title: string, songs: string[]): Promise<Playlist> { return this.json(await this.authed('/playlists', jsonBody('POST', { title, songs }))); }
  async updatePlaylist(id: string, title: string, songs: string[]): Promise<Playlist> { return this.json(await this.authed(`/playlists/${id}`, jsonBody('PUT', { title, songs }))); }
  async deletePlaylist(id: string): Promise<void> { await this.authed(`/playlists/${id}`, { method: 'DELETE' }); }

  /** Portada; `v` = updated_at para no servir una vieja de cache. */
  async playlistCover(id: string, v: string): Promise<Blob | null> {
    const r = await this.authed(`/playlists/${id}/cover?v=${encodeURIComponent(v)}`, {}, [404]);
    return r.status === 404 ? null : r.blob();
  }
  async putPlaylistCover(id: string, img: Blob): Promise<void> {
    const f = new FormData();
    f.append('file', img, 'cover.jpg');
    await this.authed(`/playlists/${id}/cover`, { method: 'PUT', body: f });
  }
  async deletePlaylistCover(id: string): Promise<void> { await this.authed(`/playlists/${id}/cover`, { method: 'DELETE' }, [404]); }

  // --- interno ---

  private saveSession(j: { token: string; user: string; expires_at: string }): Session {
    this.store.set(j.token);
    return { token: j.token, user: j.user, expiresAt: j.expires_at };
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    try { return await this.fetchFn(this.base + path, init); } catch { throw new ApiError(0, 'network'); }
  }

  private async authed(path: string, init: RequestInit = {}, okStatus: number[] = []): Promise<Response> {
    const token = this.store.get();
    if (!token) throw new ApiError(401, 'unauthorized');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const r = await this.raw(path, { ...init, headers });
    if (r.status === 401) {
      // Token muerto: reintentar no sirve. Borrar y pedir login.
      this.store.set(null);
      this.onUnauthorized?.();
      throw new ApiError(401, 'unauthorized');
    }
    if (!r.ok && !okStatus.includes(r.status)) { const [code, body] = await errorBody(r); throw new ApiError(r.status, code, body); }
    return r;
  }

  private async json<T>(r: Response): Promise<T> {
    if (!r.ok) throw new ApiError(r.status, await errorCode(r));
    return r.json() as Promise<T>;
  }
}

const jsonBody = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function errorBody(r: Response): Promise<[string, Record<string, unknown>]> {
  try { const j = await r.json(); if (j && typeof j === 'object') return [typeof j.code === 'string' ? j.code : `http_${r.status}`, j]; } catch { /* sin JSON */ }
  return [`http_${r.status}`, {}];
}
async function errorCode(r: Response): Promise<string> { return (await errorBody(r))[0]; }
