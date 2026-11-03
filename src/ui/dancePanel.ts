// Tarjeta del baile en movil (= ll_3d_dancePanel): chevron que la pliega y pildora de pestanas que se desliza.
import { t } from '../i18n/i18n.ts';
import { h, reducedMotion } from './dom.ts';

const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.3 6 7.9 7.4 12.5 12l-4.6 4.6L9.3 18l6-6z" fill="currentColor"/></svg>';

/** Rellena la tarjeta. El plegado vive en la propia tarjeta: sobrevive a repintar el contenido. */
export function fillDancePanel(panel: HTMLElement, ...content: HTMLElement[]) {
  const chev = h('button', { class: 'dchev', attrs: { 'aria-label': t('stems_dance_title'), 'aria-expanded': String(!panel.classList.contains('fold')) } });
  chev.innerHTML = CHEVRON;
  chev.onclick = () => chev.setAttribute('aria-expanded', String(!panel.classList.toggle('fold')));
  panel.replaceChildren(chev, h('div', { class: 'dbody' }, ...content));
}

/** Pildora bajo la pestana `to`; llega deslizandose desde `from` (240 ms, como placeDanceTabIndicator). */
export function danceTabPill(tabs: HTMLElement, from: number, to: number) {
  const pill = h('span', { class: 'dpill', attrs: { 'aria-hidden': 'true' } });
  pill.style.width = `${100 / tabs.children.length}%`;
  pill.style.transform = `translateX(${to * 100}%)`;
  tabs.prepend(pill);
  if (from === to || reducedMotion()) return;
  pill.animate([{ transform: `translateX(${from * 100}%)` }, { transform: `translateX(${to * 100}%)` }], { duration: 240, easing: 'cubic-bezier(.4,0,.2,1)' });
}
