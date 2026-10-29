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
import { buildBeatCells, chordsOverWords, parseChords, parseTimes } from './player/chords.ts';
import { h } from './ui/dom.ts';
import { loginView } from './ui/login.ts';
import { idleBar, PlayerView } from './ui/playerView.ts';
import { Sidebar } from './ui/sidebar.ts';
import { Nebula } from './ui/nebula.ts';
import { accentPalette, pulseFor } from './player/nebulaMath.ts';
import { ACCENTS, type SettingsStore } from './settings.ts';
import { openSettings } from './ui/settingsView.ts';
import { cssRgb, songColors, type SongColors } from './player/songPalette.ts';
import { formatChord } from './player/chords.ts';
import pkg from '../package.json' with { type: 'json' };
import { capture, idbParamsStore, restore, type ParamsStore } from './player/songParams.ts';

const JOB_POLL_MS = 4000;

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
      onPick: (r) => this.pick(r),
      onSettings: () => openSettings(this.settings, { user: s.user, server: location.host, webVersion: pkg.version,
        serverInfo: () => this.api.serverInfo().catch(() => null), onLogout: () => { this.api.logout(); this.showLogin(); } }),
      cover: (hash) => this.cover(hash),
    });
    this.nebula?.destroy();
    this.nebula = new Nebula();
    this.nebula.setColors(accentPalette(ACCENTS[this.settings.get('accentId')]));
    this.nebula.setEnabled(this.settings.get('nebula'));
    this.shell = h('div', { class: 'app' }, this.nebula.el, this.sidebar.el, this.hintMain(t('web_pick_song')), idleBar());
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
    this.rows = buildRows({ entries: this.entries, downloaded: this.downloaded, downloading: this.downloading, jobs: this.jobs }, this.settings.get('sortAsc'));
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
    const curtain = h('div', { class: 'curtain', attrs: { role: 'status' } }, h('span', { class: 'spin' }), t('web_loading_song'));
    this.shell.querySelector('.main')?.append(curtain);
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
      const view = new PlayerView(player, e, await this.cover(e.hash), {
        onPrev: () => this.step(-1), onNext: () => this.step(1),
        onEnded: () => this.step(1), onPlayState: () => this.render(),
        onBeat: (pos, bpb, bpm) => { const k = pulseFor(pos, bpb, bpm); if (k) this.nebula?.beat(k); },
        nebula: { get: () => this.settings.get('nebula'), set: (on) => this.settings.set('nebula', on) },
        formatChord: (c) => formatChord(c, this.settings.get('chordTranspose') ? player.pitch : 0, this.settings.get('chordLatin'), this.settings.get('chordFlat')),
        hasBasicChords: hasBasic,
        onChordsBasic: (basic) => { player.setChordsBasic(basic); applyChords(); },
        onPitch: () => { if (this.settings.get('chordTranspose')) view.reformatChords(); },
      });
      this.current = { entry: e, player, view };
      this.shell.replaceChildren(this.nebula!.el, this.sidebar!.el, view.main, view.bar);
      this.applySongColors();
      this.render();
      // Acordes avanzados o basicos (por cancion); la letra los lleva encima
      let lyrics: LyricsState = { kind: 'loading' };
      const applyChords = () => {
        const { cells, beatsPerBar } = buildBeatCells(parseBeats(beatsTxt), parseTimes(txt('downbeats.txt')), parseChords(txt(player.chordsBasic ? 'chords_basic.txt' : 'chords.txt')));
        view.setChords(cells, beatsPerBar);
        view.setLyrics(lyrics.kind === 'content' ? { ...lyrics, chords: chordsOverWords(lyrics.rows, cells) } : lyrics);
      };
      applyChords();
      this.loadLyrics(e, rep.durationMs / 1000).then((st) => { if (this.current?.view !== view) return; lyrics = st; applyChords(); });
      await view.toggle(); // abrir = reproducir, como Android
    } catch (err) {
      curtain.remove();
      const msg = err instanceof Error && err.message === 'engine_needs_isolation' ? t('web_engine_isolation') : t('err_song_missing_files');
      console.error('open', err);
      if (!this.current) this.shell.replaceChildren(this.nebula!.el, this.sidebar!.el, this.hintMain(msg), idleBar());
    } finally { this.opening = false; }
  }

  private onSetting(k: string) {
    const cur = this.current;
    if (k === 'nebula') this.nebula?.setEnabled(this.settings.get('nebula'));
    if (k === 'accentId' || k === 'songColors') this.applySongColors();
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
    this.flushSave?.();
    if (!this.current) return;
    this.current.player.pause();
    this.current.view.destroy();
    this.current = null;
  }
}
