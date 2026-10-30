// Orquesta sesion, biblioteca, descargas y reproductor.
import { Api, ApiError, type LibraryEntry, type LiveJob, type Playlist, type PlaylistSummary, type Session } from './api/client.ts';
import { adjacent, errorKey, isValidId, mosaicHashes } from './library/playlists.ts';
import { openPlaylistEditor } from './ui/playlistEditor.ts';
import { openImport, pickAudio } from './ui/importDialog.ts';
import { openExport } from './ui/exportDialog.ts';
import { RETRYABLE } from './library/importConfig.ts';
import { Engine } from './engine/engine.ts';
import { t } from './i18n/i18n.ts';
import { buildRows, deleteKind, type Row } from './library/library.ts';
import { SongStore } from './lib/songStore.ts';
import { listZip, readZipEntry } from './lib/zip.ts';
import { Player, parseBeats, parseBpm } from './player/player.ts';
import { isMetronome, stemOf } from './player/stems.ts';
import { buildRows as buildLyricRows } from './player/lyrics.ts';
import type { LyricsState } from './ui/lyricsView.ts';
import { buildBeatCells, chordsOverWords, parseChords, parseTimes } from './player/chords.ts';
import { h, toast } from './ui/dom.ts';
import { loginView } from './ui/login.ts';
import { idleBar, PlayerView } from './ui/playerView.ts';
import { Curtain } from './ui/curtain.ts';
import { Sidebar, type RowMenuItem } from './ui/sidebar.ts';
import { Nebula } from './ui/nebula.ts';
import { IdleMain } from './ui/idleMain.ts';
import { accentPalette, pulseFor } from './player/nebulaMath.ts';
import { ACCENTS, type SettingsStore } from './settings.ts';
import { openSettings } from './ui/settingsView.ts';
import { cssRgb, songColors, type SongColors } from './player/songPalette.ts';
import { formatChord } from './player/chords.ts';
import pkg from '../package.json' with { type: 'json' };
import { capture, idbParamsStore, restore, type ParamsStore } from './player/songParams.ts';

const JOB_POLL_MS = 4000;
const LYRICS_POLL_MS = 2500; // LyricsManager
const LYRICS_JOBS = 'fision.lyricsJobs'; // job_id -> hash de las transcripciones pedidas aqui

// GET /jobs no dice el tipo: los jobs de letra se reconocen por su id (sobreviven a recargar)
function loadLyricsJobs(): Map<string, string> { try { return new Map(Object.entries(JSON.parse(localStorage.getItem(LYRICS_JOBS) ?? '{}'))); } catch { return new Map(); } }

export class App {
  private api = new Api();
  private settings: SettingsStore;
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
  private nebula: Nebula | null = null;
  private user = '';
  private params: ParamsStore = idbParamsStore();
  private saveTimer = 0;
  private flushSave: (() => void) | null = null;
  private playlists: PlaylistSummary[] = [];
  private plDetail = new Map<string, Playlist>(); // detalle por id, se rehace si cambia updated_at
  private plCovers = new Map<string, Promise<string | null>>(); // clave id:updated_at
  private online = false;
  private queue: string[] | null = null; // PlayQueue: playlist desde la que suena, o null = biblioteca
  private inflight = new Map<string, string>(); // hash -> job_id de lo que procesa el server
  private jobErrors = new Map<string, string>(); // hash -> error_code (en memoria)
  private gpu: Promise<boolean | null> | null = null;
  private idle: IdleMain | null = null; // centro sin cancion
  private lyricsJobs = loadLyricsJobs();
  private lyricsTimer = 0;

  constructor(root: HTMLElement, settings: SettingsStore) {
    this.root = root;
    this.settings = settings;
    settings.subscribe((_, k) => this.onSetting(k));
    this.api.onUnauthorized = () => this.showLogin(t('login_session_expired'));
    addEventListener('pagehide', () => this.flushSave?.());
  }

  async start() {
    if (!this.api.hasToken) return this.showLogin();
    try { this.enter(await this.api.refresh()); }
    catch (e) { if (e instanceof ApiError && e.status === 401) return; this.showLogin(t('login_err_network')); }
  }

  private showLogin(notice = '') {
    this.stopSong();
    this.idle?.destroy(); this.idle = null;
    this.nebula?.destroy();
    clearTimeout(this.pollTimer);
    this.shell = this.sidebar = null;
    this.root.replaceChildren(loginView(this.api, (s) => this.enter(s), notice));
  }

