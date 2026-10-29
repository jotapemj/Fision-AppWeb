// Lateral de escritorio: marca, buscador, filtro, canciones y cuenta (maqueta player.html).
import { t } from '../i18n/i18n.ts';
import { applyFilter, counts, search, type Filter, type Row } from '../library/library.ts';
import { dismissable, h, img } from './dom.ts';
import wordmark from '../assets/icons/wordmark.svg';

export interface SidebarHooks {
  onPick(row: Row): void;
  onLogout(): void;
  cover(hash: string): Promise<string | null>;
}

const SEARCH_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="#9e9e9e" stroke-width="2" fill="none"/><path d="M15.5 15.5 21 21" stroke="#9e9e9e" stroke-width="2"/></svg>';
const CLOUD_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.5 4.5 0 0 0 7 18z" fill="none" stroke="#919191" stroke-width="1.7"/></svg>';
const ring = (pct: number) => `<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" stroke="#333" stroke-width="2.5" fill="none"/><circle cx="10" cy="10" r="7.5" stroke="var(--accent)" stroke-width="2.5" fill="none" stroke-dasharray="${(47.1 * pct / 100).toFixed(1)} 47.1" transform="rotate(-90 10 10)"/></svg>`;
const svg = (markup: string) => { const s = h('span', { class: 'st' }); s.innerHTML = markup; return s; };

const JOB_ERR = 'cloud_state_error';

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

  constructor(user: string, server: string, hooks: SidebarHooks) {
    this.hooks = hooks;
    const input = h('input', { type: 'search', placeholder: t('web_search'), attrs: { 'aria-label': t('web_search') } });
    input.oninput = () => { this.q = input.value; this.render(); };
    const find = h('label', { class: 'find' });
    find.innerHTML = SEARCH_SVG;
    find.append(input);
    this.flt.onclick = () => this.openFilterMenu();
    const bar = h('div', { class: 'bar2' }, h('span', { class: 't', textContent: t('tab_songs') }), this.flt, this.count);
    const me = h('div', { class: 'me' },
      h('span', { class: 'av', textContent: user.slice(0, 1).toUpperCase(), attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'who' }, h('b', { textContent: user }), h('span', { textContent: server })),
      h('button', { class: 'out', textContent: t('settings_logout_title'), onclick: () => hooks.onLogout() }));
    this.el = h('aside', { class: 'pane' }, h('div', { class: 'hd' }, img(wordmark, 'wm', 'Fision')), find, bar, this.list, me);
  }

  update(rows: Row[], current: string | null, playing: boolean) {
    this.rows = rows; this.current = current; this.playing = playing;
    this.render();
  }

  private render() {
    const c = counts(this.rows);
    if (!c.showFilter) this.filter = 'all';
    const label = { all: 'library_filter_all', downloaded: 'library_filter_downloaded', cloud: 'library_filter_cloud' }[this.filter];
    const n = { all: c.all, downloaded: c.downloaded, cloud: c.cloud }[this.filter];
    this.flt.hidden = !c.showFilter;
    this.flt.textContent = `${t(label)} · ${n} ▾`;
    this.count.hidden = c.showFilter;
    this.count.textContent = String(c.all);

    const shown = search(applyFilter(this.rows, this.filter), this.q);
    if (!shown.length) {
      this.list.replaceChildren(h('p', { class: 'empty', textContent: this.rows.length ? t('no_results') : t('songs_empty_title') }));
      return;
    }
    this.list.replaceChildren(...shown.map((r) => this.rowEl(r)));
  }

  private rowEl(r: Row): HTMLElement {
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
      case 'downloading': veil = h('span', { class: 'veil' }); side = svg(ring(s.pct)); sub = t('cloud_state_downloading', s.pct); break;
      case 'queued': veil = h('span', { class: 'veil' }, h('span', { class: 'spin' })); sub = s.position ? t('cloud_state_queued_pos', s.position) : t('cloud_state_queued'); break;
      case 'running': veil = h('span', { class: 'veil' }, h('span', { class: 'spin' })); sub = t('cloud_state_running'); break;
      case 'waiting_gpu': veil = h('span', { class: 'veil' }, h('span', { class: 'spin gpu' })); sub = t('cloud_state_waiting_gpu'); break;
      case 'error': veil = h('span', { class: 'veil' }); sub = t(JOB_ERR); bad = true; break;
      case 'downloaded': break;
    }
    if (cur) veil = h('span', { class: 'veil' }, h('span', { class: `eq${this.playing ? '' : ' paused'}` }, h('i'), h('i'), h('i')));
    if (veil) cv.append(veil);
    const btn = h('button', { class: `dr${cur ? ' cur' : ''}${s.kind === 'cloud' || s.kind === 'downloading' ? ' cld' : ''}`, attrs: { role: 'listitem', ...(cur ? { 'aria-current': 'true' } : {}) } },
      cv, h('span', { class: 'tx' }, h('b', { textContent: e.title || e.filename }), h('span', { class: bad ? 'bad' : '', textContent: sub })), side);
    btn.onclick = () => this.hooks.onPick(r);
    return btn;
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
