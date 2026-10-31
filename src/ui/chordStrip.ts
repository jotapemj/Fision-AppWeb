// Tira de acordes: una celda por beat, barra en los downbeats (BeatCellAdapter de Android).
// Arrastrar con el raton (o la rueda) explora sin hacer seek; al soltar se ajusta a una celda y un
// iman la devuelve al beat actual (scheduleChordsMagnet). Solo el clic en una celda hace seek.
import { soundingChord, type BeatCell } from '../player/chords.ts';
import { h } from './dom.ts';

const SLOP_PX = 6;              // menos = clic
const MAGNET_NEAR = 2;          // a <= 2 celdas vuelve al momento
const MAGNET_BASE_MS = 1500, MAGNET_PER_CELL_MS = 100, MAGNET_MAX_MS = 4000;
const WHEEL_SETTLE_MS = 150;    // fin del gesto de rueda
const FLING_MS = 220;           // inercia: proyeccion de la velocidad al soltar

export class ChordStrip {
  readonly el = h('div', { class: 'strip', attrs: { role: 'list' } });
  private track = h('div', { class: 'strip-track' });
  private cellEls: HTMLElement[] = [];
  private beatsPerBar: number;
  private cur = -2;
  private offset = 0;            // px desplazados del track
  private browsing = false;
  private magnet = 0;
  private wheelTimer = 0;
  private drag: { id: number; x0: number; o0: number; moved: boolean; lx: number; lt: number; v: number } | null = null;

  constructor(cells: BeatCell[], beatsPerBar: number, onSeek: (sec: number) => void, fmt: (c: string | null) => string) {
    this.beatsPerBar = beatsPerBar;
    cells.forEach((c, i) => {
      if (c.isDownbeat && i > 0) this.track.append(h('i', { class: 'bar', attrs: { 'aria-hidden': 'true' } }));
      // Compas sin acorde propio: se recuerda el sostenido, pequeno y tenue
      let label = c.chord, ghost = false;
      if (!label && c.isDownbeat) { label = soundingChord(cells, i - 1); ghost = !!label; }
      const el = h('button', { class: `c${c.isDownbeat ? ' db' : ''}${ghost ? ' ghost' : ''}`, textContent: fmt(label), attrs: { role: 'listitem', tabindex: '-1' } });
      el.onclick = () => { this.stopBrowsing(); onSeek(c.time); };
      this.cellEls.push(el);
      this.track.append(el);
    });
    this.el.append(this.track);
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.el.addEventListener('pointermove', (e) => this.move(e));
    this.el.addEventListener('pointerup', (e) => this.up(e));
    this.el.addEventListener('pointercancel', (e) => this.up(e));
    // Tras arrastrar, el clic de la celda no cuenta (no es seek)
    this.el.addEventListener('click', (e) => { if (this.justDragged) { e.stopPropagation(); e.preventDefault(); this.justDragged = false; } }, true);
    this.el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }
  private justDragged = false;

  /** Recalcular todo en el proximo setBeat (p. ej. al volver a la vista: el ancho cambia). */
  invalidate() { this.cur = -2; this.stopBrowsing(false); }

  destroy() { clearTimeout(this.magnet); clearTimeout(this.wheelTimer); }

  /** i = beat actual (-1 antes del primero). */
  setBeat(i: number) {
    if (i === this.cur) return;
    const prev = this.cur;
    this.cur = i;
    if (prev >= -1 && i !== prev + 1) this.stopBrowsing(false); // seek: termina la exploracion
    // Solo cambian las celdas entre la posicion vieja y la nueva, mas un compas de estela
    const all = prev < -1 || Math.abs(i - prev) > 64;
    const from = all ? 0 : Math.max(0, Math.min(prev, i) - this.beatsPerBar);
    const to = all ? this.cellEls.length - 1 : Math.min(this.cellEls.length - 1, Math.max(prev, i) + this.beatsPerBar);
    for (let k = from; k <= to; k++) {
      const el = this.cellEls[k];
      el.classList.toggle('now', k === i);
      el.classList.toggle('trail', i >= 0 && k < i && i - k < this.beatsPerBar);
      el.classList.toggle('played', i >= 0 && k < i && i - k >= this.beatsPerBar);
    }
    if (!this.browsing) this.follow();
  }

