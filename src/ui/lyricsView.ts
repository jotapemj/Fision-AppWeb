// Vista Letra: linea activa centrada, karaoke por palabra, tocar = seek (maqueta player.html).
import { t } from '../i18n/i18n.ts';
import { activeRow, CHORD_LAG_SEC, hasWords, KARAOKE_FADE_SEC, rowWords, switchAt, wordProgress, type LyricRow, type RowChord } from '../player/lyrics.ts';
import { h, img } from './dom.ts';
import icChordsOnLyrics from '../assets/icons/ic_chords_on_lyrics.svg';
import { LYRICS_LANGS, type LyricsLang } from '../player/lyricsLangs.ts';

const KARAOKE_PREF = 'fision.lyrics_karaoke_mode'; // lyrics_karaoke_mode, default false
// Desplazar a mano (decision JP, la web): al soltar, cerca de la linea activa se engancha y vuelve a
// seguir la cancion; lejos se desprende y se queda donde se dejo (hasta volver cerca, tocar o un seek)
const SNAP_NEAR = 0.3;        // fraccion del alto: distancia maxima de la activa al centro para engancharse
const SETTLE_MS = 150;        // fin del gesto: sin rueda ni arrastre en este tiempo
const SEEK_JUMP_SEC = 1.5;    // salto del reloj = seek: vuelve a engancharse

function loadKaraoke(): boolean { try { return localStorage.getItem(KARAOKE_PREF) === '1'; } catch { return false; } }
function saveKaraoke(on: boolean) { try { localStorage.setItem(KARAOKE_PREF, on ? '1' : '0'); } catch { /* sin storage */ } }

