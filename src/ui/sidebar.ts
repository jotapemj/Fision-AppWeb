// Lateral de escritorio: marca, buscador, filtro, canciones, playlists y cuenta (maqueta player.html).
// Abrir una playlist cambia la lista por sus canciones (PlaylistActivity) con una cabecera para volver.
// Movil (.app.mob): la misma pieza hace de MainActivity: cabecera con avatar, titulo grande, buscador + anadir,
// chips de filtro, orden y pestanas Canciones / Playlists abajo. Lo de un modo se oculta en el otro por CSS.
import { t } from '../i18n/i18n.ts';
import { applyFilter, counts, fold, search, type Filter, type Row } from '../library/library.ts';
import { dismissable, h, img } from './dom.ts';
import { icon } from './icons.ts';
import wordmark from '../assets/icons/wordmark.svg';
import icMark from '../assets/icons/ic_fision_mark.svg';
import icOrder from '../assets/icons/ic_orderby.png';
import { CoverWave } from './coverWave.ts';
import type { Playlist, PlaylistSummary } from '../api/client.ts';
import { playlistRows } from '../library/playlists.ts';
import { jobErrorKey } from '../library/importConfig.ts';
import { views, type Step } from './coachMark.ts';

/** Opcion del menu ⋯ de una fila. */
export interface RowMenuItem { label: string; danger?: boolean; disabled?: boolean; run(): void }

export interface SidebarHooks {
  /** `queue` = canciones de la playlist abierta (contexto de prev/next) o null = biblioteca. */
  onPick(row: Row, queue: string[] | null): void;
  onOpenPlaylist(id: string): void;
  onClosePlaylist(): void;
  onNewPlaylist(): void;
  onEditPlaylist(p: Playlist): void;
  onDeletePlaylist(p: Playlist): void;
  /** 1 url = portada propia; varias = mosaico; vacio = sin nada. */
  playlistCover(p: PlaylistSummary): Promise<string[]>;
  onSettings(): void;
  onAdd(): void;
  cover(hash: string): Promise<string | null>;
  /** Opciones de la fila (hoja de opciones de Android). */
  rowMenu(row: Row): RowMenuItem[];
  /** Orden de la lista (songs_sort_order): true = antiguas primero. */
  sortAsc(): boolean;
  onSort(asc: boolean): void;
}

export type LibTab = 'songs' | 'playlists';

const SEARCH_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="#9e9e9e" stroke-width="2" fill="none"/><path d="M15.5 15.5 21 21" stroke="#9e9e9e" stroke-width="2"/></svg>';
const CLOUD_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.5 4.5 0 0 0 7 18z" fill="none" stroke="#919191" stroke-width="1.7"/></svg>';
const svg = (markup: string) => { const s = h('span', { class: 'st' }); s.innerHTML = markup; return s; };
// Pestanas de Android (Material Symbols library_music / playlist)
const TAB_SONGS_SVG = '<svg viewBox="0 -960 960 960" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M493.85-366.15q37.76 0 63.88-26.12 26.11-26.11 26.11-63.88v-224.62h114.62v-70.77h-150v226.16q-11.46-10.39-25.11-15.58-13.66-5.19-29.5-5.19-37.77 0-63.89 26.11-26.11 26.12-26.11 63.89 0 37.77 26.11 63.88 26.12 26.12 63.89 26.12ZM322.31-260Q292-260 271-281q-21-21-21-51.31v-455.38Q250-818 271-839q21-21 51.31-21h455.38Q808-860 829-839q21 21 21 51.31v455.38Q850-302 829-281q-21 21-51.31 21H322.31Zm0-60h455.38q4.62 0 8.46-3.85 3.85-3.84 3.85-8.46v-455.38q0-4.62-3.85-8.46-3.84-3.85-8.46-3.85H322.31q-4.62 0-8.46 3.85-3.85 3.84-3.85 8.46v455.38q0 4.62 3.85 8.46 3.84 3.85 8.46 3.85Zm-140 200Q152-120 131-141q-21-21-21-51.31v-515.38h60v515.38q0 4.62 3.85 8.46 3.84 3.85 8.46 3.85h515.38v60H182.31Z"/></svg>';
const TAB_PL_SVG = '<svg viewBox="0 0 960 960" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M120 640V560H440V640ZM120 480V400H600V480ZM120 320V240H600V320ZM640 840V520L880 680Z"/></svg>';
const PLUS_SVG = '<svg viewBox="0 0 24 24" width="29" height="29" aria-hidden="true"><path fill="#fff" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
// ic_cloud_link de Android: nube con eslabon
const cloudLink = (px: number) => `<svg viewBox="0 0 24 24" width="${px}" height="${px}" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path stroke-width="2" d="M1.16,14.15A4.56,4.56 0 0 1 6.35,8.7A5.51,5.51 0 0 1 17.2,7.21A5.28,5.28 0 1 1 17.54,17.76L12.6,17.76"/><path stroke-width="1.7" d="M3.25,16.6L2.1,17.74A2.38,2.38 0 0 0 5.46,21.1L6.6,19.95"/><path stroke-width="1.7" d="M5.4,14.45L6.54,13.3A2.38,2.38 0 0 1 9.9,16.66L8.75,17.8"/><path stroke-width="1.7" d="M4.25,18.95L7.75,15.45"/></svg>`;
const CLOUD_FLASH_MS = 3000, CLOUD_FADE_MS = 350;


