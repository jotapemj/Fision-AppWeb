// Dialogo de Ajustes (SettingsActivity + drawer de Android, lo que aplica a la web).
import { getLang, LANGS, t, type Lang } from '../i18n/i18n.ts';
import type { ServerInfo } from '../api/client.ts';
import { ACCENTS, type Settings, type SettingsStore } from '../settings.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { resetTours } from './coachMark.ts';
import { openLicenses } from './licenses.ts';
import { confirmDialog } from './confirmDialog.ts';

// Nombre de cada idioma en su idioma (R.array.lang_entries)
export const LANG_NAMES: Record<Lang, string> = { en: 'English', es: 'Español', ca: 'Català', uk: 'Українська', 'pt-BR': 'Português (Brasil)',
  fr: 'Français', de: 'Deutsch', it: 'Italiano', ru: 'Русский', 'zh-Hans': '简体中文' };

export interface SettingsContext {
  user: string;
  server: string;
  serverInfo: () => Promise<ServerInfo | null>;
  webVersion: string;
  onLogout(): void;
  /** "Ver tour": los tours vuelven; al cerrar los ajustes empieza el de la biblioteca. */
  onTourReset(): void;
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

/** Estado de la GPU del server (gpu_status_dialog de Android, aqui como seccion): nombre, VRAM libre / total,
 *  aviso si la libre no llega al minimo del server, driver y Actualizar. */
function gpuSection(load: () => Promise<ServerInfo | null>): HTMLElement {
  const badge = h('span', { class: 'gpubadge' }), state = h('b'), name = h('span', { class: 'gpuname' });
  const vram = h('b'), driver = h('b');
  const warn = h('p', { class: 'gpuwarn', textContent: t('gpu_vram_low_body'), hidden: true });
  const details = h('div', { class: 'gpudet' },
    h('div', {}, h('span', { textContent: t('gpu_dialog_label_vram') }), vram), warn,
    h('div', {}, h('span', { textContent: t('gpu_dialog_label_driver') }), driver));
  const refresh = h('button', { class: 'btn ghost', textContent: t('gpu_dialog_refresh') });
  const card = h('div', { class: 'gpucard', attrs: { 'aria-live': 'polite' } },
    h('div', { class: 'gpuhd' }, h('span', { class: 'gputile' }, icon('gpu', 30), badge), h('span', { class: 'stx' }, state, name)), details, refresh);
  const gb = (mb: number) => new Intl.NumberFormat(getLang(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(mb / 1024);
  const paint = (i: ServerInfo | null) => {
    const has = !!i?.gpu;
    card.classList.toggle('ok', has); card.classList.toggle('bad', !has);
    badge.replaceChildren(icon(has ? 'checkThin' : 'crossThin', 16));
    details.hidden = !has;
    if (!i) { state.textContent = t('gpu_dialog_title_unknown'); name.textContent = ''; card.classList.remove('bad'); return; }
    if (!has) { state.textContent = t('gpu_dialog_title_missing'); name.textContent = t('gpu_dialog_no_gpu_body'); return; }
    state.textContent = t('gpu_dialog_title_ok');
    name.textContent = i.gpu_name || t('server_gpu_ok_short');
    const total = Math.max(0, Math.floor((i.vram_total_mb ?? 0) / 1024));
    vram.textContent = i.vram_free_mb != null ? t('vram_free_of_total_fmt', gb(i.vram_free_mb), total) : t('vram_gb_fmt', total);
    const low = i.vram_free_mb != null && i.vram_min_mb != null && i.vram_free_mb < i.vram_min_mb; // isVramLow
    vram.classList.toggle('low', low); warn.hidden = !low;
    driver.textContent = i.driver || '—';
  };
  const run = () => { refresh.disabled = true; void load().then(paint).finally(() => { refresh.disabled = false; }); };
  refresh.onclick = run;
  paint(null); state.textContent = '…';
  run();
  return h('section', {}, h('h3', { textContent: t('server_gpu_title') }), card);
}

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
  ctx.serverInfo().then((i) => { if (i?.version) serverLine.textContent = `${ctx.server} · v${i.version}`; }).catch(() => {});

  const close = h('button', { class: 'xbtn', attrs: { 'aria-label': t('web_close') } }, icon('close'));
  const out = h('button', { class: 'btn ghost', textContent: t('settings_logout_title') });
  const tourBtn = h('button', { class: 'btn ghost', textContent: t('settings_tour_title') });
  const licBtn = h('button', { class: 'btn ghost', textContent: t('about_view_licenses') });
  // Aviso en la fila (un toast quedaria debajo del dialogo modal)
  const tourNote = h('small', { hidden: true, textContent: t('settings_tour_reset'), attrs: { role: 'status' } });
  let tourAgain = false;
  const dlg = h('dialog', { class: 'settings', attrs: { 'aria-label': t('settings_toolbar_title') } },
    h('div', { class: 'shd' }, h('h2', { textContent: t('settings_toolbar_title') }), close),
    h('section', {}, h('h3', { textContent: t('settings_section_server') }),
      h('div', { class: 'srow' }, h('span', { class: 'stx' }, h('b', { textContent: ctx.user }), serverLine), out)),
    gpuSection(ctx.serverInfo),
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
    h('section', {}, h('h3', { textContent: t('performance_title') }),
      row(t('audio3d_title'), seg([[t('performance_audio3d_scene'), s.audio3dScene], [t('performance_audio3d_flat'), !s.audio3dScene]], (i) => store.set('audio3dScene', i === 0), t('audio3d_title')))),
    h('section', {}, h('h3', { textContent: t('settings_section_about') }),
      h('p', { class: 'muted', textContent: `Fision Web ${t('about_version_fmt', ctx.webVersion)}` }),
      h('div', { class: 'srow' }, h('span', { class: 'stx' }, h('b', { textContent: t('settings_tour_title') }), tourNote), tourBtn),
      row(t('licenses_title'), licBtn)));
  close.onclick = () => dlg.close();
  out.onclick = async () => { if (await confirmDialog({ icon: 'logout', message: t('settings_logout_confirm'), yes: t('settings_logout_title') })) { dlg.close(); ctx.onLogout(); } };
  tourBtn.onclick = () => { resetTours(); tourAgain = true; tourNote.hidden = false; };
  licBtn.onclick = () => openLicenses();
  dlg.addEventListener('close', () => { dlg.remove(); if (tourAgain) ctx.onTourReset(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // clic fuera
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
