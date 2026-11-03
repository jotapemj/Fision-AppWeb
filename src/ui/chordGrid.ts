// Cuadricula de acordes = ChordGridAdapter de Android: una casilla por beat, dos compases por fila
// (uno si el compas pasa de 4 tiempos); cada compas empieza en su columna (anacrusa y compases
// irregulares dejan huecos). Mismos colores que la tira. Sigue la cancion con la fila actual al 30 %
// del alto; explorar con la rueda o arrastrando la separa y un iman la devuelve.
import { soundingChord, type BeatCell } from '../player/chords.ts';
import { chordLabel } from './chordLabel.ts';
import { h } from './dom.ts';

const FOLLOW_AT = 0.3;          // fila actual al 30 % del alto
const MAGNET_BASE_MS = 1500;    // + 100 ms por casilla, max 4 s (stopBrowsing)
const MAGNET_PER_CELL_MS = 100;
const MAGNET_MAX_MS = 4000;
const SETTLE_MS = 150;          // fin del gesto: sin rueda ni arrastre en este tiempo

/** Hueco de cada casilla: slots[k] = indice de beat o -1 (vacio). */
export function gridLayout(cells: BeatCell[]): { beatsPerBar: number; columns: number; slots: number[]; slotOf: number[] } {
  const beatsPerBar = Math.max(2, ...cells.map((c) => c.pos));
  const columns = beatsPerBar <= 4 ? beatsPerBar * 2 : beatsPerBar;
  const slots: number[] = [], slotOf: number[] = [];
  cells.forEach((c, i) => {
    if (i === 0 && !c.isDownbeat) for (let k = 1; k < c.pos; k++) slots.push(-1); // anacrusa en su sitio
    else if (c.isDownbeat) while (slots.length % beatsPerBar) slots.push(-1);
    slotOf[i] = slots.length;
    slots.push(i);
  });
  return { beatsPerBar, columns, slots, slotOf };
}

export class ChordGrid {
  readonly el = h('div', { class: 'cgrid' });
  private inner = h('div', { class: 'cgrid-in', attrs: { role: 'list' } });
  private cellEls: HTMLElement[] = [];
  private lay: ReturnType<typeof gridLayout>;
  private cur = -2;
  private row = -1;
  private browsing = false;
  private settle = 0;
  private magnet = 0;

