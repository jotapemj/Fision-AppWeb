// Pantalla de login: misma forma que la del panel de FisionServer (la URL del server es el mismo origen).
import { ApiError, type Api, type Session } from '../api/client.ts';
import { LANGS, t, type Lang } from '../i18n/i18n.ts';
import type { SettingsStore } from '../settings.ts';
import { h, img } from './dom.ts';
import { LANG_NAMES } from './settingsView.ts';
import wordmark from '../assets/icons/wordmark.svg';
import icLanguage from '../assets/icons/ic_language.svg';

const ERR: Record<string, string> = { bad_credentials: 'login_err_bad_credentials', network: 'login_err_network' };

// Etiqueta flotante: placeholder ' ' para saber con CSS si el campo esta vacio
function floating(input: HTMLInputElement, id: string, label: string): HTMLElement {
  input.id = id;
  input.placeholder = ' ';
  return h('div', { class: 'lf' }, input, h('label', { textContent: label, attrs: { for: id } }));
}

export function loginView(api: Api, settings: SettingsStore, onDone: (s: Session) => void, notice = ''): HTMLElement {
  const user = h('input', { type: 'text', autocomplete: 'username', attrs: { autocapitalize: 'none', spellcheck: 'false' } });
  const pass = h('input', { type: 'password', autocomplete: 'current-password' });
  const err = h('p', { class: 'err', textContent: notice, attrs: { role: 'alert' } });
  const go = h('button', { class: 'btn', type: 'submit', textContent: t('login_submit') });
  const lang = h('select', { attrs: { 'aria-label': t('settings_language_title') } },
    h('option', { value: '', textContent: t('settings_language_system') }),
    ...LANGS.map((l) => h('option', { value: l, textContent: LANG_NAMES[l] })));
  lang.value = settings.get('lang');
  lang.onchange = () => settings.set('lang', lang.value as Lang | ''); // main.ts recarga
  const form = h('form', { attrs: { novalidate: '' } }, img(wordmark, 'wm', 'Fision'),
    floating(user, 'lu', t('login_hint_user')), floating(pass, 'lp', t('login_hint_pass')), err, go,
    h('label', { class: 'llang' }, img(icLanguage, '', ''), lang));
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