  private enter(s: Session) {
    this.user = s.user;
    this.store = new SongStore(s.user);
    this.covers.clear();
    this.sidebar = new Sidebar(s.user, location.host, {
      onPick: (r, queue) => this.pick(r, queue),
      onOpenPlaylist: (id) => void this.openPlaylist(id),
      onClosePlaylist: () => this.sidebar?.showPlaylist(null),
      onNewPlaylist: () => this.editPlaylist(null),
      onEditPlaylist: (p) => this.editPlaylist(p),
      onDeletePlaylist: (p) => void this.deletePlaylist(p),
      playlistCover: (p) => this.playlistCover(p),
      onAdd: () => void this.addSong(),
      onSettings: () => openSettings(this.settings, { user: s.user, server: location.host, webVersion: pkg.version,
        serverInfo: () => this.api.serverInfo().catch(() => null), onLogout: () => { this.api.logout(); this.showLogin(); } }),
      cover: (hash) => this.cover(hash),
      rowMenu: (r) => this.rowMenu(r),
    });
    this.nebula?.destroy();
    this.nebula = new Nebula();
    this.nebula.setColors(accentPalette(ACCENTS[this.settings.get('accentId')]));
    this.nebula.setEnabled(this.settings.get('nebula'));
    this.shell = h('div', { class: 'app' }, this.nebula.el, this.sidebar.el, this.hintMain(t('web_pick_song')), idleBar());
    this.root.replaceChildren(this.shell);
    // Playlists al entrar (y tras cada cambio), no en cada sondeo de jobs
    void this.refreshLibrary().then(() => this.syncPlaylists());
  }

  /** Centro sin cancion: nebulosa relajada + marca (una sola viva a la vez). */
  private hintMain(text: string) {
    this.idle?.destroy();
    this.idle = new IdleMain(text, ACCENTS[this.settings.get('accentId')]);
    return this.idle.el;
  }

  private async refreshLibrary() {
    try {
      const [entries, jobs, local] = await Promise.all([this.api.library(), this.api.jobs(), this.store!.list()]);
      // Los jobs de letra no ocupan la fila (la cancion se sigue pudiendo abrir) ni piden zip al acabar
      this.entries = entries; this.jobs = jobs.filter((j) => !this.lyricsJobs.has(j.job_id)); this.downloaded = new Set(local);
      this.online = true;
      this.render();
      void this.settleJobs();
    } catch (e) { this.online = false; if (!(e instanceof ApiError && e.status === 401)) console.warn('library', e); }
    // Con jobs vivos, sondear hasta que acaben (luego la entrada pasa a ready)
    clearTimeout(this.pollTimer);
    if (this.jobs.length) this.pollTimer = window.setTimeout(() => this.refreshLibrary(), JOB_POLL_MS);
  }

  private render() {
    this.rows = buildRows({ entries: this.entries, downloaded: this.downloaded, downloading: this.downloading, jobs: this.jobs, errors: this.jobErrors }, this.settings.get('sortAsc'));
    this.sidebar?.update(this.rows, this.current?.entry.hash ?? null, this.current?.player.playing ?? false);
  }

  /** Lo que estaba en vuelo y ya no: listo = descargar siempre (aunque hubiera copia: reproceso);
   *  error = su error_code, y si se puede reintentar, el dialogo. */
  private async settleJobs() {
    const live = new Set(this.jobs.map((j) => j.hash));
    for (const j of this.jobs) { this.inflight.set(j.hash, j.job_id); this.jobErrors.delete(j.hash); }
    for (const [hash, jobId] of [...this.inflight]) {
      if (live.has(hash)) continue;
      const e = this.entries.find((x) => x.hash === hash);
      if (!e || e.state === 'processing') continue; // aun no se ve el final
      this.inflight.delete(hash);
      let code: string | undefined;
      try { const st = await this.api.job(jobId); if (st.state === 'error' || st.state === 'cancelled') code = st.error_code || undefined; } catch { /* job ya purgado */ }
      if (code) {
        this.jobErrors.set(hash, code);
        this.render();
        if (RETRYABLE.includes(code)) this.retryDialog(e, code);
      } else if (e.state === 'ready') void this.download(e);
    }
  }

