// Asistente de export = export_wizard_dialog de Android: un dialogo que cambia de paso
// (aviso de solo, mezcla o separadas, volumen, formato + casillas, progreso con Cancelar).
import { t } from '../i18n/i18n.ts';
import { h, toast } from './dom.ts';
import { echoDelayMs, fxActive, type Player, type StemState } from '../player/player.ts';
import { METRONOMES } from '../player/stems.ts';
import { displayName, sanitize, stemGains, timestamp, type FxParams, type Metronome } from '../export/mixdown.ts';
import type { ExportFormat, ExportJob, StemSrc } from '../export/job.ts';
import { canPickFolder, folder, folderSink, runExport, savedFolder, type Running } from '../export/exporter.ts';
import { canEncodeAac } from '../export/m4a.ts';
import type { LibraryEntry } from '../api/client.ts';
import type { StoredFile } from '../lib/songStore.ts';

export interface ExportCtx {
  player: Player;
  entry: LibraryEntry;
  /** Ficheros de la cancion en este navegador (OPFS). */
  load(want: (name: string) => boolean): Promise<StoredFile[]>;
}

type Step = 'solo' | 'mixOrSep' | 'mixVol' | 'mixFmt' | 'sepFmt' | 'stemFmt' | 'progress';

const fxOf = (p: Player, s: StemState): FxParams | null =>
  fxActive(s.fx) ? { filter: s.fx.filter, echo: s.fx.echo, echoMs: echoDelayMs(p.bpm, s.fx.echoDivision), reverb: s.fx.reverb, room: s.fx.room } : null;
const METRO_FILE = [METRONOMES.half, METRONOMES.one, METRONOMES.double];