export class Sidebar {
  readonly el: HTMLElement;
  private list = h('div', { class: 'list', attrs: { role: 'list' } });
  private flt = h('button', { class: 'flt', attrs: { 'aria-haspopup': 'menu' } });
  private count = h('span', { class: 'count' });
  private q = '';
  private filter: Filter = 'all'; // no se guarda (§1.4)
  private rows: Row[] = [];
  private current: string | null = null;
  private playing = false;
  private hooks: SidebarHooks;
  private waves = new Map<string, CoverWave>(); // una por descarga: conserva el nivel entre repintados
  private plList = h('div', { class: 'pls', attrs: { role: 'list' } });
  private plAdd = h('button', { class: 'pladd', attrs: { 'aria-label': t('playlist_new'), title: t('playlist_new') } }, icon('plus'));
  private playlists: PlaylistSummary[] = [];
  private canEdit = false;
  private open: Playlist | null = null;
  private bar: HTMLElement;
  private plHead = h('div', { class: 'plhead' });

  private server: string;
  private srv = h('span', { attrs: { role: 'status' } });
  // --- movil ---
  private tab: LibTab = 'songs';
  private mTitle = h('h1', { class: 'mtitle' });
  private chips = h('div', { class: 'chips', attrs: { role: 'radiogroup', 'aria-label': t('tab_songs') } });
  private mCount = h('p', { class: 'mcount' });
  // Estado del servidor: nube en la cabecera movil y en el pie de escritorio
  private mCloud = h('span', { class: 'ccloud mcloud', attrs: { role: 'status' } });
  private dCloud = h('span', { class: 'ccloud', attrs: { role: 'status' } });
  private reach: boolean | null = null; // null = aun sin respuesta: ni rojo falso al arrancar
  private cloudTimer = 0;
  private navBtns = new Map<LibTab, HTMLButtonElement>();
  private plq = '';
  private plCount = h('p', { class: 'mcount' });
  private plNew: HTMLButtonElement;
  private input: HTMLInputElement;