  /** gpu_busy / timeout: Reintentar = reprocesar con el config guardado (no se resube). */
  private retryDialog(e: LibraryEntry, code: string) {
    const retry = h('button', { class: 'btn', textContent: t('gpu_timeout_retry') });
    const cancel = h('button', { class: 'btn ghost', textContent: t('gpu_timeout_cancel') });
    const dlg = h('dialog', { class: 'settings', attrs: { 'aria-label': e.title || e.filename } },
      h('div', { class: 'shd' }, h('h2', { textContent: e.title || e.filename })),
      h('p', { class: 'muted', textContent: t(code === 'gpu_busy' ? 'gpu_timeout_body' : 'job_timeout_body') }),
      h('div', { class: 'plfoot' }, cancel, retry));
    cancel.onclick = () => dlg.close();
    retry.onclick = async () => {
      dlg.close();
      try { this.onSubmitted(await this.api.reprocess(e.hash, e.config ?? {})); }
      catch (err) { toast(t(err instanceof ApiError && err.status === 409 ? 'reprocess_busy' : err instanceof ApiError && err.status === 429 ? 'err_job_limit' : 'reprocess_failed')); }
    };
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  private serverGpu(): Promise<boolean | null> {
    // Sin dato del server = cpu (ServerInfoManager.hasGpu = false)
    return (this.gpu ??= this.api.serverInfo().then((i) => !!i.gpu).catch(() => false));
  }

  private async addSong() {
    const f = await pickAudio();
    if (f) openImport({ kind: 'upload', file: f }, { api: this.api, gpu: this.serverGpu(), onSubmitted: (r) => this.onSubmitted(r) });
  }

  private reprocessCurrent() {
    const e = this.current?.entry;
    if (!e) return;
    if (this.inflight.has(e.hash) || this.jobs.some((j) => j.hash === e.hash)) { toast(t('reprocess_busy')); return; }
    void this.cover(e.hash).then((cover) => openImport({ kind: 'reprocess', entry: e, cover }, { api: this.api, gpu: this.serverGpu(), onSubmitted: (r) => this.onSubmitted(r) }));
  }

  private onSubmitted(r: { hash: string; job_id?: string }) {
    this.jobErrors.delete(r.hash);
    if (r.job_id) this.inflight.set(r.hash, r.job_id);
    void this.refreshLibrary();
  }

  /** PlaylistRepository.sync: lista + detalle solo de las que cambiaron; sin red, quedan las que habia. */
  private async syncPlaylists() {
    try {
      const list = (await this.api.playlists()).filter((p) => isValidId(p.id));
      for (const p of list) {
        const d = this.plDetail.get(p.id);
        if (!d || d.updated_at !== p.updated_at) this.plDetail.set(p.id, await this.api.playlist(p.id));
      }
      for (const id of [...this.plDetail.keys()]) if (!list.some((p) => p.id === id)) this.plDetail.delete(id);
      this.playlists = list;
    } catch (e) { if (e instanceof ApiError && e.status === 401) return; }
    this.sidebar?.setPlaylists(this.playlists, this.online);
    // La abierta se refresca con su detalle nuevo
    const open = this.sidebar?.openPlaylist;
    if (open) this.sidebar!.showPlaylist(this.plDetail.get(open.id) ?? null);
  }

  private async openPlaylist(id: string) {
    let d = this.plDetail.get(id);
    try { d = await this.api.playlist(id); this.plDetail.set(id, d); }
    catch (e) {
      if (e instanceof ApiError && e.status === 404) { toast(t('playlist_err_gone')); this.plDetail.delete(id); void this.syncPlaylists(); return; }
    }
    if (d) this.sidebar?.showPlaylist(d);
  }

  private editPlaylist(p: Playlist | null) {
    const open = async () => openPlaylistEditor(p, {
      api: this.api, rows: this.rows, cover: (hsh) => this.cover(hsh),
      playlistCover: p ? await this.ownCover(p) : null,
      onSaved: async (id) => {
        this.plDetail.delete(id);
        await this.syncPlaylists();
        await this.openPlaylist(id);
      },
    });
    void open();
  }

  private async deletePlaylist(p: Playlist) {
    if (!confirm(t('playlist_delete_confirm', p.title))) return;
    try {
      await this.api.deletePlaylist(p.id);
      toast(t('playlist_deleted'));
      if (this.queue === p.songs) this.queue = null;
      this.sidebar?.showPlaylist(null);
    } catch (e) { if (e instanceof ApiError) toast(t(...errorKey(e.status, e.code))); }
    void this.syncPlaylists();
  }

  /** Portada propia (con ?v=updated_at) o null. */
  private ownCover(p: PlaylistSummary): Promise<string | null> {
    if (!p.has_cover) return Promise.resolve(null);
    const k = `${p.id}:${p.updated_at}`;
    let c = this.plCovers.get(k);
    if (!c) { c = this.api.playlistCover(p.id, p.updated_at).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null); this.plCovers.set(k, c); }
    return c;
  }

