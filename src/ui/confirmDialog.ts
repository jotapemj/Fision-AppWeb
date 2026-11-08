// Confirmacion si/no = BlurDialogs.confirm de Android (delete_alert_dialog): icono 48, texto centrado,
// detalle opcional (nombre de la cancion), No con borde de acento y Si relleno. Sustituye a confirm().
import { t } from '../i18n/i18n.ts';
import { h } from './dom.ts';
import { icon, type IconName } from './icons.ts';

export interface ConfirmOpts {
  icon?: IconName;   // del (por defecto), warning, logout
  message: string;
  detail?: string;   // segunda linea: lo afectado (titulo de la cancion)
  yes?: string;
  no?: string;
}

const OUT_MS = 160;

/** true = Si. Escape, clic fuera o No = false. */
export function confirmDialog(o: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const no = h('button', { class: 'cfno', textContent: o.no ?? t('playlist_cancel') });
    const yes = h('button', { class: 'cfyes', textContent: o.yes ?? t('playlist_delete_action') });
    const dlg = h('dialog', { class: 'cfdlg', attrs: { 'aria-label': o.message } },
      h('div', { class: 'cfic' }, icon(o.icon ?? 'del', 48)),
      h('p', { class: 'cfmsg', textContent: o.message }),
      o.detail ? h('p', { class: 'cfdet', textContent: o.detail }) : null,
      h('div', { class: 'cfbtns' }, no, yes));
    let answer = false;
    const close = (v: boolean) => {
      if (dlg.classList.contains('out')) return;
      answer = v;
      dlg.classList.add('out');
      setTimeout(() => dlg.close(), OUT_MS);
    };
    no.onclick = () => close(false);
    yes.onclick = () => close(true);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(false); });
    dlg.addEventListener('click', (e) => { // clic fuera (el padding del dialogo tambien es el dialogo)
      const r = dlg.getBoundingClientRect();
      if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) close(false);
    });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(answer); });
    document.body.append(dlg);
    dlg.showModal();
    no.focus(); // como Android: nada destructivo con Enter por defecto
  });
}
