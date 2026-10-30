// Anadir cancion / reprocesar (ImportActivity): tarjeta del audio, separacion con presets y
// tiles, aviso sin GPU y subida con progreso real y cancelable.
import { ApiError, type Api, type JobSubmit, type LibraryEntry } from '../api/client.ts';
import { t } from '../i18n/i18n.ts';
import {
  buildConfig, checkFile, drumsSplit, fileMeta, isSelected, newSep, reprocessErrorKey, restKey, sepFromConfig, tapTile,
  tapVariant, TILE_STEMS, uploadErrorKey, vocalsSplit, AUDIO_EXTS, LOCKED_STEM, type SepMode, type SepState, type TileStem,
} from '../library/importConfig.ts';
import { iconOf } from './stemIcons.ts';
import { h, img, toast } from './dom.ts';

const NAME: Record<TileStem, string> = { vocals: 'import_vocals_always', guitar: 'import_stem_guitar', bass: 'import_stem_bass', drums: 'import_stem_drums', piano: 'import_stem_piano', winds: 'import_stem_brass' };
const ACCEPT = AUDIO_EXTS.map((e) => `.${e}`).join(',') + ',audio/*';

export interface ImportCtx {
  api: Api;
  /** GPU del server (de /server/info); null mientras se lee. */
  gpu: Promise<boolean | null>;
  onSubmitted(r: JobSubmit, meta: { title: string; artist: string }): void;
}

export type ImportTarget = { kind: 'upload'; file: File } | { kind: 'reprocess'; entry: LibraryEntry; cover: string | null };

/** Selector de fichero de audio (cancelar = nada). */
export function pickAudio(): Promise<File | null> {
  return new Promise((res) => {
    // En el DOM (oculto) mientras se elige: Safari lo pide y las pruebas lo encuentran
    const i = h('input', { type: 'file', accept: ACCEPT, hidden: true, class: 'pick-audio' });
    const done = (f: File | null) => { i.remove(); res(f); };
    i.onchange = () => done(i.files?.[0] ?? null);
    i.addEventListener('cancel', () => done(null));
    document.body.append(i);
    i.click();
  });
}

