// Tira de acordes: una celda por beat, barra en los downbeats (BeatCellAdapter de Android).
import { formatChord, soundingChord, type BeatCell } from '../player/chords.ts';
import { h } from './dom.ts';

export class ChordStrip {
  readonly el = h('div', { class: 'strip', attrs: { role: 'list' } });
  private track = h('div', { class: 'strip-track' });
  private cellEls: HTMLElement[] = [];
  private beatsPerBar: number;
  private cur = -2;

  constructor(cells: BeatCell[], beatsPerBar: number, onSeek: (sec: number) => void) {
    this.beatsPerBar = beatsPerBar;
    cells.forEach((c, i) => {
      if (c.isDownbeat && i > 0) this.track.append(h('i', { class: 'bar', attrs: { 'aria-hidden': 'true' } }));
      // Compas sin acorde propio: se recuerda el sostenido, pequeno y tenue
      let label = c.chord, ghost = false;
      if (!label && c.isDownbeat) { label = soundingChord(cells, i - 1); ghost = !!label; }
      const el = h('button', { class: `c${c.isDownbeat ? ' db' : ''}${ghost ? ' ghost' : ''}`, textContent: formatChord(label), attrs: { role: 'listitem', tabindex: '-1' } });
      el.onclick = () => onSeek(c.time);
      this.cellEls.push(el);
      this.track.append(el);
    });
    this.el.append(this.track);
  }

  /** Recalcular todo en el proximo setBeat (p. ej. al volver a la vista: el ancho cambia). */
  invalidate() { this.cur = -2; }

  /** i = beat actual (-1 antes del primero). */
  setBeat(i: number) {
    if (i === this.cur) return;
    const prev = this.cur;
    this.cur = i;
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
    const target = this.cellEls[Math.max(0, i)];
    if (target) {
      // Celda actual a un tercio del ancho
      const x = target.offsetLeft - this.el.clientWidth / 3;
      this.track.style.transform = `translateX(${-Math.max(0, x)}px)`;
    }
  }
}