  constructor(user: string, server: string, hooks: SidebarHooks) {
    this.server = server;
    this.srv.textContent = server;
    this.hooks = hooks;
    const input = this.input = h('input', { type: 'search', placeholder: t('web_search'), attrs: { 'aria-label': t('web_search') } });
    input.oninput = () => { this.q = input.value; this.render(); };
    const find = h('label', { class: 'find' });
    find.innerHTML = SEARCH_SVG;
    find.append(input);
    this.flt.onclick = () => this.openFilterMenu();
    const bar = this.bar = h('div', { class: 'bar2' }, h('h2', { class: 't', textContent: t('tab_songs') }), this.flt, this.count);
    this.plAdd.onclick = () => hooks.onNewPlaylist();
    const plSec = h('section', { class: 'plsec', attrs: { 'aria-label': t('tab_playlists') } }, h('div', { class: 'plbar' }, h('h2', { textContent: t('tab_playlists') }), this.plAdd), this.plList);
    const me = h('div', { class: 'me' },
      h('span', { class: 'av', textContent: user.slice(0, 1).toUpperCase(), attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'who' }, h('b', { textContent: user }), this.srv),
      this.dCloud,
      h('button', { class: 'gear', attrs: { 'aria-label': t('settings_toolbar_title') }, onclick: () => hooks.onSettings() }));
    me.lastElementChild!.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="3" stroke="#fff" stroke-width="1.6" fill="none"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>';
    const addBtn = h('button', { class: 'addb', attrs: { 'aria-label': t('import_title') }, onclick: () => hooks.onAdd() });
    addBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.5 4.5 0 0 0 7 18z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 15.5v-5M9.6 12.6 12 10.2l2.4 2.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    addBtn.append(t('b_add'));
    this.plHead.hidden = true;
    // --- movil: cabecera (nube roja sin conexion, marca, avatar = ajustes) ---
    this.mCloud.innerHTML = cloudLink(26); this.dCloud.innerHTML = cloudLink(22);
    this.mCloud.hidden = this.dCloud.hidden = true;
    const avatar = h('button', { class: 'mav', textContent: user.slice(0, 1).toUpperCase(), attrs: { 'aria-label': t('settings_toolbar_title') }, onclick: () => hooks.onSettings() });
    const mhd = h('div', { class: 'mhd' }, this.mCloud, img(wordmark, 'wm', 'Fision'), avatar);
    // Buscador + anadir (squircle con la marca), como et_find + b_add
    const msq = h('button', { class: 'msq', attrs: { 'aria-label': t('import_title') }, onclick: () => hooks.onAdd() }, img(icMark, '', ''));
    const frow = h('div', { class: 'frow' }, find, msq);
    const sort = h('button', { class: 'msort', attrs: { 'aria-label': t('order_by_title'), 'aria-haspopup': 'menu' } }, img(icOrder, '', ''));
    sort.onclick = () => this.openSortMenu(sort);
    const chipRow = h('div', { class: 'chiprow' }, this.chips, this.mCount, sort);
    // Pestana Playlists: buscador propio + nueva + cuenta
    const plInput = h('input', { type: 'search', placeholder: t('te_find_playlist'), attrs: { 'aria-label': t('te_find_playlist') } });
    plInput.oninput = () => { this.plq = plInput.value; this.renderPlaylists(); };
    const plFind = h('label', { class: 'find' });
    plFind.innerHTML = SEARCH_SVG;
    plFind.append(plInput);
    this.plNew = h('button', { class: 'msq', attrs: { 'aria-label': t('playlist_new') }, onclick: () => hooks.onNewPlaylist() });
    this.plNew.innerHTML = PLUS_SVG;
    plSec.insertBefore(h('div', { class: 'mpl' }, h('div', { class: 'frow' }, plFind, this.plNew), this.plCount), this.plList);
    const nav = h('nav', { class: 'mnav' });
    for (const [k, label, icon] of [['songs', t('tab_songs'), TAB_SONGS_SVG], ['playlists', t('tab_playlists'), TAB_PL_SVG]] as const) {
      const b = h('button', { attrs: { 'aria-pressed': String(k === this.tab) }, onclick: () => this.setTab(k) });
      b.innerHTML = icon;
      b.append(h('span', { textContent: label }));
      this.navBtns.set(k, b); nav.append(b);
    }
    this.el = h('aside', { class: 'pane', attrs: { 'data-tab': this.tab } }, mhd, this.mTitle, h('div', { class: 'hd' }, h('h1', { class: 'hdt' }, img(wordmark, 'wm', 'Fision')), addBtn), frow,
      h('div', { class: 'lhead' }, bar, chipRow, this.plHead), this.list, plSec, me, nav);
    this.mTitle.textContent = t('tab_songs');
    // Tour de la biblioteca (MainActivity.maybeStartLibraryTour)
    this.tourSteps = () => {
      const first = this.list.querySelector('.drw');
      return [
        // views() une solo lo visible: cada paso vale para escritorio y movil
        { target: views(addBtn, msq), title: t('coach_lib_add_title'), body: t('web_coach_add_body') },
        { target: views(find, this.flt, this.chips), title: t('coach_lib_search_title'), body: t('coach_lib_search_body'), corner: 16 },
        first // biblioteca vacia: el aviso hace de primera cancion
          ? { target: views(first), title: t('coach_lib_song_title'), body: t('web_coach_song_body'), corner: 16 }
          : { target: views(this.list.querySelector('.empty')), title: t('coach_lib_song_title'), body: t('coach_lib_song_empty_body'), corner: 16 },
        { target: views(plSec.firstElementChild, this.navBtns.get('playlists')), title: t('coach_lib_playlists_title'), body: t('coach_lib_playlists_body'), corner: 16 },
        { target: views(this.srv), title: t('coach_lib_cloud_title'), body: t('coach_lib_cloud_body'), corner: 10 },
        { target: views(me.lastElementChild, avatar), title: t('coach_lib_settings_title'), body: t('coach_lib_settings_body') },
      ];
    };
  }