  /** Sin portada propia: mosaico de las primeras canciones (PlaylistCovers). */
  private async playlistCover(p: PlaylistSummary): Promise<string[]> {
    const own = await this.ownCover(p);
    if (own) return [own];
    const songs = this.plDetail.get(p.id)?.songs ?? [];
    return (await Promise.all(mosaicHashes(songs).map((hsh) => this.cover(hsh)))).filter((u): u is string => !!u);
  }

  /** Hoja de opciones (MainActivity.showBottomDialog): Reintentar si fallo un reproceso con copia; Borrar segun estado. */
  private rowMenu(r: Row): RowMenuItem[] {
    const e = r.entry, items: RowMenuItem[] = [];
    const code = this.jobErrors.get(e.hash);
    if (r.state.kind === 'downloaded' && code && RETRYABLE.includes(code)) items.push({ label: t('song_option_retry_job'), run: () => this.retryDialog(e, code) });
    const kind = deleteKind(r.state);
    const label = kind === 'queue' ? 'cloud_cancel_queue' : kind === 'cloud' ? 'cloud_delete_cloud' : 'b_delete';
    items.push({ label: t(label), danger: true, disabled: !kind || (kind !== 'local' && !this.online), run: () => void this.deleteSong(r) });
    return items;
  }

  private async deleteSong(r: Row) {
    const e = r.entry, kind = deleteKind(r.state), title = e.title || e.filename;
    if (!kind) return;
    if (kind === 'queue') {
      if (!confirm(t('cloud_cancel_queue_confirm'))) return;
      const job = this.jobs.find((j) => j.hash === e.hash);
      if (job) { try { await this.api.cancelJob(job.job_id); } catch { /* ya no estaba */ } }
      this.inflight.delete(e.hash);
      void this.refreshLibrary();
      return;
    }
    if (kind === 'local') {
      if (!confirm(t('delete_confirm', title))) return;
      // La que suena: se para y el centro vuelve a la pantalla sin cancion
      if (this.current?.entry.hash === e.hash) {
        this.stopSong();
        this.shell?.replaceChildren(this.nebula!.el, this.sidebar!.el, this.hintMain(t('web_pick_song')), idleBar());
        this.nebula?.setOrbitBlobsVisible(true);
        void this.applySongColors();
      }
      await this.store!.remove(e.hash).catch((err) => console.warn('remove', err));
      await this.params.del(`${this.user}:${e.hash}`); // como Android: la fila de Room se va con la carpeta
      this.downloaded.delete(e.hash);
      this.covers.delete(e.hash); this.paletteCache.delete(e.hash);
      this.render();
      return;
    }
    if (!confirm(t('cloud_delete_cloud_confirm'))) return;
    try { await this.api.deleteSong(e.hash); }
    catch (err) {
      if (err instanceof ApiError && err.status === 409) toast(t('cloud_delete_busy'));
      else if (!(err instanceof ApiError && err.status === 401)) toast(t('login_err_network'));
      return;
    }
    this.entries = this.entries.filter((x) => x.hash !== e.hash);
    this.jobErrors.delete(e.hash); this.inflight.delete(e.hash); this.covers.delete(e.hash);
    this.render();
    void this.syncPlaylists(); // el server la quita de sus playlists: cambian las cuentas
  }

