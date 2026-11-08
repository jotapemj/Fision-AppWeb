// Centro sin cancion: la nebulosa girando relajada (media velocidad, sin pulso) y el logo blanco completo
// (artcover_generic de Android, con la corchea) en el medio. Con prefers-reduced-motion la nebulosa queda quieta.
import { accentPalette } from '../player/nebulaMath.ts';
import { Nebula } from './nebula.ts';
import { h } from './dom.ts';
import logoUrl from '../assets/artcover_generic.png';

const IDLE_SPEED = 0.5;

export class IdleMain {
  readonly el: HTMLElement;
  private nebula = new Nebula(IDLE_SPEED, false); // sin tope: aqui no hay textos del reproductor

  /** text: solo para avisos (fallo al abrir); sin cancion elegida no lleva texto. */
  constructor(text: string | null, accent: string) {
    this.nebula.el.classList.add('idleneb');
    this.nebula.setColors(accentPalette(accent));
    this.nebula.setEnabled(true);
    const logo = h('img', { class: 'idlemark', src: logoUrl, alt: 'Fision', draggable: false });
    this.el = h('main', { class: 'main idle' }, this.nebula.el, h('div', { class: 'idlec' }, logo, text ? h('p', { class: 'hint', textContent: text }) : null));
  }

  setAccent(accent: string) { this.nebula.setColors(accentPalette(accent)); }

  destroy() { this.nebula.destroy(); }
}