  readonly tourSteps: () => Step[];

  /** Modo movil: el buscador dice lo de Android (te_find); en escritorio, corto. */
  setMobile(on: boolean) { this.input.placeholder = t(on ? 'te_find' : 'web_search'); }

  /** Pestana de la biblioteca movil (bnv_main). Cambiar de pestana cierra la playlist abierta. */
  setTab(k: LibTab) {
    if (k === this.tab) return;
    this.tab = k;
    this.el.dataset.tab = k;
    for (const [n, b] of this.navBtns) b.setAttribute('aria-pressed', String(n === k));
    this.mTitle.textContent = t(k === 'songs' ? 'tab_songs' : 'tab_playlists');
    if (this.open) this.hooks.onClosePlaylist();
  }

  /** Servidor inalcanzable: lo dice en rojo (nube roja de Android); lo descargado suena igual. */
  setOnline(on: boolean) {
    this.srv.classList.toggle('off', !on);
    this.setCloud(on);
    this.srv.textContent = on ? this.server : `${this.server} · ${t('server_status_offline')}`;
  }

  /** refreshCloudStatusIcon: sin conexion, rojo fijo; al volver, verde 3 s y se apaga; en linea, oculta. */
  private setCloud(on: boolean) {
    const was = this.reach;
    if (was === on) return; // cada sondeo repite el estado: no corta el destello
    this.reach = on;
    clearTimeout(this.cloudTimer);
    const all = [this.mCloud, this.dCloud];
    const paint = (hidden: boolean, ok: boolean, fade: boolean) => all.forEach((c) => {
      c.hidden = hidden; c.classList.toggle('ok', ok); c.classList.toggle('fade', fade);
      c.setAttribute('aria-label', t(on ? 'server_status_online' : 'server_status_offline'));
    });
    if (!on) { paint(false, false, false); return; }
    if (was !== false) { paint(true, false, false); return; }
    paint(false, true, false);
    this.cloudTimer = window.setTimeout(() => {
      paint(false, true, true);
      this.cloudTimer = window.setTimeout(() => paint(true, false, false), CLOUD_FADE_MS);
    }, CLOUD_FLASH_MS);
  }

  update(rows: Row[], current: string | null, playing: boolean) {
    this.rows = rows; this.current = current; this.playing = playing;
    this.render();
  }

  /** Playlists del server; sin server alcanzable no se crea ni se edita (canEdit). */
  setPlaylists(list: PlaylistSummary[], canEdit: boolean) {
    this.playlists = list; this.canEdit = canEdit;
    this.plAdd.disabled = this.plNew.disabled = !canEdit;
    if (this.open && !list.some((p) => p.id === this.open!.id)) this.open = null;
    this.renderPlaylists();
    this.render();
  }

