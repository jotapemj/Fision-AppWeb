// Vista Letra: linea activa centrada, karaoke por palabra, tocar = seek (maqueta player.html).
import { t } from '../i18n/i18n.ts';
import { activeRow, hasWords, KARAOKE_FADE_SEC, switchAt, wordProgress, type LyricRow } from '../player/lyrics.ts';
import { h, img } from './dom.ts';
import { LYRICS_LANGS, type LyricsLang } from '../player/lyricsLangs.ts';

const KARAOKE_PREF = 'fision.lyrics_karaoke_mode'; // lyrics_karaoke_mode, default false

function loadKaraoke(): boolean { try { return localStorage.getItem(KARAOKE_PREF) === '1'; } catch { return false; } }
function saveKaraoke(on: boolean) { try { localStorage.setItem(KARAOKE_PREF, on ? '1' : '0'); } catch { /* sin storage */ } }

/** chords: "fila:palabra" -> acorde (acordes sobre la letra, solo web). */
export type LyricsState = { kind: 'loading' } | { kind: 'none' }
  | { kind: 'picker'; reprocess?: boolean } // sin letra (o reprocesar): elegir idioma y pedirla
  | { kind: 'processing' }                  // job de Whisper en marcha
  | { kind: 'error' }
  | { kind: 'content'; rows: LyricRow[]; chords?: Map<string, string>; fmt?: (c: string | null) => string };

/** Acciones de la transcripcion (las pone la app; sin ellas no se ofrece pedir letra). */
export interface LyricsActions {
  request(lang: string | null, reprocess: boolean): void;
  cancelJob(): void;
  /** Volver de reprocesar sin pedir nada (a la letra que habia). */
  back(): void;
  reprocess(): void;
}

export class LyricsView {
  private scroller = h('div', { class: 'lyrics' });
  // Opciones fuera del scroller: su mascara de fundido las borraba
  readonly el = h('div', { class: 'lywrap' }, this.scroller);
  private lines: HTMLElement[] = [];
  private words: HTMLElement[][] = [];
  private rows: LyricRow[] = [];
  private active = -2;
  private karaoke = loadKaraoke();
  // Fila tocada: sigue encendida hasta que el reloj llega a `until` (lo oido va por detras del seek).
  // `kar` fija el karaoke (palabra tocada encendida). Un seek lejos (antes de from - 1 s) la suelta.
  private hold: { idx: number; until: number; from: number; kar: number } | null = null;
  private onSeek: (sec: number) => void;
  actions: LyricsActions | null = null;

  constructor(state: LyricsState, onSeek: (sec: number) => void) {
    this.onSeek = onSeek;
    this.set(state);
  }