  private pick(r: Row, queue: string[] | null = null) {
    // Abrir desde una playlist fija su orden; desde la biblioteca vuelve a la biblioteca
    if (r.state.kind === 'downloaded') this.queue = queue;
    if (r.state.kind === 'error' && r.state.code && RETRYABLE.includes(r.state.code)) { this.retryDialog(r.entry, r.state.code); return; }
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
      this.covers.delete(e.hash); // ahora hay portada local (antes pudo quedar null en cache)
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
    // Telon con la marca (LoadingCurtain): opaco al abrir; con fundido de 220 ms al cambiar de cancion
    const curtain = new Curtain(this.current ? 220 : 0);
    curtain.el.setAttribute('aria-label', t('web_loading_song'));
    this.shell.append(curtain.el);
    await curtain.covered;
    try {
      // AudioContext tras el gesto del usuario (este clic)
      this.engine ??= await Engine.create('playback');
      this.current?.player.pause();
      const TEXT = ['beats.txt', 'downbeats.txt', 'chords.txt', 'chords_basic.txt'];
      const files = await this.store!.load(e.hash, (n) => /\.(flac|wav)$/i.test(n) || TEXT.includes(n));
      const txt = (n: string) => { const f = files.find((x) => x.name === n); return f ? new TextDecoder().decode(f.data) : null; };
      const beats = files.find((f) => f.name === 'beats.txt');
      // Metronomos en bucle, como PlaybackService
      const audio = files.filter((f) => !TEXT.includes(f.name)).map((f) => ({ ...f, loop: isMetronome(stemOf(f.name)) }));
      if (!audio.length) throw new Error('err_song_missing_files');
      const rep = await this.engine.load(audio);
      this.stopSong();
      const beatsTxt = beats ? new TextDecoder().decode(beats.data) : null;
      const player = new Player(this.engine, { stems: rep.stems, durationMs: rep.durationMs, bpm: parseBpm(beatsTxt), beats: parseBeats(beatsTxt) });
      // Mezcla guardada de esta cancion (solo en este navegador)
      const key = `${this.user}:${e.hash}`;
      restore(player, await this.params.get(key));
      player.autoplayNext = this.settings.get('autoplayNext');
      const hasBasic = !!txt('chords_basic.txt');
      if (!hasBasic) player.chordsBasic = false;
      const save = () => { clearTimeout(this.saveTimer); this.flushSave = null; this.params.put(key, capture(player)); };
      player.onChange = () => { clearTimeout(this.saveTimer); this.flushSave = save; this.saveTimer = window.setTimeout(save, 400); };
      let setLyr: (st: LyricsState) => void = () => {};
      let lastContent: LyricsState | null = null;
      const durSec = rep.durationMs / 1000;
      const view = new PlayerView(player, e, await this.cover(e.hash), {
        lyrics: {
          request: (lang, again) => void this.requestLyrics(e, lang, again, durSec, (st) => { if (st.kind === 'content') lastContent = st; setLyr(st); }),
          cancelJob: () => void this.cancelLyrics(e, setLyr),
          back: () => setLyr(lastContent ?? { kind: 'picker' }),
          reprocess: () => setLyr({ kind: 'picker', reprocess: true }),
        },
        onPrev: () => this.step(-1), onNext: () => this.step(1),
        onEnded: () => this.step(1), onPlayState: () => this.render(),
        onBeat: (pos, bpb, bpm) => { const k = pulseFor(pos, bpb, bpm); if (k) this.nebula?.beat(k); },
        nebula: { get: () => this.settings.get('nebula'), set: (on) => this.settings.set('nebula', on) },
        onView: (v) => this.nebula?.setOrbitBlobsVisible(v !== '3d'),
        onReprocess: () => this.reprocessCurrent(),
        onExport: (stem) => openExport({ player, entry: e, load: (want) => this.store!.load(e.hash, want) }, stem),
        chordNotation: () => ({ shift: this.settings.get('chordTranspose') ? player.pitch : 0, latin: this.settings.get('chordLatin'), flat: this.settings.get('chordFlat') }),
        formatChord: (c) => formatChord(c, this.settings.get('chordTranspose') ? player.pitch : 0, this.settings.get('chordLatin'), this.settings.get('chordFlat')),
        hasBasicChords: hasBasic,
        onChordsBasic: (basic) => { player.setChordsBasic(basic); applyChords(); },
        onPitch: () => { if (this.settings.get('chordTranspose')) view.reformatChords(); },
      });
      this.current = { entry: e, player, view };
      this.shell.replaceChildren(this.nebula!.el, this.sidebar!.el, view.main, view.bar, curtain.el);
      this.idle?.destroy(); this.idle = null;
      await this.applySongColors(); // como Android: revelar con la paleta ya puesta
      this.render();
      // Acordes avanzados o basicos (por cancion); la letra los lleva encima
      let lyrics: LyricsState = { kind: 'loading' };
      const applyChords = () => {
        const { cells, beatsPerBar } = buildBeatCells(parseBeats(beatsTxt), parseTimes(txt('downbeats.txt')), parseChords(txt(player.chordsBasic ? 'chords_basic.txt' : 'chords.txt')));
        view.setChords(cells, beatsPerBar);
        view.setLyrics(lyrics.kind === 'content' ? { ...lyrics, chords: chordsOverWords(lyrics.rows, cells) } : lyrics);
      };
      applyChords();
      setLyr = (st) => { if (this.current?.view !== view) return; lyrics = st; applyChords(); };
      this.loadLyrics(e, durSec).then((st) => {
        if (st.kind === 'content') lastContent = st;
        // Sin letra pero con su job en marcha: seguir esperandolo
        const live = [...this.lyricsJobs].find(([, hsh]) => hsh === e.hash);
        if (st.kind !== 'content' && live) { setLyr({ kind: 'processing' }); this.pollLyrics(e, live[0], durSec, (x) => { if (x.kind === 'content') lastContent = x; setLyr(x); }); return; }
        setLyr(st);
      });
      // Al empezar el fundido arranca la musica (abrir = reproducir, como Android)
      curtain.finish(() => { void view.toggle(); }, () => {});
    } catch (err) {
      curtain.finish(() => {}, () => {}, false);
      const msg = err instanceof Error && err.message === 'engine_needs_isolation' ? t('web_engine_isolation') : t('err_song_missing_files');
      console.error('open', err);
      if (!this.current) this.shell.replaceChildren(this.nebula!.el, this.sidebar!.el, this.hintMain(msg), idleBar());
    } finally { this.opening = false; }
  }

