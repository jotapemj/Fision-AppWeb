// Orquesta sesion, biblioteca, descargas y reproductor.
import { Api, ApiError, type LibraryEntry, type LiveJob, type Session } from './api/client.ts';
import { Engine } from './engine/engine.ts';
import { t } from './i18n/i18n.ts';
import { buildRows, type Row } from './library/library.ts';
import { SongStore } from './lib/songStore.ts';
import { listZip, readZipEntry } from './lib/zip.ts';
import { Player, parseBeats, parseBpm } from './player/player.ts';
import { isMetronome, stemOf } from './player/stems.ts';
import { buildRows as buildLyricRows } from './player/lyrics.ts';
import type { LyricsState } from './ui/lyricsView.ts';
import { h } from './ui/dom.ts';
import { loginView } from './ui/login.ts';
import { idleBar, PlayerView } from './ui/playerView.ts';
import { Sidebar } from './ui/sidebar.ts';

const JOB_POLL_MS = 4000;

export class App {
  private api = new Api();
  private root: HTMLElement;
  private store: SongStore | null = null;
  private sidebar: Sidebar | null = null;
  private shell: HTMLElement | null = null;
  private entries: LibraryEntry[] = [];
  private downloaded = new Set<string>();
  private downloading = new Map<string, number>();
  private jobs: LiveJob[] = [];
  private rows: Row[] = [];
  private covers = new Map<string, Promise<string | null>>();
  private engine: Engine | null = null;
  private current: { entry: LibraryEntry; player: Player; view: PlayerView } | null = null;
  private opening = false;
  private pollTimer = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.api.onUnauthorized = () => this.showLogin(t('login_session_expired'));
  }

  async start() {
    if (!this.api.hasToken) return this.showLogin();
    try { this.enter(await this.api.refresh()); }
    catch (e) { if (e instanceof ApiError && e.status === 401) return; this.showLogin(t('login_err_network')); }
  }

  private showLogin(notice = '') {
    this.stopSong();
    clearTimeout(this.pollTimer);
    this.shell = this.sidebar = null;
    this.root.replaceChildren(loginView(this.api, (s) => this.enter(s), notice));
  }

  private enter(s: Session) {
    this.store = new SongStore(s.user);
    this.covers.clear();
    this.sidebar = new Sidebar(s.user, location.host, {
      onPick: (r) => this.pick(r),
      onLogout: () => { this.api.logout(); this.showLogin(); },
      cover: (hash) => this.cover(hash),
    });
    this.shell = h('div', { class: 'app' }, this.sidebar.el, this.hintMain(t('web_pick_song')), idleBar());
    this.root.replaceChildren(this.shell);
    this.refreshLibrary();
  }

  private hintMain(text: string) { return h('section', { class: 'main' }, h('div'), h('div'), h('p', { class: 'hint', textContent: text })); }

  private async refreshLibrary() {
    try {
      const [entries, jobs, local] = await Promise.all([this.api.library(), this.api.jobs(), this.store!.list()]);
      this.entries = entries; this.jobs = jobs; this.downloaded = new Set(local);
      this.render();
    } catch (e) { if (!(e instanceof ApiError && e.status === 401)) console.warn('library', e); }
    // Con jobs vivos, sondear hasta que acaben (luego la entrada pasa a ready)
    clearTimeout(this.pollTimer);
    if (this.jobs.length) this.pollTimer = window.setTimeout(() => this.refreshLibrary(), JOB_POLL_MS);
  }

  private render() {
    this.rows = buildRows({ entries: this.entries, downloaded: this.downloaded, downloading: this.downloading, jobs: this.jobs });
    this.sidebar?.update(this.rows, this.current?.entry.hash ?? null, this.current?.player.playing ?? false);
  }

  private pick(r: Row) {
    if (r.state.kind === 'downloaded') this.open(r.entry);
    else if (r.state.kind === 'cloud') this.download(r.entry); // como Android: tocar en la nube = descargar
  }

  private async download(e: LibraryEntry) {
    if (this.downloading.has(e.hash)) return;
    this.downloading.set(e.hash, 0);
    this.render();
    try {
      let last = -1;
      const zip = await this.api.zip(e.hash, (d, total) => {
        const pct = total ? Math.floor(d / total * 100) : 0;
        if (pct !== last) { last = pct; this.downloading.set(e.hash, pct); this.render(); }
      });
      const files = await Promise.all(listZip(zip).map(async (z) => ({ name: z.name, data: await readZipEntry(zip, z) })));
      await this.store!.save(e.hash, e.updated_at, files);
      this.downloaded.add(e.hash);
    } catch (err) { console.warn('download', err); }
    finally { this.downloading.delete(e.hash); this.render(); }
  }

  private cover(hash: string): Promise<string | null> {
    let p = this.covers.get(hash);
    if (!p) {
      const e = this.entries.find((x) => x.hash === hash);
      p = (async () => {
        // Descargada: portada local (sin red)
        if (this.downloaded.has(hash)) {
          const [f] = await this.store!.load(hash, (n) => n === 'artcover.png').catch(() => []);
          if (f) return URL.createObjectURL(new Blob([f.data as BlobPart], { type: 'image/png' }));
        }
        const b = e ? await this.api.cover(e).catch(() => null) : null;
        return b ? URL.createObjectURL(b) : null;
      })();
      this.covers.set(hash, p);
    }
    return p;
  }

  private async open(e: LibraryEntry) {
    if (this.opening || !this.shell) return;
    this.opening = true;
    const curtain = h('div', { class: 'curtain', attrs: { role: 'status' } }, h('span', { class: 'spin' }), t('web_loading_song'));
    this.shell.querySelector('.main')?.append(curtain);
    try {
      // AudioContext tras el gesto del usuario (este clic)
      this.engine ??= await Engine.create('playback');
      this.current?.player.pause();
      const files = await this.store!.load(e.hash, (n) => /\.(flac|wav)$/i.test(n) || n === 'beats.txt');
      const beats = files.find((f) => f.name === 'beats.txt');
      // Metronomos en bucle, como PlaybackService
      const audio = files.filter((f) => f !== beats).map((f) => ({ ...f, loop: isMetronome(stemOf(f.name)) }));
      if (!audio.length) throw new Error('err_song_missing_files');
      const rep = await this.engine.load(audio);
      this.stopSong();
      const beatsTxt = beats ? new TextDecoder().decode(beats.data) : null;
      const player = new Player(this.engine, { stems: rep.stems, durationMs: rep.durationMs, bpm: parseBpm(beatsTxt), beats: parseBeats(beatsTxt) });
      const view = new PlayerView(player, e, await this.cover(e.hash), {
        onPrev: () => this.step(-1), onNext: () => this.step(1),
        onEnded: () => this.step(1), onPlayState: () => this.render(),
      });
      this.current = { entry: e, player, view };
      this.shell.replaceChildren(this.sidebar!.el, view.main, view.bar);
      this.render();
      this.loadLyrics(e, rep.durationMs / 1000).then((st) => { if (this.current?.view === view) view.setLyrics(st); });
      await view.toggle(); // abrir = reproducir, como Android
    } catch (err) {
      curtain.remove();
      const msg = err instanceof Error && err.message === 'engine_needs_isolation' ? t('web_engine_isolation') : t('err_song_missing_files');
      console.error('open', err);
      if (!this.current) this.shell.replaceChildren(this.sidebar!.el, this.hintMain(msg), idleBar());
    } finally { this.opening = false; }
  }

  /** Letra: siempre del server (la del zip puede estar vieja); sin red, la copia local. */
  private async loadLyrics(e: LibraryEntry, durationSec: number): Promise<LyricsState> {
    const store = this.store!;
    let json: unknown = null;
    try {
      json = await this.api.lyrics(e.hash);
      await store.putFile(e.hash, 'lyrics.json', json ? new TextEncoder().encode(JSON.stringify(json)) : null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return { kind: 'none' };
      const [f] = await store.load(e.hash, (n) => n === 'lyrics.json').catch(() => []);
      if (f) try { json = JSON.parse(new TextDecoder().decode(f.data)); } catch { json = null; }
    }
    const rows = json ? buildLyricRows(json, durationSec) : [];
    return rows.some((r) => r.type === 'text') ? { kind: 'content', rows } : { kind: 'none' };
  }

  /** Anterior / siguiente entre las descargadas, en el orden de la lista. */
  private step(dir: 1 | -1) {
    const list = this.rows.filter((r) => r.state.kind === 'downloaded');
    const i = list.findIndex((r) => r.entry.hash === this.current?.entry.hash);
    const next = list[i + dir];
    if (next) this.open(next.entry);
  }

  private stopSong() {
    if (!this.current) return;
    this.current.player.pause();
    this.current.view.destroy();
    this.current = null;
  }
}
