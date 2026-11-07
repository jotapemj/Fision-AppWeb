// Dialogo de info del audio 3D (= audio3d_info_dialog): explicacion, raya y leyenda de gestos.
// Movil: los textos de Android. Escritorio: los mismos gestos en palabras de raton.
import { t } from '../i18n/i18n.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';

const ANDROID = ['drag', 'tap', 'double', 'long', 'reset'].map((k) => `audio3d_legend_${k}`);

/** "<b>Arrastrar</b> · posicionar" o "Arrastrar · posicionar": gesto en negrita, sin innerHTML. */
function legendLine(text: string) {
  const m = text.replace(/<\/?b>/g, '').match(/^(.*?)\s*·\s*(.*)$/);
  return m ? h('li', {}, h('b', { textContent: m[1] }), ` · ${m[2]}`) : h('li', {}, h('b', { textContent: text }));
}

export function audio3dInfoDialog(camera: boolean) {
  const mob = !!document.querySelector('.app.mob');
  const desk = ['drag', 'click', 'double', 'long', ...(camera ? ['camera'] : [])].map((k) => `web_3d_legend_${k}`);
  const keys = mob ? ANDROID : [...desk, 'audio3d_legend_reset'];
  const close = h('button', { class: 'xbtn', attrs: { 'aria-label': t('web_close') } }, icon('close'));
  const dlg = h('dialog', { class: 'settings info3d', attrs: { 'aria-label': t('audio3d_info_title') } },
    h('div', { class: 'shd' }, h('h2', { textContent: t('audio3d_info_title') }), close),
    h('p', { class: 'muted', textContent: t('audio3d_info_body') }),
    h('hr', {}),
    h('ul', { class: 'i3lg' }, ...keys.map((k) => legendLine(t(k)))));
  close.onclick = () => dlg.close();
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
}