  private onSetting(k: string) {
    const cur = this.current;
    if (k === 'nebula') this.nebula?.setEnabled(this.settings.get('nebula'));
    if (k === 'accentId' || k === 'songColors') { this.applySongColors(); this.idle?.setAccent(ACCENTS[this.settings.get('accentId')]); }
    if (k === 'sortAsc') this.render();
    if (k === 'autoplayNext' && cur) cur.player.autoplayNext = this.settings.get('autoplayNext');
    if ((k === 'chordLatin' || k === 'chordFlat' || k === 'chordTranspose') && cur) cur.view.reformatChords();
  }

  private paletteCache = new Map<string, SongColors | null>();

  /** Colores de la portada en el reproductor (song_colors_enabled); si no, el acento elegido. */
  private async applySongColors() {
    const cur = this.current;
    const els = cur ? [cur.view.main, cur.view.bar] : [];
    const accent = ACCENTS[this.settings.get('accentId')];
    let pal: SongColors | null = null;
    if (cur && this.settings.get('songColors')) {
      const hash = cur.entry.hash;
      if (!this.paletteCache.has(hash)) this.paletteCache.set(hash, await this.coverPalette(hash));
      if (this.current !== cur) return;
      pal = this.paletteCache.get(hash) ?? null;
    }
    for (const el of els) {
      if (pal) {
        el.style.setProperty('--accent', cssRgb(pal.accent));
        el.style.setProperty('--accent-2', cssRgb(pal.secondary));
        el.style.setProperty('--accent-12', `rgb(${pal.accent.join(' ')} / .12)`);
      } else for (const v of ['--accent', '--accent-2', '--accent-12']) el.style.removeProperty(v);
    }
    this.nebula?.setColors(pal ? { blobs: pal.blobs, anchor: pal.anchor } : accentPalette(accent));
  }

