// Dialogo de Ajustes (SettingsActivity + drawer de Android, lo que aplica a la web).
import { LANGS, t, type Lang } from '../i18n/i18n.ts';
import { ACCENTS, type Settings, type SettingsStore } from '../settings.ts';
import { h } from './dom.ts';

// Nombre de cada idioma en su idioma (R.array.lang_entries)
const LANG_NAMES: Record<Lang, string> = { en: 'English', es: 'Español', ca: 'Català', uk: 'Українська', 'pt-BR': 'Português (Brasil)',
  fr: 'Français', de: 'Deutsch', it: 'Italiano', ru: 'Русский', 'zh-Hans': '简体中文' };

export interface SettingsContext {
  user: string;
  server: string;
  serverInfo: () => Promise<{ version?: string; gpu_name?: string } | null>;
  webVersion: string;
  onLogout(): void;
}

const sw = (on: boolean, label: string, onToggle: (v: boolean) => void) => {
  const b = h('button', { class: 'switch', attrs: { role: 'switch', 'aria-checked': String(on), 'aria-label': label } });
  b.onclick = () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onToggle(v); };
  return b;
};
const row = (title: string, control: HTMLElement, sub = '') =>
  h('div', { class: 'srow' }, h('span', { class: 'stx' }, h('b', { textContent: title }), sub ? h('small', { textContent: sub }) : ''), control);
const seg = (opts: [string, boolean][], onPick: (i: number) => void, label: string) => {
  const g = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': label } });
  opts.forEach(([txt, on], i) => {
    const b = h('button', { textContent: txt, attrs: { role: 'radio', 'aria-checked': String(on) } });
    b.onclick = () => { g.querySelectorAll('button').forEach((x, k) => x.setAttribute('aria-checked', String(k === i))); onPick(i); };
    g.append(b);
  });
  return g;
};

export function openSettings(store: SettingsStore, ctx: SettingsContext) {
  const s = store.all();
  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => store.set(k, v);

  const lang = h('select', { class: 'field sel', attrs: { 'aria-label': t('settings_language_title') } },
    h('option', { value: '', textContent: t('settings_language_system') }),
    ...LANGS.map((l) => h('option', { value: l, textContent: LANG_NAMES[l] })));
  lang.value = s.lang;
  lang.onchange = () => store.set('lang', lang.value as Lang | '');

  const accents = h('div', { class: 'accents', attrs: { role: 'radiogroup', 'aria-label': t('design_accent_title') } });
  ACCENTS.forEach((c, i) => {
    const b = h('button', { class: 'acc', attrs: { role: 'radio', 'aria-checked': String(i === s.accentId), 'aria-label': c } });
    b.style.background = c;
    b.onclick = () => { accents.querySelectorAll('button').forEach((x, k) => x.setAttribute('aria-checked', String(k === i))); store.set('accentId', i); };
    accents.append(b);
  });

  const serverLine = h('small', { textContent: ctx.server });
  ctx.serverInfo().then((i) => { if (i?.version) serverLine.textContent = `${ctx.server} · v${i.version}${i.gpu_name ? ' · ' + i.gpu_name : ''}`; }).catch(() => {});

  const close = h('button', { class: 'xbtn', textContent: '✕', attrs: { 'aria-label': t('web_close') } });
  const out = h('button', { class: 'btn ghost', textContent: t('settings_logout_title') });
  const dlg = h('dialog', { class: 'settings', attrs: { 'aria-label': t('settings_toolbar_title') } },
    h('div', { class: 'shd' }, h('h2', { textContent: t('settings_toolbar_title') }), close),
    h('section', {}, h('h3', { textContent: t('settings_section_server') }),
      h('div', { class: 'srow' }, h('span', { class: 'stx' }, h('b', { textContent: ctx.user }), serverLine), out)),
    h('section', {}, h('h3', { textContent: t('settings_section_app') }),
      row(t('settings_language_title'), lang),
      row(t('design_accent_title'), accents),
      row(t('design_song_colors_title'), sw(s.songColors, t('design_song_colors_title'), set('songColors')), t('design_song_colors_summary')),
      row(t('drawer_switch_nebula'), sw(s.nebula, t('drawer_switch_nebula'), set('nebula'))),
      row(t('drawer_switch_autoplay_next'), sw(s.autoplayNext, t('drawer_switch_autoplay_next'), set('autoplayNext'))),
      row(t('order_by_title'), seg([[t('order_by_date_desc'), !s.sortAsc], [t('order_by_date_asc'), s.sortAsc]], (i) => store.set('sortAsc', i === 1), t('order_by_title')))),
    h('section', {}, h('h3', { textContent: t('drawer_item_chords') }),
      row(t('drawer_item_cifrado'), seg([[t('cifrado_american'), !s.chordLatin], [t('cifrado_latin'), s.chordLatin]], (i) => store.set('chordLatin', i === 1), t('drawer_item_cifrado'))),
      row(t('drawer_item_notation'), seg([[t('notation_sharp'), !s.chordFlat], [t('notation_flat'), s.chordFlat]], (i) => store.set('chordFlat', i === 1), t('drawer_item_notation'))),
      row(t('drawer_switch_transposition'), sw(s.chordTranspose, t('drawer_switch_transposition'), set('chordTranspose')))),
    h('section', {}, h('h3', { textContent: t('settings_section_about') }),
      h('p', { class: 'muted', textContent: `Fision Web ${t('about_version_fmt', ctx.webVersion)}` })));
  close.onclick = () => dlg.close();
  out.onclick = () => { if (confirm(t('settings_logout_confirm'))) { dlg.close(); ctx.onLogout(); } };
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // clic fuera
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
