// Panel de baile comun a escena y vista plana (= player_3d_dance_panel): chevron que pliega la tarjeta en
// movil, pestanas con pildora que se desliza y dialogo de eleccion de stems.
import { t } from '../i18n/i18n.ts';
import type { Player } from '../player/player.ts';
import { titleKey } from '../player/stems.ts';
import { h, img, reducedMotion } from './dom.ts';
import { iconOf } from './stemIcons.ts';

const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.3 6 7.9 7.4 12.5 12l-4.6 4.6L9.3 18l6-6z" fill="currentColor"/></svg>';

/** Rellena la tarjeta. El plegado vive en la propia tarjeta: sobrevive a repintar el contenido. */
export function fillDancePanel(panel: HTMLElement, ...content: HTMLElement[]) {
  const chev = h('button', { class: 'dchev', attrs: { 'aria-label': t('stems_dance_title'), 'aria-expanded': String(!panel.classList.contains('fold')) } });
  chev.innerHTML = CHEVRON;
  chev.onclick = () => chev.setAttribute('aria-expanded', String(!panel.classList.toggle('fold')));
  panel.replaceChildren(chev, h('div', { class: 'dbody' }, ...content));
}

/** Pestanas sobre la pildora, que llega deslizandose desde `from` (240 ms, como placeDanceTabIndicator). */
export function danceTabs<K extends string>(defs: [K, string][], cur: K, from: K | null, pick: (k: K) => void) {
  const tabs = h('div', { class: 'seg dtabs', attrs: { role: 'tablist' } });
  const at = (k: K) => defs.findIndex(([d]) => d === k), to = at(cur);
  const pill = h('span', { class: 'dpill', attrs: { 'aria-hidden': 'true' } });
  pill.style.width = `${100 / defs.length}%`;
  pill.style.transform = `translateX(${to * 100}%)`;
  tabs.append(pill);
  for (const [k, label] of defs) tabs.append(h('button', { textContent: label, attrs: { role: 'tab', 'aria-checked': String(k === cur) }, onclick: () => pick(k) }));
  if (from !== null && from !== cur && !reducedMotion()) {
    pill.animate([{ transform: `translateX(${at(from) * 100}%)` }, { transform: `translateX(${to * 100}%)` }], { duration: 240, easing: 'cubic-bezier(.4,0,.2,1)' });
  }
  return tabs;
}

/** Dialogo stems_dance_setup: tiles para elegir quien baila, swing por stem y swing aleatorio. */
export function danceSetupDialog(p: Player, chosen: Set<string>, swingNow: Iterable<string>, random: boolean, onStart: (ids: string[], swing: string[], random: boolean) => void) {
  const v2 = p.hasVocals2, swing = new Set(swingNow);
  const start = h('button', { class: 'btn', textContent: t('stems_dance_start') });
  const grid = h('div', { class: 'dgrid' });
  for (const s of p.stems) {
    const name = t(titleKey(s.stem, v2)) || s.stem;
    const pick = h('button', { class: 'dtile', attrs: { 'aria-pressed': String(chosen.has(s.stem)), 'aria-label': name, title: name } }, img(iconOf(s.stem, v2), 's', ''));
    const sw = h('button', { class: 'dswing', textContent: t('dance_swing'), attrs: { 'aria-pressed': String(swing.has(s.stem)), 'aria-label': `${t('dance_swing')}: ${name}` } });
    pick.onclick = () => { chosen.has(s.stem) ? chosen.delete(s.stem) : chosen.add(s.stem); pick.setAttribute('aria-pressed', String(chosen.has(s.stem))); start.disabled = !chosen.size; };
    sw.onclick = () => { swing.has(s.stem) ? swing.delete(s.stem) : swing.add(s.stem); sw.setAttribute('aria-pressed', String(swing.has(s.stem))); };
    grid.append(h('div', { class: 'dcell' }, pick, sw));
  }
  const rnd = h('input', { type: 'checkbox', checked: random });
  const close = h('button', { class: 'xbtn', textContent: '✕', attrs: { 'aria-label': t('web_close') } });
  const dlg = h('dialog', { class: 'settings dance', attrs: { 'aria-label': t('stems_dance_title') } },
    h('div', { class: 'shd' }, h('h2', { textContent: t('stems_dance_title') }), close), grid,
    h('label', { class: 'dchk' }, rnd, t('dance_randomize_swing')), start);
  close.onclick = () => dlg.close();
  start.onclick = () => {
    const ids = p.stems.map((s) => s.stem).filter((s) => chosen.has(s));
    dlg.close();
    onStart(ids, [...swing].filter((s) => chosen.has(s)), rnd.checked);
  };
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
}