  /** Portada local -> pixeles (area 112x112, vecino mas cercano, como Palette.scaleBitmapDown). */
  private async coverPalette(hash: string): Promise<SongColors | null> {
    const url = await this.cover(hash);
    if (!url) return null;
    try {
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      const k = Math.min(1, Math.sqrt(12544 / (bmp.width * bmp.height)));
      const w = Math.ceil(bmp.width * k), hh = Math.ceil(bmp.height * k);
      const c = new OffscreenCanvas(w, hh), ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bmp, 0, 0, w, hh);
      return songColors(ctx.getImageData(0, 0, w, hh).data);
    } catch { return null; }
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
    return rows.some((r) => r.type === 'text') ? { kind: 'content', rows } : { kind: 'picker' };
  }

  private saveLyricsJobs() { try { localStorage.setItem(LYRICS_JOBS, JSON.stringify(Object.fromEntries(this.lyricsJobs))); } catch { /* sin storage */ } }

  /** POST /library/{h}/lyrics (al reprocesar, antes DELETE de la vieja) y a esperar el job. */
  private async requestLyrics(e: LibraryEntry, lang: string | null, again: boolean, durSec: number, set: (st: LyricsState) => void) {
    set({ kind: 'processing' });
    try {
      if (again) await this.api.deleteLyrics(e.hash);
      const r = await this.api.requestLyrics(e.hash, lang);
      if (!r.job_id) throw new ApiError(0, 'no_job');
      this.lyricsJobs.set(r.job_id, e.hash); this.saveLyricsJobs();
      this.pollLyrics(e, r.job_id, durSec, set);
    } catch (err) {
      // 409: voces aun no listas o job ya activo -> aviso y a elegir otra vez
      if (err instanceof ApiError && err.status === 409) { toast(t('lyrics_no_vocals')); set({ kind: 'picker' }); return; }
      if (err instanceof ApiError && err.status === 429) { toast(t('err_job_limit')); set({ kind: 'picker' }); return; }
      set({ kind: 'error' });
    }
  }

  private pollLyrics(e: LibraryEntry, jobId: string, durSec: number, set: (st: LyricsState) => void) {
    clearTimeout(this.lyricsTimer);
    const tick = async () => {
      if (this.current?.entry.hash !== e.hash) return; // otra cancion: se retoma al volver
      let st;
      try { st = await this.api.job(jobId); }
      catch (err) {
        if (err instanceof ApiError && err.status === 404) { this.forgetLyricsJob(jobId); set(await this.loadLyrics(e, durSec)); return; }
        this.lyricsTimer = window.setTimeout(tick, LYRICS_POLL_MS); return;
      }
      if (st.state === 'done') {
        this.forgetLyricsJob(jobId);
        const got = await this.loadLyrics(e, durSec);
        set(got.kind === 'content' ? got : { kind: 'error' });
        return;
      }
      if (st.state === 'error' || st.state === 'cancelled') {
        this.forgetLyricsJob(jobId);
        const c = st.error_code;
        // timeout / GPU ocupada / sin voces: aviso y vuelta a elegir; el resto, pantalla de error
        if (c === 'timeout') { toast(t('lyrics_timeout')); set({ kind: 'picker' }); }
        else if (c === 'gpu_busy') { toast(t('job_err_gpu_busy')); set({ kind: 'picker' }); }
        else if (c === 'vocals_missing') { toast(t('lyrics_no_vocals')); set({ kind: 'picker' }); }
        else if (c === 'cancelled') set({ kind: 'picker' });
        else set({ kind: 'error' });
        return;
      }
      this.lyricsTimer = window.setTimeout(tick, LYRICS_POLL_MS);
    };
    this.lyricsTimer = window.setTimeout(tick, LYRICS_POLL_MS);
  }

  private forgetLyricsJob(id: string) { this.lyricsJobs.delete(id); this.saveLyricsJobs(); }

  private async cancelLyrics(e: LibraryEntry, set: (st: LyricsState) => void) {
    clearTimeout(this.lyricsTimer);
    const live = [...this.lyricsJobs].find(([, hsh]) => hsh === e.hash);
    if (live) { try { await this.api.cancelJob(live[0]); } catch { /* ya no estaba */ } this.forgetLyricsJob(live[0]); }
    set({ kind: 'picker' });
  }

  /** Anterior / siguiente entre las descargadas, en el orden de la lista. */
  private step(dir: 1 | -1) {
    if (!this.current) return;
    const next = adjacent(this.current.entry.hash, dir, this.rows, this.queue);
    const e = next ? this.entries.find((x) => x.hash === next) : null;
    if (e) this.open(e);
  }

  private stopSong() {
    this.flushSave?.();
    if (!this.current) return;
    this.current.player.pause();
    this.current.view.destroy();
    this.current = null;
  }
}