  set(state: LyricsState) {
    this.active = -2;
    this.hold = null;
    if (state.kind === 'picker' || state.kind === 'processing' || state.kind === 'error') {
      this.rows = []; this.lines = []; this.words = [];
      this.el.replaceChildren(state.kind === 'picker' ? this.picker(!!state.reprocess) : this.processing(state.kind === 'error'));
      return;
    }
    if (state.kind !== 'content') {
      this.rows = []; this.lines = []; this.words = [];
      this.el.replaceChildren(this.scroller);
      this.scroller.replaceChildren(state.kind === 'loading' ? h('div', { class: 'skel', attrs: { 'aria-busy': 'true' } }, h('i'), h('i'), h('i'), h('i'))
        : h('p', { class: 'soon', textContent: t('web_no_lyrics') }));
      return;
    }
    this.rows = state.rows;
    const karaokeOk = hasWords(this.rows);
    const sw = h('button', { class: 'switch', attrs: { role: 'switch', 'aria-checked': String(this.karaoke && karaokeOk), 'aria-label': t('lyrics_karaoke_mode') }, disabled: !karaokeOk,
      title: karaokeOk ? '' : t('lyrics_karaoke_unavailable') });
    sw.onclick = () => { this.karaoke = !this.karaoke; saveKaraoke(this.karaoke); sw.setAttribute('aria-checked', String(this.karaoke)); this.scroller.classList.toggle('kar', this.karaoke); this.active = -2; };
    const opts = h('div', { class: 'lyopts' }, h('label', {}, t('lyrics_karaoke_mode'), sw));
    if (this.actions) {
      const rp = h('button', { class: 'btn ghost', textContent: t('lyrics_reprocess') });
      rp.onclick = () => this.actions?.reprocess();
      opts.append(rp);
    }
    this.lines = []; this.words = [];
    const chords = state.chords ?? new Map<string, string>();
    const fmt = state.fmt ?? ((c: string | null) => c ?? '');
    const withChords = chords.size > 0;
    const list = h('div', { class: `lylist${withChords ? ' withch' : ''}` });
    this.rows.forEach((r, ri) => {
      const line = h('div', { class: `cl${r.type === 'instrumental' ? ' ins' : ''}`, attrs: { role: 'button', tabindex: '0' } });
      const ws: HTMLElement[] = [];
      if (r.type === 'instrumental') line.textContent = '♪';
      else if (r.words.length) {
        r.words.forEach((w, k) => {
          // Con acordes: celda de dos pisos (acorde encima, palabra debajo)
          const s = withChords
            ? h('span', { class: 'wd' }, h('i', { class: 'ch', textContent: fmt(chords.get(`${ri}:${k}`) ?? null) }), h('span', { textContent: w.text }))
            : h('span', { class: 'wd', textContent: w.text });
          // Palabra: seek a su onset (solo en karaoke; si no, la linea entera)
          s.onclick = (ev) => { if (this.karaoke) { ev.stopPropagation(); this.tap(ri, w.onset, w.onset, w.onset + KARAOKE_FADE_SEC); } };
          ws.push(s);
          line.append(s, k < r.words.length - 1 && !withChords ? ' ' : '');
        });
      } else line.textContent = r.text;
      const tapLine = () => this.tap(ri, r.start, switchAt(this.rows, ri), r.start);
      line.onclick = tapLine;
      line.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapLine(); } };
      this.lines.push(line); this.words.push(ws); list.append(line);
    });
    this.scroller.classList.toggle('kar', this.karaoke && karaokeOk);
    this.scroller.replaceChildren(list);
    this.el.replaceChildren(opts, this.scroller);
  }

  /** PICKER: "Procesar letra" + tarjeta de idioma (Auto al empezar) + Confirmar; Cancelar al reprocesar. */
  private picker(reprocess: boolean): HTMLElement {
    let lang: LyricsLang = LYRICS_LANGS[0];
    const flagEl = h('span', { class: 'lyflag' }), name = h('b');
    const paint = () => { flagEl.replaceChildren(img(lang.flag, '', '')); flagEl.classList.toggle('auto', lang.code === null); name.textContent = t(lang.key); };
    const card = h('button', { class: 'lycard', attrs: { 'aria-haspopup': 'dialog' } }, flagEl, h('span', { class: 'lyct' }, h('small', { textContent: t('lyrics_card_title') }), name), h('span', { class: 'chev', textContent: '▾', attrs: { 'aria-hidden': 'true' } }));
    card.onclick = () => this.langDialog(lang, (l) => { lang = l; paint(); });
    const ok = h('button', { class: 'btn', textContent: t('lyrics_confirm') });
    ok.onclick = () => this.actions?.request(lang.code, reprocess);
    const cancel = h('button', { class: 'btn ghost lyred', textContent: t('lyrics_cancel'), hidden: !reprocess });
    cancel.onclick = () => this.actions?.back();
    paint();
    if (!this.actions) return h('div', { class: 'lystate' }, h('p', { class: 'soon', textContent: t('web_no_lyrics') }));
    return h('div', { class: 'lystate' }, h('h2', { textContent: t('lyrics_title_process') }), card, ok, cancel);
  }

  /** SKELETON / ERROR: "Procesando letra" con barras y Cancelar (pide confirmacion); el error vuelve a elegir. */
  private processing(error: boolean): HTMLElement {
    const cancel = h('button', { class: 'btn ghost lyred', textContent: t(error ? 'lyrics_reprocess' : 'lyrics_cancel') });
    cancel.onclick = () => {
      if (error) { this.set({ kind: 'picker' }); return; }
      if (confirm(t('lyrics_cancel_dialog_title'))) this.actions?.cancelJob();
    };
    const skel = h('div', { class: 'skel mini', attrs: { 'aria-busy': 'true' } }, h('i'), h('i'), h('i'), h('i'), h('i'), h('i'));
    return h('div', { class: 'lystate', attrs: { role: 'status' } }, h('h2', { textContent: t(error ? 'lyrics_error' : 'lyrics_processing') }), error ? '' : skel, cancel);
  }

  private langDialog(cur: LyricsLang, pick: (l: LyricsLang) => void) {
    const close = h('button', { class: 'xbtn', textContent: '✕', attrs: { 'aria-label': t('web_close') } });
    const list = h('div', { class: 'lylangs', attrs: { role: 'listbox', 'aria-label': t('lyrics_card_title') } }, ...LYRICS_LANGS.map((l) => {
      const b = h('button', { class: 'lylang', attrs: { role: 'option', 'aria-selected': String(l === cur) } },
        h('span', { class: `lyflag${l.code === null ? ' auto' : ''}` }, img(l.flag, '', '')), h('span', { textContent: t(l.key) }), h('span', { class: 'ck', textContent: l === cur ? '✓' : '' }));
      b.onclick = () => { pick(l); dlg.close(); };
      return b;
    }));
    const dlg = h('dialog', { class: 'settings lydlg', attrs: { 'aria-label': t('lyrics_card_title') } }, h('div', { class: 'shd' }, h('h2', { textContent: t('lyrics_card_title') }), close), list);
    close.onclick = () => dlg.close();
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
    dlg.showModal();
    (list.querySelector('[aria-selected=true]') as HTMLElement | null)?.focus();
  }

  /** Toque (holdLyricsRow): seek y la fila se enciende ya, tambien en pausa. */
  private tap(idx: number, seekSec: number, until: number, kar: number) {
    this.onSeek(seekSec);
    this.hold = { idx, until, from: seekSec, kar };
    this.paint(idx, kar);
  }

  /** t = reloj de letra (s). Llamar en cada frame con la vista visible. */
  tick(sec: number) {
    if (!this.rows.length) return;
    let i = activeRow(this.rows, sec), kar = sec;
    const hd = this.hold;
    if (hd && (sec >= hd.until || sec < hd.from - 1)) this.hold = null;
    else if (hd) { i = hd.idx; kar = Math.max(sec, hd.kar); }
    this.paint(i, kar);
  }

  private paint(i: number, sec: number) {
    if (i !== this.active) {
      if (this.active >= 0) { this.lines[this.active]?.classList.remove('now'); for (const w of this.words[this.active] ?? []) w.style.removeProperty('--k'); }
      this.active = i;
      if (i >= 0) {
        const el = this.lines[i];
        el.classList.add('now');
        // Centrar la linea activa (scroll suave, como el LinearSmoothScroller)
        const box = this.scroller;
        box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: 'smooth' });
      }
    }
    if (i >= 0 && this.karaoke) {
      const r = this.rows[i];
      this.words[i].forEach((el, k) => el.style.setProperty('--k', String(wordProgress(r.words[k], sec))));
    }
  }
}