/** chords: acordes de cada fila (rowChords, como Android). */
export type LyricsState = { kind: 'loading' } | { kind: 'none' }
  | { kind: 'picker'; reprocess?: boolean } // sin letra (o reprocesar): elegir idioma y pedirla
  | { kind: 'processing' }                  // job de Whisper en marcha
  | { kind: 'error' }
  | { kind: 'content'; rows: LyricRow[]; chords?: RowChord[][]; fmt?: (c: string | null) => string };

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
  // Acordes sobre la letra (por cancion, apagado por defecto); el boton solo sale si hay acordes
  private chordsOn = false;
  private chords: RowChord[][] = [];
  private chordEls: HTMLElement[][] = [];     // .lc de cada fila (texto) o celdas de la tira (instrumental)
  private strips: (HTMLElement | null)[] = [];
  private stripCur: number[] = [];
  private chordBtn: HTMLButtonElement | null = null;
  private list: HTMLElement | null = null;
  private ro: ResizeObserver | null = null;
  private relayout = 0;
  /** Lo pone la app: guardar el interruptor de la cancion. */
  onChordsToggle: ((on: boolean) => void) | null = null;
  // Desplazamiento a mano: gesto en curso y letra desprendida de la cancion
  private gesture = false;
  private detached = false;
  private settle = 0;
  private lastSec = NaN;

  constructor(state: LyricsState, onSeek: (sec: number) => void) {
    this.onSeek = onSeek;
    // Solo los gestos del usuario cuentan (el scroll propio no)
    const user = () => { this.gesture = true; this.armSettle(); };
    this.scroller.addEventListener('wheel', user, { passive: true });
    this.scroller.addEventListener('touchmove', user, { passive: true });
    this.scroller.addEventListener('pointerdown', (e) => { if (e.target === this.scroller) user(); }); // barra de scroll
    this.scroller.addEventListener('keydown', (e) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) user(); });
    this.scroller.addEventListener('scroll', () => { if (this.gesture) this.armSettle(); }, { passive: true });
    this.set(state);
  }

  set(state: LyricsState) {
    this.active = -2;
    this.hold = null;
    this.attach(false);
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
    const fmt = state.fmt ?? ((c: string | null) => c ?? '');
    this.chords = state.chords ?? [];
    this.chordEls = []; this.strips = []; this.stripCur = [];
    const hasChords = this.chords.some((c) => c.length);
    // Boton de acordes en la letra (b_lyricsChords): solo si la cancion tiene acordes
    const cb = h('button', { class: 'lychb', attrs: { 'aria-pressed': String(this.chordsOn) }, hidden: !hasChords }, img(icChordsOnLyrics, '', ''));
    cb.onclick = () => { this.setChordsOn(!this.chordsOn); this.onChordsToggle?.(this.chordsOn); };
    this.chordBtn = cb;
    this.syncChordBtn();
    opts.prepend(cb);
    const list = h('div', { class: `lylist${this.chordsOn && hasChords ? ' chon' : ''}` });
    this.list = list;
    this.rows.forEach((r, ri) => {
      const line = h('div', { class: `cl${r.type === 'instrumental' ? ' ins' : ''}`, attrs: { role: 'button', tabindex: '0' } });
      const ws: HTMLElement[] = [], cs: HTMLElement[] = [];
      const rc = this.chords[ri] ?? [];
      if (r.type === 'instrumental') {
        // Parte instrumental: una fila de acordes encima de la nota (ChordStripView)
        if (rc.length) {
          const track = h('div', { class: 'lstrack' }, ...rc.map((c) => { const e = h('i', { class: 'ch', textContent: fmt(c.raw) }); cs.push(e); return e; }));
          const strip = h('div', { class: 'lstrip', attrs: { 'aria-hidden': 'true' } }, track);
          this.strips[ri] = strip;
          line.append(strip);
        }
        line.append(h('span', { textContent: '♪' }));
      } else {
        rowWords(r).forEach((text, k, all) => {
          const s = h('span', { class: 'wd', textContent: text });
          // Palabra: seek a su onset (solo en karaoke; si no, la linea entera)
          const w = r.words[k];
          if (w) s.onclick = (ev) => { if (this.karaoke) { ev.stopPropagation(); this.tap(ri, w.onset, w.onset, w.onset + KARAOKE_FADE_SEC); } };
          ws.push(s);
          line.append(s, k < all.length - 1 ? ' ' : '');
        });
        for (const c of rc) { const e = h('i', { class: 'ch lc', textContent: fmt(c.raw) }); cs.push(e); line.append(e); }
      }
      const tapLine = () => this.tap(ri, r.start, switchAt(this.rows, ri), r.start);
      line.onclick = tapLine;
      line.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapLine(); } };
      this.lines.push(line); this.words.push(r.words.length ? ws : []); this.chordEls.push(cs); this.stripCur.push(-2); list.append(line);
    });
    this.scroller.classList.toggle('kar', this.karaoke && karaokeOk);
    this.scroller.replaceChildren(list);
    this.el.replaceChildren(opts, this.scroller);
    // Posicion de cada acorde: medida sobre las letras ya maquetadas (y otra vez si cambia el ancho)
    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => this.scheduleLayout());
    this.ro.observe(this.scroller);
    void document.fonts?.ready.then(() => this.scheduleLayout());
  }

  /** Interruptor de la cancion: la banda crece (o encoge) y los nombres aparecen con ella. */
  setChordsOn(on: boolean) {
    if (on === this.chordsOn) return;
    this.chordsOn = on;
    this.syncChordBtn();
    if (!this.list) return;
    this.list.classList.toggle('chon', on && this.chords.some((c) => c.length));
    // Tras la transicion: recolocar acordes y la fila activa al centro
    window.setTimeout(() => { this.layoutChords(); this.center(false); }, 260);
  }

  private syncChordBtn() {
    const b = this.chordBtn;
    if (!b) return;
    b.setAttribute('aria-pressed', String(this.chordsOn));
    const label = t(this.chordsOn ? 'lyrics_chords_on' : 'lyrics_chords_off');
    b.setAttribute('aria-label', label); b.title = label;
  }

  private scheduleLayout() {
    cancelAnimationFrame(this.relayout);
    this.relayout = requestAnimationFrame(() => this.layoutChords());
  }

  /** Cada nombre justo encima de su letra (ChordLyricsTextView.onDraw): sobre la letra que suena, o
   *  tras la palabra si cae en un silencio; dos en la misma linea visual no se pisan. */
  private layoutChords() {
    const SPACING = 8;
    this.lines.forEach((line, ri) => {
      const rc = this.chords[ri] ?? [], els = this.chordEls[ri] ?? [];
      if (this.rows[ri]?.type !== 'text' || !rc.length) return;
      const lr = line.getBoundingClientRect();
      const scale = line.offsetWidth ? lr.width / line.offsetWidth : 1; // la activa va escalada
      const ws = Array.from(line.querySelectorAll<HTMLElement>('.wd'));
      let lastTop = NaN, lastRight = -Infinity;
      rc.forEach((c, k) => {
        const el = els[k], node = ws[c.word]?.firstChild;
        if (!el || !node) return;
        const len = node.textContent?.length ?? 0;
        const rg = document.createRange();
        const a = c.after ? Math.max(0, len - 1) : Math.min(c.char, Math.max(0, len - 1));
        rg.setStart(node, a); rg.setEnd(node, Math.min(a + 1, len));
        const box = rg.getBoundingClientRect();
        let x = ((c.after ? box.right : box.left) - lr.left) / scale + (c.after ? SPACING : 0);
        const top = (box.top - lr.top) / scale;
        const w = el.offsetWidth;
        if (Math.abs(top - lastTop) < 2) x = Math.max(x, lastRight + SPACING);
        x = Math.min(x, Math.max(0, line.offsetWidth - w));
        el.style.transform = `translate(${x}px, ${top}px)`;
        lastTop = top; lastRight = x + w;
      });
    });
  }

  /** Reloj de los acordes: encendidos los ya alcanzados en la fila activa; la tira instrumental centra el que suena. */
  private paintChords(i: number, sec: number) {
    const pos = sec - CHORD_LAG_SEC;
    this.chordEls.forEach((els, ri) => {
      const rc = this.chords[ri] ?? [];
      if (!els.length) return;
      if (this.rows[ri].type === 'text') { els.forEach((e, k) => e.classList.toggle('on', ri === i && rc[k].time <= pos)); return; }
      let cur = -1;
      if (ri === i) rc.forEach((c, k) => { if (c.time <= pos) cur = k; });
      if (cur === this.stripCur[ri]) return;
      this.stripCur[ri] = cur;
      els.forEach((e, k) => { e.classList.toggle('now', k === cur); e.classList.toggle('past', k < cur); });
      this.glide(ri, cur);
    });
  }

  /** Tira mas ancha que la fila: se desliza para centrar el acorde actual (topes en los extremos). */
  private glide(ri: number, cur: number) {
    const strip = this.strips[ri], track = strip?.firstElementChild as HTMLElement | null;
    if (!strip || !track) return;
    const w = strip.clientWidth, cw = track.scrollWidth;
    let off = 0; // cabe: alineada a la izquierda como las lineas (Android la centra)
    if (cw > w) {
      const el = this.chordEls[ri][Math.max(0, cur)];
      const center = cur >= 0 && el ? el.offsetLeft + el.offsetWidth / 2 : 0;
      off = Math.max(w - cw, Math.min(0, w / 2 - center));
    }
    track.style.transform = `translateX(${off}px)`;
    strip.classList.toggle('fl', off < -0.5);
    strip.classList.toggle('fr', off + cw > w + 0.5);
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
    this.attach(false); // tocar una linea la vuelve a enganchar
    this.onSeek(seekSec);
    this.hold = { idx, until, from: seekSec, kar };
    this.paint(idx, kar);
  }

  /** t = reloj de letra (s). Llamar en cada frame con la vista visible. */
  tick(sec: number) {
    if (!this.rows.length) return;
    // Un seek (salto del reloj) engancha otra vez la letra desprendida
    if (this.detached && Math.abs(sec - this.lastSec) > SEEK_JUMP_SEC) this.attach(true);
    this.lastSec = sec;
    let i = activeRow(this.rows, sec), kar = sec;
    const hd = this.hold;
    if (hd && (sec >= hd.until || sec < hd.from - 1)) this.hold = null;
    else if (hd) { i = hd.idx; kar = Math.max(sec, hd.kar); }
    this.paint(i, kar);
  }

  get isDetached() { return this.detached; }

  private armSettle() {
    clearTimeout(this.settle);
    this.settle = window.setTimeout(() => this.release(), SETTLE_MS);
  }

  /** Fin del gesto: la activa cerca del centro -> se engancha (vuelve a ella); lejos -> desprendida. */
  private release() {
    this.gesture = false;
    const el = this.lines[this.active];
    if (!el) return;
    const box = this.scroller;
    const d = Math.abs(el.offsetTop + el.offsetHeight / 2 - (box.scrollTop + box.clientHeight / 2));
    if (d <= box.clientHeight * SNAP_NEAR) this.attach(true);
    else this.detached = true;
  }

  private attach(recenter: boolean) {
    clearTimeout(this.settle);
    this.gesture = false;
    this.detached = false;
    if (recenter) this.center(true);
  }

  /** Centrar la linea activa (scroll suave, como el LinearSmoothScroller). Desprendida o en pleno gesto, no. */
  private center(smooth: boolean) {
    const el = this.lines[this.active];
    if (!el || this.detached || this.gesture) return;
    const box = this.scroller;
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
  }

  private paint(i: number, sec: number) {
    if (i !== this.active) {
      if (this.active >= 0) { this.lines[this.active]?.classList.remove('now'); for (const w of this.words[this.active] ?? []) w.style.removeProperty('--k'); }
      this.active = i;
      if (i >= 0) {
        this.lines[i].classList.add('now');
        this.center(true);
      }
    }
    if (i >= 0 && this.karaoke) {
      const r = this.rows[i];
      this.words[i].forEach((el, k) => el.style.setProperty('--k', String(wordProgress(r.words[k], sec))));
    }
    if (this.chordsOn) this.paintChords(i, sec);
  }
}
