// Pantalla de login (LoginDialog de Android; la URL del server es el mismo origen).
import { ApiError, type Api, type Session } from '../api/client.ts';
import { t } from '../i18n/i18n.ts';
import { h, img } from './dom.ts';
import wordmark from '../assets/icons/wordmark.svg';

const ERR: Record<string, string> = { bad_credentials: 'login_err_bad_credentials', network: 'login_err_network' };

export function loginView(api: Api, onDone: (s: Session) => void, notice = ''): HTMLElement {
  const user = h('input', { class: 'field', type: 'text', autocomplete: 'username', placeholder: t('login_hint_user'), attrs: { 'aria-label': t('login_hint_user') } });
  const pass = h('input', { class: 'field', type: 'password', autocomplete: 'current-password', placeholder: t('login_hint_pass'), attrs: { 'aria-label': t('login_hint_pass') } });
  const err = h('p', { class: 'err', textContent: notice, attrs: { role: 'alert' } });
  const go = h('button', { class: 'btn', type: 'submit', textContent: t('login_submit') });
  const form = h('form', {}, img(wordmark, 'wm', 'Fision'), h('h1', { textContent: t('login_title') }),
    h('p', { class: 'sub', textContent: t('login_subtitle') }), user, pass, err, go);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    if (!user.value.trim() || !pass.value) { err.textContent = t('login_err_empty_fields'); return; }
    go.disabled = true;
    err.textContent = '';
    try { onDone(await api.login(user.value.trim(), pass.value)); }
    catch (e) { err.textContent = t(ERR[e instanceof ApiError ? e.code : ''] ?? 'login_err_server'); }
    finally { go.disabled = false; }
  };
  setTimeout(() => user.focus());
  return h('main', { class: 'login' }, form);
}