  /** Abre (o cierra con null) una playlist en la lista. */
  showPlaylist(p: Playlist | null) {
    this.open = p;
    this.renderPlaylists();
    this.render();
  }

  get openPlaylist() { return this.open; }

  private renderPlaylists() {
    // Movil: busqueda en la pestana Playlists y linea de cuenta (MainActivity.refreshPlaylists)
    const f = fold(this.plq.trim());
    const shown = f ? this.playlists.filter((p) => fold(p.title).includes(f)) : this.playlists;
    this.plCount.textContent = f ? t('search_result_count', shown.length) : t('playlist_count', this.playlists.length);
    this.plCount.hidden = !this.playlists.length;
    if (!this.playlists.length) { this.plList.replaceChildren(h('p', { class: 'empty', textContent: t('playlists_empty_title') })); return; }
    if (!shown.length) { this.plList.replaceChildren(h('p', { class: 'empty', textContent: t('no_results') })); return; }
    this.plList.replaceChildren(...shown.map((p) => {
      const cv = h('span', { class: 'pcv' });
      this.hooks.playlistCover(p).then((urls) => {
        cv.classList.toggle('mosaic', urls.length > 1);
        cv.replaceChildren(...urls.map((u) => img(u, '', '')));
      });
      const b = h('button', { class: `plr${this.open?.id === p.id ? ' cur' : ''}`, attrs: { role: 'listitem', ...(this.open?.id === p.id ? { 'aria-current': 'true' } : {}) } },
        cv, h('span', { class: 'pt', textContent: p.title }), h('span', { class: 'pc', textContent: String(p.count) }));
      b.onclick = () => (this.open?.id === p.id ? this.hooks.onClosePlaylist() : this.hooks.onOpenPlaylist(p.id));
      return b;
    }));
  }

  /** Cabecera de la playlist abierta: volver, titulo con su cuenta y opciones. */
  private renderPlHead(p: Playlist) {
    const back = h('button', { class: 'ib plback', attrs: { 'aria-label': t('playlist_back') } }, icon('back'));
    back.onclick = () => this.hooks.onClosePlaylist();
    const opts = h('button', { class: 'ib plopt', attrs: { 'aria-label': t('playlist_options'), 'aria-haspopup': 'menu' } }, icon('more'));
    opts.disabled = !this.canEdit;
    opts.onclick = () => {
      if (opts.getAttribute('aria-expanded') === 'true') return;
      const menu = h('div', { class: 'menu', attrs: { role: 'menu' } },
        h('button', { textContent: t('playlist_edit_title'), attrs: { role: 'menuitem' }, onclick: () => { close(); this.hooks.onEditPlaylist(p); } }),
        h('button', { class: 'danger', textContent: t('playlist_delete'), attrs: { role: 'menuitem' }, onclick: () => { close(); this.hooks.onDeletePlaylist(p); } }));
      opts.setAttribute('aria-expanded', 'true');
      this.plHead.append(menu);
      const close = dismissable(menu, () => opts.setAttribute('aria-expanded', 'false'), [opts]);
      (menu.querySelector('button') as HTMLButtonElement).focus();
    };
    this.plHead.replaceChildren(back, h('span', { class: 'plt' }, h('b', { textContent: p.title }), h('span', { textContent: t('playlist_song_count', p.songs.length) })), opts);
  }

