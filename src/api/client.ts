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
  created_at: string;
  updated_at: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
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
    if (!r.ok && !okStatus.includes(r.status)) throw new ApiError(r.status, await errorCode(r));
    return r;
  }

  private async json<T>(r: Response): Promise<T> {
    if (!r.ok) throw new ApiError(r.status, await errorCode(r));
    return r.json() as Promise<T>;
  }
}

async function errorCode(r: Response): Promise<string> {
  try { const j = await r.json(); if (typeof j?.code === 'string') return j.code; } catch { /* sin JSON */ }
  return `http_${r.status}`;
}