  constructor(cells: BeatCell[], onSeek: (sec: number) => void, fmt: (c: string | null) => string) {
    this.lay = gridLayout(cells);
    const { columns, beatsPerBar, slots } = this.lay;
    // Dos compases: una columna estrecha entre ellos para la raya (BarDecoration)
    const one = 'minmax(0, 1fr)';
    this.inner.style.gridTemplateColumns = columns > beatsPerBar ? `repeat(${beatsPerBar}, ${one}) 12px repeat(${beatsPerBar}, ${one})` : `repeat(${columns}, ${one})`;
    slots.forEach((ci, s) => {
      // Segundo compas de la fila: raya de acento entre los dos (BarDecoration)
      const second = columns > beatsPerBar && s % columns === beatsPerBar;
      const place = (el: HTMLElement) => { if (second) el.style.gridColumnStart = String(beatsPerBar + 2); this.inner.append(el); return el; };
      if (ci < 0) { place(h('span', { class: 'g empty', attrs: { 'aria-hidden': 'true' } })); return; }
      const c = cells[ci];
      let label = c.chord, ghost = false;
      if (!label && c.isDownbeat) { label = soundingChord(cells, ci - 1); ghost = !!label; }
      const el = h('button', { class: `g${c.isDownbeat ? ' db' : ''}${ghost ? ' ghost' : ''}${second ? ' b2' : ''}`, attrs: { role: 'listitem', tabindex: '-1' } }, chordLabel(fmt(label)));
      el.onclick = () => { this.stopBrowsing(); onSeek(c.time); };
      this.cellEls[ci] = place(el);
    });
    this.el.append(this.inner);
    // Explorar: solo los gestos del usuario (el scroll propio no cuenta)
    const user = () => this.userScroll();
    this.el.addEventListener('wheel', user, { passive: true });
    this.el.addEventListener('touchmove', user, { passive: true });
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) user(); }); // barra de scroll
    this.el.addEventListener('scroll', () => { this.fades(); if (this.browsing) this.armSettle(); }, { passive: true });
  }

  get columns() { return this.lay.columns; }

  /** Repintar y recolocar en el proximo setBeat (al volver a la vista). */
  invalidate() { this.cur = -2; this.row = -1; this.stopBrowsing(); }

  destroy() { clearTimeout(this.settle); clearTimeout(this.magnet); }

  setBeat(i: number) {
    if (i === this.cur) return;
    const prev = this.cur;
    this.cur = i;
    if (prev >= -1 && i !== prev + 1) this.stopBrowsing(); // seek: corta la exploracion
    const bpb = this.lay.beatsPerBar, n = this.cellEls.length;
    const all = prev < -1 || Math.abs(i - prev) > 64;
    const from = all ? 0 : Math.max(0, Math.min(prev, i) - bpb), to = all ? n - 1 : Math.min(n - 1, Math.max(prev, i) + bpb);
    for (let k = from; k <= to; k++) {
      const el = this.cellEls[k];
      if (!el) continue;
      el.classList.toggle('now', k === i);
      el.classList.toggle('trail', i >= 0 && k < i && i - k < bpb);
      el.classList.toggle('played', i >= 0 && k < i && i - k >= bpb);
    }
    const r = this.rowOf(i);
    if (r !== this.row) { const first = this.row < 0; this.row = r; if (!this.browsing) this.follow(!first); }
  }

  private rowOf(i: number) { return Math.floor((this.lay.slotOf[Math.max(0, i)] ?? 0) / this.lay.columns); }
  private rowTop(r: number) { return (this.inner.children[r * this.lay.columns] as HTMLElement | undefined)?.offsetTop ?? 0; }

  /** Fila actual al 30 % del alto (followGrid). */
  private follow(smooth: boolean) {
    const top = Math.max(0, this.rowTop(this.row) - this.el.clientHeight * FOLLOW_AT);
    this.el.scrollTo({ top, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
    requestAnimationFrame(() => this.fades()); // sin scroll (ya estaba ahi) no llega el evento
  }

  private userScroll() {
    this.browsing = true;
    clearTimeout(this.magnet);
    this.armSettle();
  }

  private armSettle() {
    clearTimeout(this.settle);
    this.settle = window.setTimeout(() => this.release(), SETTLE_MS);
  }

  /** Al soltar: fila actual visible o a una fila -> al momento; si no, espera segun la distancia. */
  private release() {
    if (!this.browsing) return;
    const H = this.el.clientHeight, top = this.el.scrollTop, rowH = Math.max(1, this.rowTop(1) - this.rowTop(0));
    const y = this.rowTop(this.row);
    const away = y < top ? Math.ceil((top - y) / rowH) : y > top + H - rowH ? Math.ceil((y - (top + H - rowH)) / rowH) : 0;
    if (away <= 1) { this.stopBrowsing(); return; }
    const delay = Math.min(MAGNET_MAX_MS, MAGNET_BASE_MS + MAGNET_PER_CELL_MS * away * this.lay.columns);
    this.magnet = window.setTimeout(() => this.stopBrowsing(), delay);
  }

  private stopBrowsing() {
    clearTimeout(this.settle); clearTimeout(this.magnet);
    if (!this.browsing) return;
    this.browsing = false;
    if (this.row >= 0) this.follow(true);
  }

  /** Fundido de 56 px solo donde hay contenido oculto. */
  private fades() {
    const e = this.el;
    e.classList.toggle('ft', e.scrollTop > 1);
    e.classList.toggle('fb', e.scrollTop + e.clientHeight < e.scrollHeight - 1);
  }
}