  private render() {
    const op = this.open;
    this.bar.hidden = !!op; this.plHead.hidden = !op;
    this.el.classList.toggle('plopen', !!op);
    if (op) {
      this.renderPlHead(op);
      const shown = search(playlistRows(op, this.rows), this.q);
      this.list.replaceChildren(...(shown.length ? shown.map((r) => this.rowEl(r, op.songs)) : [h('p', { class: 'empty', textContent: op.songs.length ? t('no_results') : t('playlist_empty_songs') })]));
      return;
    }
    const c = counts(this.rows);
    if (!c.showFilter) this.filter = 'all';
    const label = { all: 'library_filter_all', downloaded: 'library_filter_downloaded', cloud: 'library_filter_cloud' }[this.filter];
    const n = { all: c.all, downloaded: c.downloaded, cloud: c.cloud }[this.filter];
    this.flt.hidden = !c.showFilter;
    this.flt.replaceChildren(`${t(label)} · ${n}`, icon('chev', 14));
    this.count.hidden = c.showFilter;
    this.count.textContent = String(c.all);
    // Movil: chips con cuentas que siguen a la busqueda, o la linea de cuenta (MainActivity.updateCountLine)
    const found = search(this.rows, this.q), sc = counts(found);
    this.chips.hidden = !c.showFilter;
    this.mCount.hidden = c.showFilter;
    this.mCount.textContent = this.q.trim() ? t('search_result_count', found.length) : t('playlist_song_count', c.all);
    this.chips.replaceChildren(...(['all', 'downloaded', 'cloud'] as Filter[]).map((f) => {
      const k = { all: 'library_filter_all', downloaded: 'library_filter_downloaded', cloud: 'library_filter_cloud' }[f];
      return h('button', { class: 'chip', textContent: t('library_filter_chip', t(k), sc[f]), attrs: { role: 'radio', 'aria-checked': String(f === this.filter) },
        onclick: () => { this.filter = f; this.render(); } });
    }));

    // Olas de descargas terminadas fuera
    for (const [hash, w] of this.waves) if (!this.rows.some((r) => r.entry.hash === hash && r.state.kind === 'downloading')) { w.stop(); this.waves.delete(hash); }
    const shown = search(applyFilter(this.rows, this.filter), this.q);
    if (!shown.length) {
      this.list.replaceChildren(h('p', { class: 'empty', textContent: this.rows.length ? t('no_results') : t('songs_empty_title') }));
      return;
    }
    this.list.replaceChildren(...shown.map((r) => this.rowEl(r, null)));
  }

  private rowEl(r: Row, queue: string[] | null): HTMLElement {
    const { entry: e, state: s } = r;
    const cur = e.hash === this.current;
    const cv = h('span', { class: 'cv' });
    this.hooks.cover(e.hash).then((u) => { if (u) cv.prepend(img(u, '', '')); });
    let sub = e.artist;
    let side: HTMLElement | null = null;
    let veil: HTMLElement | null = null;
    let bad = false;
    switch (s.kind) {
      case 'cloud': veil = h('span', { class: 'veil' }); side = svg(CLOUD_SVG); break;
      case 'downloading': {
        // Ola de llenado sobre la portada (CoverFillWaveView)
        let w = this.waves.get(e.hash);
        if (!w) { w = new CoverWave(); this.waves.set(e.hash, w); this.hooks.cover(e.hash).then((u) => w!.setCover(u)); }
        w.setProgress(s.pct / 100);
        veil = w.el;
        sub = t('cloud_state_downloading', s.pct);
        break;
      }
      case 'queued': veil = h('span', { class: 'veil' }, h('span', { class: 'spin' })); sub = s.position ? t('cloud_state_queued_pos', s.position) : t('cloud_state_queued'); break;
      case 'running': veil = h('span', { class: 'veil' }, h('span', { class: 'spin' })); sub = t('cloud_state_running'); break;
      case 'waiting_gpu': veil = h('span', { class: 'veil' }, h('span', { class: 'spin gpu' })); sub = t('cloud_state_waiting_gpu'); break;
      case 'error': veil = h('span', { class: 'veil' }); sub = t(jobErrorKey(s.code)); bad = true; break;
      case 'downloaded': break;
    }
    if (cur) veil = h('span', { class: 'veil' }, h('span', { class: `eq${this.playing ? '' : ' paused'}` }, h('i'), h('i'), h('i')));
    if (veil) cv.append(veil);
    const btn = h('button', { class: `dr${cur ? ' cur' : ''}${s.kind === 'cloud' || s.kind === 'downloading' ? ' cld' : ''}`, attrs: cur ? { 'aria-current': 'true' } : {} },
      cv, h('span', { class: 'tx' }, h('b', { textContent: e.title || e.filename }), h('span', { class: bad ? 'bad' : '', textContent: sub })), side);
    btn.onclick = () => this.hooks.onPick(r, queue);
    // ⋯ al pasar (maqueta): fuera del boton de la fila (no se anidan botones)
    const more = h('button', { class: 'more', attrs: { 'aria-label': t('web_song_options', e.title || e.filename), 'aria-haspopup': 'menu' } }, h('i'), h('i'), h('i'));
    more.onclick = () => this.openRowMenu(r, more);
    return h('div', { class: 'drw', attrs: { role: 'listitem' } }, btn, more);
  }