/** Duracion leida del propio fichero (null si el navegador no sabe). */
function durationOf(file: File): Promise<number | null> {
  return new Promise((res) => {
    const a = new Audio(), url = URL.createObjectURL(file);
    const done = (v: number | null) => { URL.revokeObjectURL(url); res(v); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => done(null);
    setTimeout(() => done(null), 5000);
    a.src = url;
  });
}

export function openImport(target: ImportTarget, ctx: ImportCtx): HTMLDialogElement {
  const reprocess = target.kind === 'reprocess';
  let file = target.kind === 'upload' ? target.file : null;
  let duration: number | null = null, gpu: boolean | null = null, abort: AbortController | null = null;
  const sep: SepState = reprocess ? sepFromConfig(target.entry.config) : newSep();

  const cover = h('span', { class: 'imcv' });
  const titleEl = h('b'), artistEl = h('span'), metaEl = h('small');
  const changeBtn = h('button', { class: 'btn ghost', textContent: t('import_change_song'), hidden: reprocess });
  const hero = h('div', { class: 'imhero' }, cover, h('div', { class: 'imtx' }, titleEl, artistEl, metaEl), changeBtn);
  const modeSeg = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': t('import_section_separation') } });
  const tiles = h('div', { class: 'imtiles' });
  const rest = h('div', { class: 'imrest' });
  const gpuWarn = h('p', { class: 'imwarn', textContent: t('import_gpu_warning'), hidden: true });
  const loading = h('p', { class: 'imload', textContent: t('import_loading_server_info') });
  const err = h('p', { class: 'plerr', attrs: { role: 'alert' } });
  const bar = h('progress', { max: 1, value: 0 });
  const pct = h('span', { class: 'fxv' });
  const progress = h('div', { class: 'improg', hidden: true }, h('span', { textContent: t('import_uploading') }), bar, pct);
  const send = h('button', { class: 'btn', textContent: t(reprocess ? 'import_reprocess_short' : 'import_send_short'), disabled: true });
  const cancel = h('button', { class: 'btn ghost', textContent: t('gpu_timeout_cancel') });
  const close = h('button', { class: 'xbtn', textContent: '✕', attrs: { 'aria-label': t('web_close') } });

  const paintHero = async () => {
    if (target.kind === 'reprocess') {
      titleEl.textContent = target.entry.title || target.entry.filename;
      artistEl.textContent = target.entry.artist;
      metaEl.textContent = '';
      cover.replaceChildren(...(target.cover ? [img(target.cover, '', '')] : []));
      return;
    }
    if (!file) return;
    titleEl.textContent = file.name.replace(/\.[^.]+$/, '');
    artistEl.textContent = '';
    metaEl.textContent = fileMeta(file.name, file.size, null);
    duration = await durationOf(file);
    metaEl.textContent = fileMeta(file.name, file.size, duration);
  };

  const paintSep = () => {
    const modes: [SepMode, string][] = [['4stem', t('import_mode_4stem')], ['2stem', t('import_mode_2stem')], ['custom', t('import_personalized')]];
    modeSeg.replaceChildren(...modes.map(([m, l]) => {
      const b = h('button', { textContent: l, attrs: { role: 'radio', 'aria-checked': String(sep.mode === m) } });
      b.onclick = () => { sep.mode = m; paintSep(); };
      return b;
    }));
    tiles.replaceChildren(...TILE_STEMS.map((st) => {
      const on = isSelected(sep, st), locked = st === LOCKED_STEM;
      const tile = h('button', { class: `imtile${on ? ' on' : ''}`, attrs: { 'aria-pressed': String(on), 'aria-label': t(NAME[st]), ...(locked ? { 'aria-disabled': 'true' } : {}) } },
        img(iconOf(st, false), 's', ''), h('span', { textContent: t(NAME[st]) }));
      tile.onclick = () => { tapTile(sep, st); paintSep(); };
      const cell = h('div', { class: 'imcell' }, tile);
      // Voces y bateria llevan variante (solo se ve en personalizada)
      if ((st === 'vocals' || st === 'drums') && sep.mode === 'custom') {
        const split = st === 'vocals' ? vocalsSplit(sep) : drumsSplit(sep);
        const [a, b] = st === 'vocals' ? ['import_tile_vocals_single', 'import_tile_vocals_split'] : ['import_tile_drums_full', 'import_tile_drums_split'];
        const v = h('div', { class: 'imvar' }, ...[[a, false], [b, true]].map(([k, sp]) => {
          const x = h('button', { textContent: t(k as string), attrs: { 'aria-pressed': String(on && split === sp) } });
          x.onclick = () => { tapVariant(sep, st, sp as boolean); paintSep(); };
          return x;
        }));
        cell.append(v);
      }
      return cell;
    }));
    rest.textContent = t(restKey(sep));
  };

  const busy = (on: boolean) => { send.disabled = on || gpu === null; changeBtn.disabled = on; modeSeg.querySelectorAll('button').forEach((b) => (b.disabled = on)); };

  const submitUpload = async () => {
    if (!file) return;
    const bad = checkFile(file.name, file.size, duration);
    if (bad) { err.textContent = t(...bad); return; }
    err.textContent = ''; busy(true); progress.hidden = false;
    abort = new AbortController();
    // El server responde 401 sin leer el cuerpo: refrescar antes de subir todo
    try { await ctx.api.refresh(); } catch (e) { if (e instanceof ApiError && e.status === 401) { dlg.close(); return; } }
    const meta = { title: titleEl.textContent ?? '', artist: artistEl.textContent ?? '' };
    try {
      const r = await ctx.api.uploadJob(file, file.name, buildConfig(sep, !!gpu), (sent, total) => {
        bar.value = total ? sent / total : 0;
        pct.textContent = t('web_upload_progress', `${(sent / 1048576).toFixed(1)} MB`, `${(total / 1048576).toFixed(1)} MB`);
      }, abort.signal);
      dlg.close();
      toast(t('web_upload_sent'));
      ctx.onSubmitted(r, meta);
    } catch (e) {
      if (!(e instanceof ApiError)) { err.textContent = t('import_upload_failed'); return; }
      if (e.code === 'aborted') return;
      // Ya se procesa con otra config: se sigue ese job
      if (e.status === 409 && e.code === 'job_running' && typeof e.body.job_id === 'string') {
        try {
          const j = await ctx.api.job(e.body.job_id);
          dlg.close(); toast(t('import_job_running'));
          ctx.onSubmitted({ hash: j.hash, job_id: j.job_id, state: j.state }, meta);
          return;
        } catch { /* cae al mensaje generico */ }
      }
      if (e.status === 401) { dlg.close(); return; }
      err.textContent = t(...uploadErrorKey(e.status, e.code));
    } finally { abort = null; busy(false); progress.hidden = true; }
  };

  const submitReprocess = async () => {
    if (target.kind !== 'reprocess') return;
    busy(true); err.textContent = '';
    try {
      const r = await ctx.api.reprocess(target.entry.hash, buildConfig(sep, !!gpu));
      dlg.close(); toast(t('reprocess_success'));
      ctx.onSubmitted(r, { title: target.entry.title, artist: target.entry.artist });
    } catch (e) {
      err.textContent = t(...reprocessErrorKey(e instanceof ApiError ? e.status : 0));
    } finally { busy(false); }
  };

  send.onclick = () => void (reprocess ? submitReprocess() : submitUpload());
  cancel.onclick = () => { if (abort) abort.abort(); else dlg.close(); };
  close.onclick = () => { abort?.abort(); dlg.close(); };
  changeBtn.onclick = async () => { const f = await pickAudio(); if (f) { file = f; err.textContent = ''; void paintHero(); } };

  const dlg = h('dialog', { class: 'settings imp', attrs: { 'aria-label': t(reprocess ? 'import_reprocess_title' : 'import_title') } },
    h('div', { class: 'shd' }, h('h2', { textContent: t(reprocess ? 'import_reprocess_title' : 'import_title') }), close),
    hero, h('h3', { textContent: t('import_section_separation') }), modeSeg, tiles, rest, gpuWarn, loading, progress, err,
    h('div', { class: 'plfoot' }, cancel, send));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('cancel', (e) => { if (abort) { e.preventDefault(); abort.abort(); } });
  void paintHero(); paintSep();
  // Device segun /server/info: sin dato = cpu (y el envio espera a saberlo)
  void ctx.gpu.then((g) => { gpu = g ?? false; loading.hidden = true; gpuWarn.hidden = gpu; busy(false); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
