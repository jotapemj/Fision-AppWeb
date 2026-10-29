// Vista Letra: linea activa centrada, karaoke por palabra, tocar = seek (maqueta player.html).
import { t } from '../i18n/i18n.ts';
import { activeRow, hasWords, wordProgress, type LyricRow } from '../player/lyrics.ts';
import { formatChord } from '../player/chords.ts';
import { h } from './dom.ts';

const KARAOKE_PREF = 'fision.lyrics_karaoke_mode'; // lyrics_karaoke_mode, default false

function loadKaraoke(): boolean { try { return localStorage.getItem(KARAOKE_PREF) === '1'; } catch { return false; } }
function saveKaraoke(on: boolean) { try { localStorage.setItem(KARAOKE_PREF, on ? '1' : '0'); } catch { /* sin storage */ } }

/** chords: "fila:palabra" -> acorde (acordes sobre la letra, solo web). */
export type LyricsState = { kind: 'loading' } | { kind: 'none' } | { kind: 'content'; rows: LyricRow[]; chords?: Map<string, string> };

export class LyricsView {
  private scroller = h('div', { class: 'lyrics' });
  // Opciones fuera del scroller: su mascara de fundido las borraba
  readonly el = h('div', { class: 'lywrap' }, this.scroller);
  private lines: HTMLElement[] = [];
  private words: HTMLElement[][] = [];
  private rows: LyricRow[] = [];
  private active = -2;
  private karaoke = loadKaraoke();
  private onSeek: (sec: number) => void;

  constructor(state: LyricsState, onSeek: (sec: number) => void) {
    this.onSeek = onSeek;
    this.set(state);
  }

  set(state: LyricsState) {
    this.active = -2;
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
    const opts = h('label', { class: 'lyopts' }, t('lyrics_karaoke_mode'), sw);
    this.lines = []; this.words = [];
    const chords = state.chords ?? new Map<string, string>();
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
            ? h('span', { class: 'wd' }, h('i', { class: 'ch', textContent: formatChord(chords.get(`${ri}:${k}`) ?? null) }), h('span', { textContent: w.text }))
            : h('span', { class: 'wd', textContent: w.text });
          // Palabra: seek a su onset (solo en karaoke; si no, la linea entera)
          s.onclick = (ev) => { if (this.karaoke) { ev.stopPropagation(); this.onSeek(w.onset); } };
          ws.push(s);
          line.append(s, k < r.words.length - 1 && !withChords ? ' ' : '');
        });
      } else line.textContent = r.text;
      line.onclick = () => this.onSeek(r.start);
      line.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.onSeek(r.start); } };
      this.lines.push(line); this.words.push(ws); list.append(line);
    });
    this.scroller.classList.toggle('kar', this.karaoke && karaokeOk);
    this.scroller.replaceChildren(list);
    this.el.replaceChildren(opts, this.scroller);
  }

  /** t = reloj de letra (s). Llamar en cada frame con la vista visible. */
  tick(sec: number) {
    if (!this.rows.length) return;
    const i = activeRow(this.rows, sec);
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