  /** Menu fijo junto al ⋯ (la lista hace scroll y recortaria uno absoluto); sube si no cabe abajo. */
  private openRowMenu(r: Row, more: HTMLElement) {
    if (more.getAttribute('aria-expanded') === 'true') return;
    const menu = h('div', { class: 'menu rowmenu', attrs: { role: 'menu' } }, ...this.hooks.rowMenu(r).map((it) => {
      const b = h('button', { class: it.danger ? 'danger' : '', textContent: it.label, attrs: { role: 'menuitem' } });
      b.disabled = !!it.disabled;
      b.onclick = () => { close(); it.run(); };
      return b;
    }));
    more.setAttribute('aria-expanded', 'true');
    this.el.append(menu);
    const a = more.getBoundingClientRect(), m = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, a.right - m.width)}px`;
    menu.style.top = `${a.bottom + 4 + m.height > innerHeight - 8 ? a.top - 4 - m.height : a.bottom + 4}px`;
    const close = dismissable(menu, () => more.setAttribute('aria-expanded', 'false'), [more]);
    (menu.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus();
  }

  /** Ordenar por (order_by_dialog): recientes / antiguas primero. */
  private openSortMenu(btn: HTMLElement) {
    if (btn.getAttribute('aria-expanded') === 'true') return;
    const asc = this.hooks.sortAsc();
    const menu = h('div', { class: 'menu rowmenu', attrs: { role: 'menu', 'aria-label': t('order_by_title') } },
      ...([[false, 'order_by_date_desc'], [true, 'order_by_date_asc']] as const).map(([v, k]) =>
        h('button', { textContent: t(k), attrs: { role: 'menuitemradio', 'aria-checked': String(v === asc) }, onclick: () => { close(); this.hooks.onSort(v); } })));
    btn.setAttribute('aria-expanded', 'true');
    this.el.append(menu);
    const a = btn.getBoundingClientRect(), m = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, a.right - m.width)}px`;
    menu.style.top = `${a.bottom + 4}px`;
    const close = dismissable(menu, () => btn.setAttribute('aria-expanded', 'false'), [btn]);
    (menu.querySelector('button') as HTMLButtonElement).focus();
  }

  private openFilterMenu() {
    if (this.flt.getAttribute('aria-expanded') === 'true') return;
    const c = counts(this.rows);
    const opts: [Filter, string, number][] = [['all', 'library_filter_all', c.all], ['downloaded', 'library_filter_downloaded', c.downloaded], ['cloud', 'library_filter_cloud', c.cloud]];
    const menu = h('div', { class: 'menu', attrs: { role: 'menu' } }, ...opts.map(([f, k, n]) =>
      h('button', { attrs: { role: 'menuitemradio', 'aria-checked': String(f === this.filter) }, onclick: () => { this.filter = f; close(); this.render(); } },
        t(k), h('span', { textContent: String(n) }))));
    this.flt.setAttribute('aria-expanded', 'true');
    this.flt.parentElement!.append(menu);
    const close = dismissable(menu, () => this.flt.setAttribute('aria-expanded', 'false'), [this.flt]);
    (menu.querySelector('button') as HTMLButtonElement).focus();
  }
}