  get isBrowsing() { return this.browsing; }

  // ---------------- posicion ----------------

  /** Celda actual a un tercio del ancho. */
  private follow() {
    this.setOffset(this.offsetFor(Math.max(0, this.cur)), true);
  }
  private slot() { return this.el.clientWidth / 3; }
  private offsetFor(k: number) { const t = this.cellEls[k]; return t ? Math.max(0, t.offsetLeft - this.slot()) : 0; }
  private maxOffset() { return this.offsetFor(this.cellEls.length - 1); }
  private setOffset(px: number, animate: boolean) {
    this.offset = Math.max(0, Math.min(this.maxOffset(), px));
    this.track.classList.toggle('free', !animate);
    this.track.style.transform = `translateX(${-this.offset}px)`;
  }
  /** Celda mas cercana al hueco del tercio con este desplazamiento. */
  private nearest(px: number) {
    const x = px + this.slot();
    let best = 0, bd = Infinity;
    this.cellEls.forEach((el, k) => { const d = Math.abs(el.offsetLeft - x); if (d < bd) { bd = d; best = k; } });
    return best;
  }

  // ---------------- explorar ----------------

  private down(e: PointerEvent) {
    if (e.button !== 0 || !this.cellEls.length) return;
    this.justDragged = false; // si el arrastre acabo fuera de una celda no hubo clic que anular
    this.drag = { id: e.pointerId, x0: e.clientX, o0: this.offset, moved: false, lx: e.clientX, lt: e.timeStamp, v: 0 };
  }

  private move(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0;
    if (!d.moved) {
      if (Math.abs(dx) < SLOP_PX) return;
      d.moved = true;
      this.el.setPointerCapture(d.id);
      this.el.classList.add('dragging');
      this.startBrowsing();
    }
    const dt = Math.max(1, e.timeStamp - d.lt);
    d.v = 0.7 * d.v + 0.3 * ((d.lx - e.clientX) / dt); // px/ms suavizado
    d.lx = e.clientX; d.lt = e.timeStamp;
    this.setOffset(d.o0 - dx, false);
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    if (!d.moved) return;
    this.justDragged = e.type === 'pointerup';
    this.el.classList.remove('dragging');
    if (this.el.hasPointerCapture(d.id)) this.el.releasePointerCapture(d.id);
    this.settle(this.offset + d.v * FLING_MS);
  }

  private wheel(e: WheelEvent) {
    if (!this.cellEls.length) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!delta) return;
    e.preventDefault();
    this.startBrowsing();
    this.setOffset(this.offset + delta * (e.deltaMode === 1 ? 32 : 1), false);
    clearTimeout(this.wheelTimer);
    this.wheelTimer = window.setTimeout(() => this.settle(this.offset), WHEEL_SETTLE_MS);
  }

  private startBrowsing() {
    this.browsing = true;
    clearTimeout(this.magnet);
  }

  /** Al soltar: ajustar a una celda (snap) y armar el iman segun la distancia al beat actual. */
  private settle(px: number) {
    const k = this.nearest(Math.max(0, Math.min(this.maxOffset(), px)));
    this.setOffset(this.offsetFor(k), true);
    const dist = Math.abs(k - Math.max(0, this.cur));
    clearTimeout(this.magnet);
    const delay = dist <= MAGNET_NEAR ? 0 : Math.min(MAGNET_MAX_MS, MAGNET_BASE_MS + MAGNET_PER_CELL_MS * dist);
    this.magnet = window.setTimeout(() => this.stopBrowsing(), delay);
  }

  /** Fin de la exploracion (iman, seek, clic): vuelve a seguir la cancion. */
  private stopBrowsing(follow = true) {
    clearTimeout(this.magnet); clearTimeout(this.wheelTimer);
    if (!this.browsing) return;
    this.browsing = false;
    this.el.classList.remove('dragging');
    if (follow) this.follow();
  }
}
