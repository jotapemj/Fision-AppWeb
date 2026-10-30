// Centro sin cancion: la nebulosa girando relajada (media velocidad, sin pulso) y la marca de
// Fision en blanco en el medio. Con prefers-reduced-motion la nebulosa queda quieta.
import { SETTLED, drawMark } from '../brand/fisionMotion.ts';
import { accentPalette } from '../player/nebulaMath.ts';
import { Nebula } from './nebula.ts';
import { h } from './dom.ts';

const MARK_MIN = -20, MARK_MAX = 532; // limites de la marca asentada (unidades del logo)
const MARK_PX = 132;                  // ancho de la marca en pantalla
const IDLE_SPEED = 0.5;

export class IdleMain {
  readonly el: HTMLElement;
  private nebula = new Nebula(IDLE_SPEED);
  private mark = h('canvas', { class: 'idlemark', attrs: { role: 'img', 'aria-label': 'Fision' } });

  constructor(text: string, accent: string) {
    this.nebula.el.classList.add('idleneb');
    this.nebula.setColors(accentPalette(accent));
    this.nebula.setEnabled(true);
    this.el = h('section', { class: 'main idle' }, this.nebula.el, h('div', { class: 'idlec' }, this.mark, h('p', { class: 'hint', textContent: text })));
    requestAnimationFrame(() => this.paintMark());
  }

  setAccent(accent: string) { this.nebula.setColors(accentPalette(accent)); }

  destroy() { this.nebula.destroy(); }

  /** La marca asentada (anillo cerrado, fragmentos y neutrones) en blanco. */
  private paintMark() {
    const dpr = devicePixelRatio || 1, k = MARK_PX * dpr / (MARK_MAX - MARK_MIN), size = Math.ceil((MARK_MAX - MARK_MIN) * k);
    const c = this.mark;
    c.width = c.height = size;
    c.style.width = c.style.height = `${MARK_PX}px`;
    const x = c.getContext('2d')!;
    x.save(); x.scale(k, k); x.translate(-MARK_MIN, -MARK_MIN);
    drawMark(x, { head: 1, tail: 0, alpha: 1, grow: 1, tf: SETTLED + 1000 });
    x.restore();
  }
}