/** `stem` = export de una pista (boton del panel); sin el, el del menu. */
export function openExport(ctx: ExportCtx, stem: string | null = null) {
  const { player: p, entry: e } = ctx;
  const song = sanitize(displayName(e.title, e.artist, e.filename)) || 'Export';
  const stack: Step[] = [];
  let current = false, withMetro = false, withFx = true, running: Running | null = null;
  const aac = canEncodeAac();

  const title = h('h2');
  const back = h('button', { class: 'xbtn', textContent: '←', attrs: { 'aria-label': t('export_back') } });
  const close = h('button', { class: 'xbtn', textContent: '✕', attrs: { 'aria-label': t('web_close') } });
  const body = h('div', { class: 'expbody' });
  const dlg = h('dialog', { class: 'settings expdlg', attrs: { 'aria-labelledby': 'exp-title' } },
    h('div', { class: 'shd' }, back, title, close), body);
  title.id = 'exp-title';

  const row = (label: string, go: () => void) => { const b = h('button', { class: 'expopt', textContent: label }); b.onclick = go; return b; };
  const check = (label: string, on: boolean, set: (v: boolean) => void) => {
    const c = h('input', { type: 'checkbox' }) as HTMLInputElement;
    c.checked = on; c.onchange = () => set(c.checked);
    return h('label', { class: 'expchk' }, c, h('span', { textContent: label }));
  };
  // Stems que entran en este export (sin metronomos) y sus FX activos
  const stems = () => (stem ? p.stems.filter((s) => s.stem === stem) : p.stems);
  const hasFx = () => stems().some((s) => fxActive(s.fx));

  const show = (s: Step) => {
    body.replaceChildren();
    back.hidden = stack.length < 2 || s === 'progress';
    if (s === 'solo') {
      title.textContent = t('export_solo_title');
      body.append(h('p', { class: 'muted', textContent: t('export_solo_body') }), row(t('export_solo_continue'), () => push('mixOrSep')));
    } else if (s === 'mixOrSep') {
      title.textContent = t('export_dialog_title');
      body.append(row(t('export_choice_mixdown'), () => push('mixVol')), row(t('export_choice_separate'), () => push('sepFmt')));
    } else if (s === 'mixVol') {
      title.textContent = t('export_volume_dialog_title');
      body.append(row(t('export_volume_default'), () => { current = false; push('mixFmt'); }), row(t('export_volume_current'), () => { current = true; push('mixFmt'); }));
    } else if (s === 'progress') {
      title.textContent = t('export_progress_title');
      const bar = h('progress', { max: 100, value: 0 }), pct = h('span', { textContent: '0 %' });
      const cancel = h('button', { class: 'btn ghost', textContent: t('playlist_cancel') });
      cancel.onclick = () => running?.cancel();
      body.append(h('div', { class: 'improg' }, bar, pct), h('div', { class: 'plfoot' }, cancel));
      progressTo = (v) => { bar.value = v; pct.textContent = `${v} %`; };
    } else formatStep(s);
  };
  let progressTo: (v: number) => void = () => {};

  // Paso de formato: WAV / M4A + metronomo (mezcla y pista) + efectos (si hay FX activos) + carpeta
  const formatStep = (s: Step) => {
    title.textContent = t('export_format_dialog_title');
    const wav = row(t('export_format_wav'), () => void start('wav', s));
    const m4a = row(t('export_format_m4a'), () => void start('m4a', s));
    m4a.hidden = true;
    void aac.then((ok) => { m4a.hidden = !ok; });
    body.append(wav, m4a);
    const extras = h('div', { class: 'expx' });
    if (s !== 'sepFmt' && p.hasMetronome) extras.append(check(t('export_include_metronome'), withMetro, (v) => { withMetro = v; }));
    if (hasFx()) extras.append(check(t('export_include_fx'), withFx, (v) => { withFx = v; }));
    if (extras.childElementCount) body.append(extras);
    body.append(folderLine());
  };

  // Donde se guarda: carpeta elegida (Cambiar) o Descargas sin File System Access
  const folderLine = () => {
    const line = h('p', { class: 'expdir muted' });
    if (!canPickFolder()) { line.textContent = t('web_export_downloads'); return line; }
    const paint = () => void savedFolder().then((d) => {
      const change = h('button', { class: 'linkb', textContent: t('web_export_folder_change') });
      change.onclick = async () => { await folder(true); paint(); };
      line.replaceChildren(d ? t('web_export_folder', `${d.name}/${song}`) : t('web_export_folder_pick'), ' ', d ? change : '');
    });
    paint();
    return line;
  };

  const push = (s: Step) => { stack.push(s); show(s); };
  back.onclick = () => { stack.pop(); show(stack[stack.length - 1]); };
  close.onclick = () => dlg.close();
  dlg.addEventListener('close', () => { running?.cancel(); dlg.remove(); });
  dlg.addEventListener('cancel', (ev) => { if (running) ev.preventDefault(); }); // Esc no corta un export: Cancelar

  async function start(format: ExportFormat, s: Step) {
    // Carpeta dentro del clic (pide permiso o la elige); cancelar = seguir en el dialogo
    const dir = canPickFolder() ? await folder() : null;
    if (canPickFolder() && !dir) return;
    push('progress');
    try {
      const sink = await folderSink(dir, song);
      const job = await buildJob(format, s);
      running = runExport(job, sink, (v) => progressTo(v));
      await running.done;
      running = null;
      dlg.close();
      toast(t('export_done'));
    } catch (err) {
      running = null;
      const msg = err instanceof Error ? err.message : String(err);
      dlg.close();
      if (msg !== 'cancelled') { console.error('export', err); toast(`${t('export_failed')}: ${msg}`, 6000); }
    }
  }

  async function buildJob(format: ExportFormat, s: Step): Promise<ExportJob> {
    const list = stems();
    const metroName = s !== 'sepFmt' && withMetro ? METRO_FILE[p.metroSpeed] : null;
    const files = await ctx.load((n) => { const b = n.replace(/\.(flac|wav)$/i, ''); return b !== n && (list.some((x) => x.stem === b) || b === metroName); });
    const file = (b: string) => files.find((f) => f.name.replace(/\.(flac|wav)$/i, '') === b);
    const src = (x: StemState): StemSrc | null => { const f = file(x.stem); return f ? { stem: x.stem, name: f.name, bytes: f.data, fx: withFx ? fxOf(p, x) : null } : null; };
    const mf = metroName ? file(metroName) : undefined;
    const metro: Metronome | null = mf ? { name: mf.name, bytes: mf.data, volume: Math.max(0, Math.min(1, p.metroVolume * 0.01)) } : null;
    const base = { format, prefix: song, stamp: timestamp() };
    if (s === 'stemFmt') { const one = src(list[0]); if (!one) throw new Error('stem_missing'); return { ...base, kind: 'stem', stem: one, metro }; }
    const srcs = list.map((x) => [x, src(x)] as const).filter((x): x is readonly [StemState, StemSrc] => !!x[1]);
    if (!srcs.length) throw new Error('no_stems');
    if (s === 'sepFmt') return { ...base, kind: 'separate', stems: srcs.map(([, y]) => y) };
    return { ...base, kind: 'mix', metro, stems: srcs.map(([x, y]) => {
      const [volL, volR] = current ? stemGains(x.volume, x.pan) : [0.75, 0.75];
      return { name: y.name, bytes: y.bytes, fx: y.fx, volL, volR };
    }) };
  }

  document.body.append(dlg);
  dlg.showModal();
  // El export ignora el solo (usa los sliders): se avisa antes, en el mismo dialogo
  push(stem ? 'stemFmt' : p.stems.some((x) => x.solo) ? 'solo' : 'mixOrSep');
}
