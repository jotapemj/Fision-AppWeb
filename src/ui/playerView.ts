// Reproductor de escritorio (maquetas player.html y mix.html).
// Movil (setMobile): calco de PlayerActivity con las mismas piezas: tira arriba, mezcla como vista principal,
// letra / diagramas / 3D desde la fila de 6 botones, hojas inferiores de tono, metronomo y stem.
import type { LibraryEntry } from '../api/client.ts';
import { t } from '../i18n/i18n.ts';
import { BPM_MAX, BPM_MIN, ECHO_BEATS, localBpmAt, windowBpm, Repeat, ECHO_LABELS, FX_FALLBACK_BPM, MULT_MAX, MULT_MIN, MULT_STEP, PITCH_MAX, PITCH_MIN, filterCutoffHz, fxActive, newFx, type MetroSpeed, type Player, type StemState } from '../player/player.ts';
import { DEFAULT_VOLUME, isDrumPart, titleKey } from '../player/stems.ts';
import { iconOf } from './stemIcons.ts';
import { LyricsView, type LyricsActions, type LyricsState } from './lyricsView.ts';
import { LYRICS_CLOCK_OFFSET_MS } from '../player/lyrics.ts';
import { currentBeat, type BeatCell } from '../player/chords.ts';
import { ChordGrid } from './chordGrid.ts';
import { ChordStrip } from './chordStrip.ts';
import { ChordDiagrams } from './chordDiagrams.ts';
import { sceneSpinner } from './curtain.ts';
import { animateSlider, dismissable, fmtTime, h, img, reducedMotion, setSlider, slider } from './dom.ts';
import { icon } from './icons.ts';
import { DOWNBEAT_SOUNDS } from '../settings.ts';
import { startTour, views, type LegendRow, type Step } from './coachMark.ts';
import icLyrics from '../assets/icons/ic_lyrics.svg';
import icChords from '../assets/icons/ic_chord_carousel.svg';
import icItd from '../assets/icons/ic_itd.png';
import icRepeat from '../assets/icons/ic_repeat.svg';
import icPitch from '../assets/icons/ic_pitch.svg';
import icMetronome from '../assets/icons/ic_metronome.svg';
import icBack5 from '../assets/icons/ic_seek_back_5.svg';
import icFwd5 from '../assets/icons/ic_seek_forward_5.svg';
import icPrev from '../assets/icons/ic_skip_previous.svg';
import icNext from '../assets/icons/ic_skip_next.svg';
import icRestore from '../assets/icons/ic_restore_stem.svg';
import icDrumset from '../assets/icons/ic_drumset.png';
import icMenu from '../assets/icons/ic_menu.svg';
import icCollapse from '../assets/icons/ic_back_downside.svg';
import icRepeatOne from '../assets/icons/ic_repeat_one.svg';
import icDiagram from '../assets/icons/ic_chord_diagram.svg';
import { openSheet } from './sheet.ts';
import { Ruler } from './ruler.ts';
import type { Scene3D } from './scene3d.ts';
import type { Flat3D } from './flat3d.ts';

export type View = 'lyrics' | 'chords' | 'mix' | '3d';

export interface PlayerHooks {
  onPrev(): void; onNext(): void; onEnded(r: 'next'): void; onPlayState(playing: boolean): void;
  /** Movil: bajar el reproductor a la biblioteca (b_back). */
  onCollapse?(): void;
  /** Beat nuevo: posicion en el compas, compas y tempo oido (BPM x multiplicador). */
  onBeat(pos: number, beatsPerBar: number, heardBpm: number | null, timeSec: number): void;
  nebula: { get(): boolean; set(on: boolean): void };
  /** Sonido en downbeat (global) y su sonido: indice de DOWNBEAT_SOUNDS. */
  downbeat: { get(): { on: boolean; type: number }; setOn(on: boolean): void; setType(i: number): void };
  /** Formato de acorde con los ajustes (latino, bemoles, transporte con el tono). */
  formatChord(c: string | null): string;
  /** Transporte (trasponer con el tono), cifrado latino y bemoles: para diagramas y nombres de nota. */
  chordNotation(): { shift: number; latin: boolean; flat: boolean };
  /** Hay chords_basic.txt: se ofrece Basicos / Avanzado. */
  hasBasicChords: boolean;
  /** audio3d_scene_enabled: true = escena 3D, false = vista plana. */
  scene3d(): boolean;
  onChordsBasic(basic: boolean): void;
  onPitch?(): void;
  /** Vista elegida (la nebulosa oculta sus blobs en 3D). */
  onView?(v: View): void;
  /** Reprocesar en el server (solo canciones del server). */
  onReprocess?(): void;
  /** Exportar la mezcla / separadas (null) o una pista. */
  onExport?(stem: string | null): void;
  /** Pedir / cancelar transcripcion de letra. */
  lyrics?: LyricsActions;
}

const MIX_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v16M12 4v16M18 4v16" stroke="currentColor" stroke-width="1.5"/><rect x="3.5" y="13" width="5" height="3" rx="1" fill="currentColor"/><rect x="9.5" y="7" width="5" height="3" rx="1" fill="currentColor"/><rect x="15.5" y="11" width="5" height="3" rx="1" fill="currentColor"/></svg>';
const LYRICS_FOLD_PX = 24; // LYRICS_FOLD_THRESHOLD_DP: desplazamiento a mano que pliega o despliega
const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="#000"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="#000"/></svg>';
const SPEED_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 15a8 8 0 1 1 16 0" stroke="#fff" stroke-width="1.6" fill="none"/><path d="M12 15l4-5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>';
const VIEW_PREF = 'fision.view'; // vista recordada (comodidad por navegador)
const CHORD_VIEW_PREF = 'fision.chordView'; // chord_diagram_view: 0 diagramas, 1 cuadricula
function loadChordView(): boolean { try { return localStorage.getItem(CHORD_VIEW_PREF) === '1'; } catch { return false; } }
function saveChordView(grid: boolean) { try { localStorage.setItem(CHORD_VIEW_PREF, grid ? '1' : '0'); } catch { /* sin storage */ } }
function loadView(): View { try { const v = localStorage.getItem(VIEW_PREF); return v === 'lyrics' || v === 'chords' || v === '3d' ? v : 'mix'; } catch { return 'mix'; } }

const withSvg = (el: HTMLElement, markup: string) => { el.insertAdjacentHTML('afterbegin', markup); return el; };
/** Icono tintable (MaterialButton iconTint): mascara con el color del texto. */
// Iconos por mascara ya en memoria (data:): cada vuelta a la mezcla rehace las filas y la mascara por url
// se queda en blanco mientras la red responde
const iconData = new Map<string, string>();
async function cacheIcon(url: string) {
  if (iconData.has(url) || url.startsWith('data:')) return;
  iconData.set(url, url); // no pedirlo dos veces
  try {
    const blob = await (await fetch(url)).blob();
    const data = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.onerror = rej; fr.readAsDataURL(blob); });
    iconData.set(url, data);
    document.querySelectorAll<HTMLElement>('[data-ic]').forEach((e) => { if (e.dataset.ic === url) e.style.setProperty('--ic', `url("${data}")`); });
  } catch { iconData.delete(url); }
}
const maskIcon = (url: string, cls = 'mi') => {
  const e = h('span', { class: cls, attrs: { 'aria-hidden': 'true' } });
  e.dataset.ic = url;
  e.style.setProperty('--ic', `url("${iconData.get(url) ?? url}")`);
  void cacheIcon(url);
  return e;
};
const MORE_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="5.5" r="2" fill="#fff"/><circle cx="12" cy="12" r="2" fill="#fff"/><circle cx="12" cy="18.5" r="2" fill="#fff"/></svg>';
const LONG_PRESS_MS = 450;
type MOpt = 'repeat' | 'lyrics' | 'pitch' | 'metro' | 'chords' | '3d';

/** Barra inferior sin cancion: todo desactivado. */
export function idleBar(): HTMLElement {
  const b = h('div', { class: 'pbar' });
  b.append(h('div'), h('div', { class: 'btns' }, withSvg(h('button', { class: 'play', disabled: true, attrs: { 'aria-label': t('web_play') } }), PLAY_SVG)), h('div'));
  return b;
}

export class PlayerView {
  readonly main: HTMLElement;
  readonly bar: HTMLElement;
  private p: Player;
  private hooks: PlayerHooks;
  private view: View = loadView();
  private lyrics: LyricsView;
  private beats: { cells: BeatCell[]; beatsPerBar: number } | null = null;
  private chords: { cells: BeatCell[]; beatsPerBar: number; strip: ChordStrip; diagrams: ChordDiagrams; grid: ChordGrid } | null = null;
  private chordGrid = loadChordView(); // Diagramas | Cuadricula (chord_diagram_view, global)
  private beat = -2;
  private chordBeat = -2;
  private viewBox = h('div', { class: 'view' });
  private tabs = new Map<View, HTMLButtonElement>();
  private seekEl: HTMLInputElement;
  private posEl = h('span');
  private playBtn: HTMLButtonElement;
  private repeatVal = h('b');
  private pitchVal = h('b');
  private tempoVal = h('b');
  private metroVal = h('b');
  private seeking = false;
  private raf = 0;
  private drumsOpen = true;
  private fxStem: string | null = null; // stem del panel derecho
  private scene3d: Scene3D | Flat3D | null = null; // se construye la primera vez y vive con la cancion
  private scene3dLoading = false;
  private dead = false;
  private card: { cover: string | null; title: string; artist: string };
  private seg: HTMLElement;
  private acts: HTMLElement;
  private menuBtn: HTMLElement;
  private tourWanted = false; // el tour espera a la vista Mezcla
  // --- movil ---
  private mobile = false;
  private stripSlot = h('div', { class: 'mstrip off', hidden: true });
  private stripTimer = 0;
  private cascadeOn = true;
  private mBpm = h('p', { class: 'mbpm' });
  // Controles plegados en la letra (movil)
  private folded = false;
  private foldAccum = 0;
  private lyricsContent = false;
  private mOpts = new Map<MOpt, HTMLButtonElement>();
  private bpmBeat = -2;
  private moptsEl!: HTMLElement;

  constructor(p: Player, song: LibraryEntry, cover: string | null, hooks: PlayerHooks) {
    this.p = p; this.hooks = hooks;
    this.card = { cover, title: song.title || song.filename, artist: song.artist ?? '' };
    this.lyrics = new LyricsView({ kind: 'loading' }, (sec) => p.seek(sec * 1000));
    // Acordes en la letra: por cancion (Room chordsOnLyrics)
    this.lyrics.setChordsOn(p.chordsOnLyrics);
    this.lyrics.onChordsToggle = (on) => p.setChordsOnLyrics(on);
    // Movil: bajar leyendo pliega los controles a la fila del transporte; subir (o llegar arriba) los despliega
    this.lyrics.onUserScroll = (dy, atTop) => {
      if (!this.mobile || this.view !== 'lyrics') return;
      if ((dy > 0) !== (this.foldAccum > 0)) this.foldAccum = 0;
      this.foldAccum += dy;
      if (this.foldAccum > LYRICS_FOLD_PX) this.setFold(true);
      else if (this.foldAccum < -LYRICS_FOLD_PX || atTop) this.setFold(false);
    };
    this.lyrics.onContent = (on) => { this.lyricsContent = on; if (!on) this.setFold(false); };
    this.lyrics.onClose = () => this.setView('mix');
    this.lyrics.actions = hooks.lyrics ?? null;
    const collapse = h('button', { class: 'mback', attrs: { 'aria-label': t('web_collapse_player') }, onclick: () => hooks.onCollapse?.() }, img(icCollapse, '', ''));
    const top = h('div', { class: 'top' }, collapse,
      cover ? img(cover, 'cover', t('cd_cover')) : h('span', { class: 'cover' }),
      h('div', { class: 't' }, h('h2', { textContent: song.title || song.filename }), h('span', { textContent: song.artist })),
      h('h2', { class: 'mtt', textContent: song.artist ? `${song.artist} - ${song.title || song.filename}` : song.title || song.filename }),
      h('span', { class: 'sp' }));
    const menuBtn = h('button', { class: 'ib', attrs: { 'aria-label': t('web_menu'), 'aria-haspopup': 'dialog' } }, img(icMenu, '', ''));
    menuBtn.onclick = () => this.menuPop(menuBtn, top);
    top.append(menuBtn);
    this.menuBtn = menuBtn;

    const seg = this.seg = h('div', { class: 'seg2', attrs: { role: 'tablist' } });
    const tab = (v: View, label: string, icon: string | null, svgMarkup = '') => {
      const b = h('button', { attrs: { role: 'tab', 'aria-selected': String(v === this.view) }, onclick: () => this.setView(v) }, icon ? img(icon, '', '') : '', label);
      if (svgMarkup) withSvg(b, svgMarkup);
      this.tabs.set(v, b); seg.append(b);
    };
    tab('lyrics', t('web_view_lyrics'), icLyrics);
    tab('chords', t('web_view_chords'), icChords);
    tab('mix', t('web_view_mix'), null, MIX_SVG);
    tab('3d', t('web_view_3d'), icItd);
    this.tabs.get('3d')!.classList.toggle('on3d', p.audio3d);
    this.main = h('main', { class: 'main' }, top, this.stripSlot, h('div', { class: 'vbar' }, seg), this.viewBox);
    (this.main as HTMLElement & { player?: Player; view?: PlayerView }).player = p; // acceso de las pruebas
    (this.main as HTMLElement & { view?: PlayerView }).view = this;

    // --- barra inferior ---
    this.seekEl = slider(0, 1000, 1, 0, t('web_position'));
    this.seekEl.onpointerdown = () => (this.seeking = true);
    // Mientras se arrastra, el reloj muestra el tiempo del dedo
    this.seekEl.addEventListener('input', () => { if (this.seeking) this.posEl.textContent = fmtTime(+this.seekEl.value / 1000 * p.durationMs); });
    this.seekEl.onchange = () => { this.seeking = false; p.seek(+this.seekEl.value / 1000 * p.durationMs); };
    const seek = h('div', { class: 'seek' }, this.seekEl, h('div', { class: 'meta' }, this.posEl, h('span', { textContent: fmtTime(p.durationMs) })));
    const ib = (icon: string, label: string, fn: () => void) => h('button', { class: 'ib', attrs: { 'aria-label': label }, onclick: fn }, img(icon, '', ''));
    this.playBtn = h('button', { class: 'play', onclick: () => this.toggle() });
    const btns = h('div', { class: 'btns' }, ib(icBack5, t('web_back5'), () => p.skip(-5000)), ib(icPrev, t('web_prev'), hooks.onPrev),
      this.playBtn, ib(icNext, t('web_next'), hooks.onNext), ib(icFwd5, t('web_fwd5'), () => p.skip(5000)));
    const act = (icon: string | null, svgMarkup: string, label: string, val: HTMLElement, fn: (b: HTMLButtonElement) => void) => {
      const b = h('button', { class: 'act' }, icon ? img(icon, '', '') : '', h('span', {}, h('small', { textContent: label }), val));
      if (svgMarkup) withSvg(b, svgMarkup);
      b.onclick = () => fn(b);
      return b;
    };
    const acts = this.acts = h('div', { class: 'acts' },
      act(icRepeat, '', t('web_repeat'), this.repeatVal, () => { p.cycleRepeat(); this.refreshActs(); }),
      act(icPitch, '', t('cd_pitch'), this.pitchVal, (b) => this.pitchPop(b, acts)),
      p.hasMetronome ? act(icMetronome, '', t('cd_metronome'), this.metroVal, (b) => this.metroPop(b, acts)) : null,
      act(null, SPEED_SVG, t('web_tempo'), this.tempoVal, (b) => this.tempoPop(b, acts)));
    // Movil: "BPM: N" (tempo local) arriba y la fila de 6 botones (optionsLayout) abajo
    const opt = (k: MOpt, icon: string, label: string, fn: (b: HTMLButtonElement) => void) => {
      const b = h('button', { class: `mo mo-${k}`, attrs: { 'aria-label': label } }, maskIcon(icon));
      b.onclick = () => fn(b);
      this.mOpts.set(k, b);
      return b;
    };
    const metroBtn = opt('metro', icMetronome, t('cd_metronome'), () => this.metroSheet());
    this.longPress(metroBtn, () => { p.setMetronome(!p.metroOn); this.refreshActs(); }); // pulsacion larga = encender / apagar
    metroBtn.disabled = !p.hasMetronome;
    const mopts = this.moptsEl = h('div', { class: 'mopts' },
      opt('repeat', icRepeat, t('b_repeat_description'), () => { p.cycleRepeat(); this.refreshActs(); }),
      opt('lyrics', icLyrics, t('lyrics_button_description'), () => this.setView(this.view === 'lyrics' ? 'mix' : 'lyrics')),
      opt('pitch', icPitch, t('cd_pitch'), () => this.pitchSheet()),
      metroBtn,
      opt('chords', icChords, t('cd_chords_toggle'), (b) => this.chordButton(b)),
      opt('3d', icItd, t('cd_audio_3d'), () => this.setView(this.view === '3d' ? 'mix' : '3d')));
    this.mBpm.hidden = !p.bpm && !p.beats.length;
    this.mBpm.textContent = `${t('tv_bpm')} ${p.bpm ? Math.round(p.bpm) : ''}`;
    this.bar = h('div', { class: 'pbar' }, this.mBpm, seek, btns, acts, mopts);

    this.refreshActs();
    this.refreshPlay();
    this.renderView();
    hooks.onView?.(this.view);
    this.loop();
  }

  /** Movil (calco de Android) o escritorio: misma vista, otra disposicion. La vista de escritorio no se pisa. */
  setMobile(on: boolean) {
    if (on === this.mobile) return;
    if (!on) this.setFold(false);
    this.mobile = on;
    // Android abre en la mezcla (o en 3D si la cancion tiene el 3D encendido)
    this.view = on ? (this.p.audio3d ? '3d' : 'mix') : loadView();
    for (const [k, b] of this.tabs) b.setAttribute('aria-selected', String(k === this.view));
    this.hooks.onView?.(this.view);
    this.renderView();
  }

  private longPress(b: HTMLElement, fn: () => void) {
    let timer = 0, fired = false;
    b.addEventListener('pointerdown', () => { fired = false; timer = window.setTimeout(() => { fired = true; fn(); }, LONG_PRESS_MS); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(timer));
    b.addEventListener('click', (e) => { if (fired) { e.stopImmediatePropagation(); fired = false; } }, true);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Tinte de los 6 botones (acento = activo), icono de repetir uno y de diagramas abiertos. */
  private refreshMOpts() {
    const p = this.p, on = (k: MOpt, v: boolean) => this.mOpts.get(k)?.classList.toggle('on', v);
    on('repeat', p.repeat !== Repeat.Off);
    on('lyrics', this.view === 'lyrics');
    on('pitch', p.pitch !== 0);
    on('metro', p.metroOn);
    on('chords', this.view === 'chords' || (!!this.chords && p.chordsActive));
    on('3d', this.view === '3d');
    this.mOpts.get('repeat')?.firstElementChild?.setAttribute('style', `--ic: url("${p.repeat === Repeat.One ? icRepeatOne : icRepeat}")`);
    this.mOpts.get('chords')?.firstElementChild?.setAttribute('style', `--ic: url("${this.view === 'chords' ? icDiagram : icChords}")`);
    const ch = this.mOpts.get('chords');
    if (ch) ch.disabled = !this.chords;
  }

  /** Tira de acordes arriba (rv_chords): con acordes, carrusel activo o diagramas abiertos; nunca en 3D ni con la cuadricula. */
  private placeStrip() {
    const c = this.chords;
    const show = this.mobile && !!c && this.view !== '3d' && !(this.view === 'chords' && this.chordGrid) && (this.p.chordsActive || this.view === 'chords');
    const slot = this.stripSlot, was = !slot.hidden && !slot.classList.contains('off');
    // Siempre la tira actual: los acordes pueden recargarse con la tira ya visible
    if (show && c!.strip.el.parentElement !== slot) { slot.replaceChildren(c!.strip.el); c!.strip.invalidate(); this.chordBeat = -2; }
    if (show === was) return;
    clearTimeout(this.stripTimer);
    if (show) {
      slot.hidden = false;
      void slot.offsetHeight; // parte de la altura 0
      slot.classList.remove('off');
    } else {
      slot.classList.add('off');
      const end = () => { slot.hidden = true; slot.replaceChildren(); };
      if (!this.mobile || reducedMotion()) end(); else this.stripTimer = window.setTimeout(end, 460);
    }
  }

  /** Boton de acordes (onChordButton): con diagramas abiertos los cierra; si no, pildora carrusel / diagramas. */
  private chordButton(b: HTMLButtonElement) {
    if (this.view === 'chords') { this.setView('mix'); return; }
    if (b.getAttribute('aria-expanded') === 'true') return;
    const pill = h('div', { class: 'cpill', attrs: { role: 'menu' } });
    const diag = h('button', { class: 'mo', attrs: { role: 'menuitem', 'aria-label': t('chord_view_diagrams') } }, maskIcon(icDiagram));
    diag.disabled = this.view === 'lyrics' || this.view === '3d'; // otra vista completa abierta
    const car = h('button', { class: `mo${this.p.chordsActive ? ' on' : ''}`, attrs: { role: 'menuitemcheckbox', 'aria-checked': String(this.p.chordsActive), 'aria-label': t('cd_chords_toggle') } }, maskIcon(icChords));
    diag.onclick = () => { close(); this.setView('chords'); };
    car.onclick = () => { close(); this.p.setChordsActive(!this.p.chordsActive); this.placeStrip(); this.refreshMOpts(); };
    pill.append(diag, car);
    document.body.append(pill);
    const r = b.getBoundingClientRect();
    pill.style.left = `${r.left}px`; pill.style.width = `${r.width}px`; pill.style.bottom = `${innerHeight - r.bottom}px`;
    b.setAttribute('aria-expanded', 'true');
    const close = dismissable(pill, () => b.setAttribute('aria-expanded', 'false'), [b]);
    (diag.disabled ? car : diag).focus();
  }

  /** Hoja de tono (pitch_modal_sheet_dialog): regla -12..+12 con referencia en 0 y restaurar. */
  private pitchSheet() {
    const p = this.p;
    openSheet(t('tv_pitch_title'), (body) => {
      const show = h('b', { class: 'rval' });
      const fmt = (v: number) => (v > 0 ? `+${v}` : String(v));
      const ruler = new Ruler({ min: PITCH_MIN, max: PITCH_MAX, step: 1, value: p.pitch, spacing: 28, neutral: 0, label: t('cd_pitch'),
        onChange: (v) => { const before = p.pitch; p.setPitch(v); if (p.pitch !== before) this.hooks.onPitch?.(); show.textContent = fmt(p.pitch); this.refreshActs(); } });
      show.textContent = fmt(p.pitch);
      const rs = h('button', { class: 'rrs', attrs: { 'aria-label': t('cd_restore_volume') }, onclick: () => ruler.restore() }, img(icRestore, '', ''));
      body.append(h('h2', { class: 'sht', textContent: t('tv_pitch_title') }), h('p', { class: 'shsub', textContent: t('tv_pitch_semitones') }),
        h('div', { class: 'rhead' }, show, rs), ruler.el);
    }, undefined, this.main);
  }

  /** Hoja del metronomo (metronome_modal_sheet_dialog): encendido, 0.5x/1x/2x (A/B), volumen, balance y velocidad. */
  private metroSheet() {
    const p = this.p;
    openSheet(t('tv_metronome_title'), (body) => {
      const sw = h('button', { class: 'switch', attrs: { role: 'switch', 'aria-label': t('tv_metronome_title') } });
      const speeds = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': t('tv_metronome_title') } });
      const ab = h('div', { class: 'seg ab', attrs: { role: 'radiogroup' } });
      const vol = slider(0, 100, 1, p.metroVolume, t('tv_metronome_volume'));
      const pan = slider(-100, 100, 1, p.metroPan, t('pan_title'));
      pan.classList.add('bi');
      const panRs = h('button', { class: 'rrs', attrs: { 'aria-label': t('pan_title') } }, img(icRestore, '', ''));
      const sync = () => {
        sw.setAttribute('aria-checked', String(p.metroOn));
        speeds.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-checked', String(i === p.metroSpeed)));
        ab.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-checked', String(i === Number(p.metroHalfB))));
        ab.hidden = p.metroSpeed !== 0;
        // Apagado: el resto queda atenuado y sin tocar (enableMetronome)
        for (const c of [...speeds.querySelectorAll('button'), ...ab.querySelectorAll('button'), vol, pan, panRs]) (c as HTMLButtonElement).disabled = !p.metroOn;
        panRs.style.visibility = p.metroPan ? 'visible' : 'hidden';
        this.refreshActs();
      };
      sw.onclick = () => { p.setMetronome(!p.metroOn); sync(); };
      [t('b_metronomeHalf'), t('b_metronome'), t('b_metronomeDouble')].forEach((l, i) => speeds.append(h('button', { textContent: l, attrs: { role: 'radio' }, onclick: () => { p.setMetronome(true, i as MetroSpeed); sync(); } })));
      [t('metronome_half_variant_a'), t('metronome_half_variant_b')].forEach((l, i) => ab.append(h('button', { textContent: l, attrs: { role: 'radio' }, onclick: () => { p.setHalfVariantB(i === 1); sync(); } })));
      vol.addEventListener('input', () => { p.setMetronome(p.metroOn, p.metroSpeed, +vol.value); });
      pan.addEventListener('input', () => { p.setMetroPan(+pan.value); sync(); });
      panRs.onclick = () => { p.setMetroPan(0); animateSlider(pan, 0); sync(); };
      // Velocidad en BPM absolutos (50..200, referencia = BPM global) o multiplicador sin BPM (0.50..1.50)
      const bpm = p.bpm, show = h('b', { class: 'rval' });
      const label = () => (bpm ? `${p.targetBpm} BPM` : `${p.tempoMult.toFixed(2)}×`);
      const ruler = bpm
        ? new Ruler({ min: BPM_MIN, max: BPM_MAX, step: 1, value: p.targetBpm!, neutral: Math.round(bpm), label: t('tv_metronome_speed'), onChange: (v) => { p.setTempoBpm(v); show.textContent = label(); this.refreshActs(); } })
        : new Ruler({ min: 50, max: 150, step: 5, value: Math.round(p.tempoMult * 100), neutral: 100, label: t('tv_metronome_speed'), onChange: (v) => { p.setTempoMult(v / 100); show.textContent = label(); this.refreshActs(); } });
      show.textContent = label();
      const tempoRs = h('button', { class: 'rrs', attrs: { 'aria-label': t('tv_metronome_speed') }, onclick: () => ruler.restore() }, img(icRestore, '', ''));
      // "Esta parte de la cancion va a N BPM" (tempo del beat actual, al abrir)
      const local = localBpmAt(p.beats, p.positionMs / 1000, bpm);
      const hud = h('p', { class: 'hud', hidden: !local });
      // Texto de Android con el numero en negrita: <b>N BPM</b>
      const m = t('tempo_local_hud_html', String(local)).match(/^([\s\S]*)<b>([\s\S]*)<\/b>([\s\S]*)$/);
      if (m) hud.append(m[1], h('b', { textContent: m[2] }), m[3]); else hud.textContent = t('tempo_local_hud_html', String(local)).replace(/<\/?b>/g, '');
      body.append(h('div', { class: 'shrow' }, h('h2', { class: 'sht', textContent: t('tv_metronome_title') }), sw), speeds, ab,
        h('h3', { class: 'shl', textContent: t('tv_metronome_volume') }), h('div', { class: 'shsl' }, vol),
        h('h3', { class: 'shl', textContent: t('pan_title') }), h('div', { class: 'shsl lr' }, h('span', { textContent: t('pan_l') }), pan, h('span', { textContent: t('pan_r') }), panRs),
        h('h3', { class: 'shl sp', textContent: t('tv_metronome_speed') }), h('div', { class: 'rhead' }, show, tempoRs), ruler.el, hud);
      sync();
    }, undefined, this.main);
  }

  /** Hoja del stem (⋮ de la fila = player_modal_sheet_dialog): balance, FX y exportar. */
  private stemSheet(s: StemState) {
    const v2 = this.p.hasVocals2;
    openSheet(t(titleKey(s.stem, v2)) || s.stem, (body) => {
      const fill = () => body.replaceChildren(this.fxPanel(s, v2, fill));
      fill();
    }, undefined, this.main);
  }

  /** Menu del icono del stem (stem_context_menu): Solo / Silenciar. */
  private stemMenu(anchor: HTMLElement, s: StemState, sync: () => void) {
    if (anchor.getAttribute('aria-expanded') === 'true') return;
    const item = (label: string, on: boolean, fn: () => void) => h('button', { textContent: label, attrs: { role: 'menuitemcheckbox', 'aria-checked': String(on) }, onclick: () => { close(); fn(); } });
    const menu = h('div', { class: 'menu rowmenu', attrs: { role: 'menu' } },
      item(t('stem_menu_solo'), s.solo, () => { this.p.toggleSolo(s.stem); this.refreshSolo(); }),
      item(t('stem_menu_mute'), s.volume === 0, () => { this.p.toggleMute(s.stem); sync(); this.refreshSolo(); }));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect(), m = menu.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 4 + m.height > innerHeight - 8 ? r.top - 4 - m.height : r.bottom + 4}px`;
    anchor.setAttribute('aria-expanded', 'true');
    const close = dismissable(menu, () => anchor.setAttribute('aria-expanded', 'false'), [anchor]);
    (menu.querySelector('button') as HTMLButtonElement).focus();
  }

  /** Cabecera de bateria: Solo de todas las piezas (si ya estan todas, se quitan). */
  private drumSoloMenu(anchor: HTMLElement, drums: StemState[]) {
    if (anchor.getAttribute('aria-expanded') === 'true') return;
    const all = drums.every((d) => d.solo);
    const b = h('button', { textContent: t('stem_menu_solo'), attrs: { role: 'menuitemcheckbox', 'aria-checked': String(all) } });
    const menu = h('div', { class: 'menu rowmenu', attrs: { role: 'menu' } }, b);
    b.onclick = () => { close(); for (const d of drums) if (d.solo === all) this.p.toggleSolo(d.stem); this.refreshSolo(); };
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${r.left}px`; menu.style.top = `${r.bottom + 4}px`;
    anchor.setAttribute('aria-expanded', 'true');
    const close = dismissable(menu, () => anchor.setAttribute('aria-expanded', 'false'), [anchor]);
    b.focus();
  }

  /** Solo: icono en acento; los demas, icono .35 y slider .5 (sin bloquear). */
  private refreshSolo() {
    const any = this.p.stems.some((x) => x.solo);
    this.viewBox.querySelectorAll<HTMLElement>('.stem').forEach((row) => {
      const st = this.p.stems.find((x) => x.stem === row.dataset.stem);
      row.classList.toggle('soloed', !!st?.solo);
      row.classList.toggle('soloout', any && !st?.solo);
      row.querySelector('.solo')?.setAttribute('aria-pressed', String(!!st?.solo));
    });
    const drums = this.p.stems.filter((x) => isDrumPart(x.stem));
    this.viewBox.querySelector('.gsolo')?.classList.toggle('on', drums.length > 0 && drums.every((d) => d.solo));
  }

  destroy() { this.dead = true; cancelAnimationFrame(this.raf); this.scene3d?.destroy(); this.scene3d = null; }

  /** Cambio Escena 3D / 2D en ajustes: se rehace la vista (la pose guardada es la misma). */
  reload3D() {
    if (!this.scene3d) return;
    this.scene3d.destroy(); this.scene3d = null;
    if (this.view === '3d') this.renderView();
  }

  private lyricsState: LyricsState = { kind: 'loading' };

  setLyrics(state: LyricsState) {
    this.lyricsState = state;
    this.lyrics.set(state.kind === 'content' ? { ...state, fmt: (c) => this.hooks.formatChord(c) } : state);
  }

  /** Los ajustes de acordes cambiaron (o el tono, si se transporta): repintar acordes. */
  reformatChords() {
    if (this.beats) this.setChords(this.beats.cells, this.beats.beatsPerBar); // rehace tira y diagramas
    this.setLyrics(this.lyricsState);
  }

  setChords(cells: BeatCell[], beatsPerBar: number) {
    this.beats = cells.length ? { cells, beatsPerBar } : null;
    if (!cells.some((c) => c.chord)) return;
    this.chords?.diagrams.destroy();
    this.chords?.grid.destroy();
    this.chords?.strip.destroy();
    const diagrams = new ChordDiagrams(cells, { notation: () => this.hooks.chordNotation(), format: (c) => this.hooks.formatChord(c),
      seekBeat: (b) => this.p.seek((cells[b]?.time ?? 0) * 1000) });
    const seek = (sec: number) => this.p.seek(sec * 1000), fmt = (c: string | null) => this.hooks.formatChord(c);
    this.chords = { cells, beatsPerBar, strip: new ChordStrip(cells, beatsPerBar, seek, fmt), diagrams, grid: new ChordGrid(cells, seek, fmt) };
    this.chordBeat = -2;
    if (this.view === 'chords') this.renderView();
    else { this.placeStrip(); this.refreshMOpts(); } // movil: tira arriba y boton de acordes en cuanto llegan
  }

  async toggle() { await this.p.toggle(); this.refreshPlay(); }

  private refreshPlay() {
    this.playBtn.innerHTML = this.p.playing ? PAUSE_SVG : PLAY_SVG;
    this.playBtn.setAttribute('aria-label', t(this.p.playing ? 'web_pause' : 'web_play'));
    this.hooks.onPlayState(this.p.playing);
  }

  private refreshActs() {
    this.repeatVal.textContent = t(['web_repeat_off', 'web_repeat_all', 'web_repeat_one'][this.p.repeat]);
    this.pitchVal.textContent = this.p.pitch > 0 ? `+${this.p.pitch}` : String(this.p.pitch);
    const speed = ['0.5×', '1×', '2×'][this.p.metroSpeed];
    this.metroVal.textContent = this.p.metroOn ? (this.p.metroSpeed === 0 ? `${speed} ${this.p.metroHalfB ? 'B' : 'A'}` : speed) : t('fx_off');
    this.tempoVal.textContent = this.p.targetBpm ? `${this.p.targetBpm} BPM` : `${this.p.tempoMult.toFixed(2)}×`;
    this.refreshMOpts();
  }

  private loop = () => {
    const end = this.p.checkEnd();
    if (end === 'next') this.hooks.onEnded(end);
    else if (end === 'stopped') this.refreshPlay();
    const pos = this.p.positionMs;
    if (!this.seeking) this.posEl.textContent = fmtTime(pos);
    if (!this.seeking) setSlider(this.seekEl, this.p.durationMs ? Math.round(pos / this.p.durationMs * 1000) : 0);
    if (this.view === 'lyrics') this.lyrics.tick((pos + LYRICS_CLOCK_OFFSET_MS) / 1000);
    if (this.beats) {
      const b = currentBeat(this.beats.cells, pos / 1000);
      if (b !== this.beat) {
        const forward = b === this.beat + 1; // pulso solo al avanzar beat a beat (no en seeks)
        this.beat = b;
        if (forward && b >= 0 && this.p.playing) this.hooks.onBeat(this.beats.cells[b].pos, this.beats.beatsPerBar, this.p.bpm ? this.p.bpm * this.p.tempoMult : null, this.beats.cells[b].time);
      }
    }
    if (this.beat !== this.bpmBeat) {
      this.bpmBeat = this.beat;
      const n = windowBpm(this.p.beats, this.beat);
      if (n !== null) this.mBpm.textContent = `${t('tv_bpm')} ${n}`;
    }
    if (this.chords) {
      const b = this.beat;
      if (b !== this.chordBeat) {
        this.chordBeat = b;
        if (this.chordGrid) this.chords.grid.setBeat(b);
        if (!this.chordGrid || this.stripSlot.firstChild) this.chords.strip.setBeat(b);
        if (!this.chordGrid) this.chords.diagrams.setBeat(b);
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  /** Tour del reproductor (maybeStartPlayerTour): primera cancion abierta, solo sobre la vista Mezcla.
   *  Si se abre en otra vista, espera a que se elija Mezcla. */
  maybeTour() {
    this.tourWanted = true;
    if (this.dead || this.view !== 'mix' || !this.p.stems.length) return;
    if (startTour('player', this.tourSteps())) this.tourWanted = false;
  }

  private tourSteps(): Step[] {
    const row = this.viewBox.querySelector('.stem');
    const icon = (b: Element | null | undefined) => b?.querySelector('img, svg, .mi')?.cloneNode(true) ?? null;
    const legend = (pairs: [Element | null | undefined, string][]) => pairs.flatMap(([b, label]): LegendRow[] => {
      const ic = icon(b);
      return ic && b?.checkVisibility() ? [{ icon: ic, label }] : [];
    });
    const tab = (v: View) => this.tabs.get(v);
    const act = (i: number) => this.acts.children[i];
    return [
      { target: views(this.seg), title: t('web_coach_views_title'), corner: 20, legend: legend([[tab('lyrics'), t('coach_pl_bar_lyrics')],
        [tab('chords'), t('coach_pl_bar_chords')], [tab('mix'), t('web_coach_view_mix')], [tab('3d'), t('coach_pl_bar_3d')]]) },
      // Movil: textos de Android (icono = Solo / Silenciar, ⋮ = opciones, fila de 6 botones); views() solo une lo visible
      { target: views(row?.querySelector('.btn-ic'), row?.querySelector('.solo')), title: t('coach_pl_icon_title'), body: t(this.mobile ? 'coach_pl_icon_body' : 'web_coach_icon_body'), corner: 14 },
      { target: views(row?.querySelector('.sl'), row?.querySelector('.rs')), title: t('coach_pl_volume_title'), body: t('coach_pl_volume_body'), corner: 14 },
      { target: views(row?.querySelector('.nm'), row?.querySelector('.mmore')), title: t('coach_pl_options_title'), body: t(this.mobile ? 'coach_pl_options_body' : 'web_coach_options_body'), corner: 10 },
      this.mobile ? { target: views(this.moptsEl), title: t('coach_pl_bar_title'), corner: 24, legend: legend(([['repeat', 'coach_pl_bar_repeat'], ['lyrics', 'coach_pl_bar_lyrics'], ['pitch', 'coach_pl_bar_pitch'],
        ['metro', 'coach_pl_bar_metronome'], ['chords', 'coach_pl_bar_chords'], ['3d', 'coach_pl_bar_3d']] as [MOpt, string][]).map(([k, key]) => [this.mOpts.get(k), t(key)])) } :
      { target: views(this.acts), title: t('coach_pl_bar_title'), corner: 24, legend: legend([[act(0), t('coach_pl_bar_repeat')], [act(1), t('coach_pl_bar_pitch')],
        ...(this.p.hasMetronome ? [[act(2), t('web_coach_bar_metronome')] as [Element, string]] : []), [act(this.acts.children.length - 1), t('web_coach_bar_tempo')]]) },
      { target: views(this.menuBtn), title: t('coach_pl_menu_title'), body: t('web_coach_menu_body') },
    ];
  }

  /** La vista saliente sigue en pantalla, fundiendose, mientras entra la nueva (transitionInto* de Android). */
  private viewOut() {
    const kids = [...this.viewBox.childNodes];
    if (!kids.length || reducedMotion()) return;
    const b = this.viewBox.getBoundingClientRect();
    const g = h('div', { class: `${this.viewBox.className} vghost`, attrs: { 'aria-hidden': 'true', inert: '' } }, ...kids);
    Object.assign(g.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    this.main.append(g);
    g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(18px)' }], { duration: 200, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).onfinish = () => g.remove();
  }

  private viewIn() {
    if (reducedMotion()) return;
    this.viewBox.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 120, easing: 'cubic-bezier(0,0,.2,1)', fill: 'backwards' });
  }

  /** Al revelar la cancion: los sliders suben desde 0 en cascada, 150 ms entre filas (como Android). */
  revealStems() {
    if (!this.cascadeOn) return;
    this.cascadeOn = false;
    if (this.view !== 'mix' || reducedMotion()) return;
    const rows = [...this.viewBox.querySelectorAll<HTMLInputElement>('.stem > .sl')];
    rows.forEach((r, i) => { const to = +r.value; setSlider(r, 0); setTimeout(() => { if (r.isConnected) animateSlider(r, to); }, 150 * i); });
  }

  private setView(v: View) {
    const changed = v !== this.view;
    if (v !== 'lyrics') this.setFold(false);
    if (changed) this.viewOut();
    this.view = v;
    if (!this.mobile) try { localStorage.setItem(VIEW_PREF, v); } catch { /* sin storage */ }
    for (const [k, b] of this.tabs) b.setAttribute('aria-selected', String(k === v));
    this.hooks.onView?.(v);
    this.renderView();
    if (changed) this.viewIn();
    if (v === 'mix' && this.tourWanted) setTimeout(() => this.maybeTour(), 400); // tras las filas
  }

  /** setLyricsControlsFolded: fuera quedan BPM, barra, tiempos y la fila de opciones; el transporte, en una pildora. */
  private setFold(on: boolean) {
    if (on === this.folded) return;
    if (on && !(this.mobile && this.view === 'lyrics' && this.lyricsContent)) return;
    const app = this.bar.closest('.app') as HTMLElement | null;
    if (!app) return;
    const above = [this.mBpm, this.bar.querySelector<HTMLElement>('.seek')!, this.moptsEl];
    if (on && getComputedStyle(app).getPropertyValue('--fold').trim() === '0') {
      // Medidas desplegado (una vez maquetado): alturas que se encogen y la pildora alrededor de los 5 botones
      const [hb, hs, ho] = above.map((e) => e.offsetHeight);
      const row = this.bar.querySelector<HTMLElement>('.btns')!, rb = row.getBoundingClientRect();
      const kids = [...row.children] as HTMLElement[], first = kids[0].getBoundingClientRect(), last = kids[kids.length - 1].getBoundingClientRect();
      const play = this.playBtn.getBoundingClientRect();
      Object.entries({ '--hb': hb, '--hs': hs, '--ho': ho, '--pl': first.left - rb.left - 10, '--pr': rb.right - last.right - 10, '--pt': play.top - rb.top, '--ph': play.height })
        .forEach(([k, v]) => this.bar.style.setProperty(k, `${v}px`));
      this.bar.classList.add('fm');
    }
    this.folded = on;
    this.foldAccum = 0;
    app.classList.toggle('lyfold', on);
    above.forEach((e) => (e.inert = on));
  }

  private renderView() {
    this.renderBody();
    this.placeStrip();
    this.refreshMOpts();
  }

  private renderBody() {
    this.viewBox.className = this.view === 'lyrics' ? 'view lyr' : 'view';
    if (this.view === 'lyrics') { this.viewBox.replaceChildren(this.lyrics.el); return; }
    if (this.view !== '3d') this.scene3d?.watchAccent(this.main); // sigue al acento aunque no se vea
    if (this.view === 'chords' && this.chords) {
      const meta = h('p', { class: 'chmeta', textContent: `${this.p.bpm ? Math.round(this.p.bpm) + ' BPM · ' : ''}${this.chords.beatsPerBar}/4` });
      // Pildora Diagramas | Cuadricula: la cuadricula sustituye a la tira y a los diagramas
      const pill = h('div', { class: 'seg chpill', attrs: { role: 'radiogroup', 'aria-label': t('web_view_chords') } });
      [t('chord_view_diagrams'), t('chord_view_grid')].forEach((l, i) => {
        const b = h('button', { textContent: l, attrs: { role: 'radio', 'aria-checked': String(this.chordGrid === (i === 1)) } });
        b.onclick = () => { if (this.chordGrid === (i === 1)) return; this.chordGrid = i === 1; saveChordView(this.chordGrid); this.renderView(); };
        pill.append(b);
      });
      // Movil: la tira va arriba (placeStrip), aqui solo diagramas o cuadricula
      const body = this.chordGrid ? [this.chords.grid.el] : this.mobile ? [this.chords.diagrams.el] : [this.chords.strip.el, this.chords.diagrams.el];
      for (const el of body) { el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap'); } // fundido + desliz
      this.viewBox.className = `view chv${this.chordGrid ? ' grid' : ''}`;
      this.viewBox.replaceChildren(h('div', { class: 'chhead' }, pill, meta), ...body);
      this.chordBeat = -2; // repintar al volver
      this.chords.strip.invalidate(); this.chords.grid.invalidate();
      return;
    }
    if (this.view === '3d') { this.show3D(); return; }
    if (this.view !== 'mix') { this.viewBox.replaceChildren(h('p', { class: 'soon', textContent: t('web_view_soon') })); return; }
    // En 3D no cuentan volumen ni balance: mezcla bloqueada (setEditingLocked)
    const mix = h('div', { class: `mix${this.p.audio3d ? ' locked' : ''}` });
    const v2 = this.p.hasVocals2;
    const drums = this.p.stems.filter((s) => isDrumPart(s.stem));
    for (const s of this.p.stems.filter((x) => !isDrumPart(x.stem))) mix.append(this.stemRow(s, v2));
    if (drums.length) {
      const body = h('div', { hidden: !this.drumsOpen }, ...drums.map((s) => this.stemRow(s, v2)));
      const head = h('button', { class: 'group', attrs: { 'aria-expanded': String(this.drumsOpen) } },
        img(icDrumset, '', ''), `${t('title_drumset')} · ${drums.length}`, h('span', { class: 'chev' }, icon('chev', 14)));
      head.onclick = () => { this.drumsOpen = !this.drumsOpen; body.hidden = !this.drumsOpen; head.setAttribute('aria-expanded', String(this.drumsOpen)); };
      // Movil: el icono de la cabecera abre el menu solo con Solo (todas las piezas a la vez); el resto pliega
      const gIcon = h('button', { class: 'gsolo', attrs: { 'aria-label': `${t('stem_menu_solo')}: ${t('title_drumset')}` } }, maskIcon(icDrumset, 'mi s'));
      gIcon.onclick = () => this.drumSoloMenu(gIcon, drums);
      mix.append(h('div', { class: 'ghead' }, gIcon, head), body);
    }
    const sel = this.p.stems.find((s) => s.stem === this.fxStem) ?? this.p.stems[0];
    this.fxStem = sel?.stem ?? null;
    mix.querySelectorAll<HTMLElement>('.stem').forEach((r) => r.classList.toggle('sel', r.dataset.stem === this.fxStem));
    if (this.p.audio3d) mix.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.stem input, .stem .s, .stem .rs').forEach((c) => (c.disabled = true));
    const note = this.p.audio3d ? h('p', { class: 'note3d', textContent: t('web_3d_locked') }) : '';
    this.viewBox.replaceChildren(note, h('div', { class: 'mixwrap' }, mix, sel ? this.fxPanel(sel, v2) : ''));
    this.refreshSolo();
  }

  /** Vista 3D: three.js se carga aparte, la primera vez que hace falta. */
  private show3D() {
    this.viewBox.className = 'view v3d';
    if (this.scene3d) { this.viewBox.replaceChildren(this.scene3d.el); this.scene3d.watchAccent(this.main); return; }
    this.viewBox.replaceChildren(sceneSpinner(t('web_3d_loading')).el);
    if (this.scene3dLoading) return;
    this.scene3dLoading = true;
    const hooks = { onEnabled: (on: boolean) => this.tabs.get('3d')!.classList.toggle('on3d', on) };
    // Rendimiento: escena (three.js, chunk aparte) o vista plana 2D (sin three.js)
    const make: Promise<Scene3D | Flat3D> = this.hooks.scene3d()
      ? import('./scene3d.ts').then(({ Scene3D }) => new Scene3D(this.p, this.card, hooks))
      : import('./flat3d.ts').then(({ Flat3D }) => new Flat3D(this.p, hooks));
    void make.then((v) => {
      this.scene3dLoading = false;
      if (this.dead) { v.destroy(); return; } // cancion cerrada mientras cargaba
      this.scene3d = v;
      if (this.view === '3d') this.show3D();
    });
  }

  /** Panel derecho (mix.html): balance, filtro, eco con division, reverb con sala (player_modal_sheet_dialog). */
  private fxPanel(s: StemState, v2: boolean, redo?: () => void): HTMLElement {
    const p = this.p, name = t(titleKey(s.stem, v2)) || s.stem;
    const val = () => h('span', { class: 'fxv' });
    const panV = val(), filV = val(), echoV = val(), revV = val();
    const pan = slider(-100, 100, 1, s.pan, t('pan_title'));
    const fil = slider(-100, 100, 1, Math.round(s.fx.filter * 100), t('fx_filter'));
    const echo = slider(0, 100, 1, Math.round(s.fx.echo * 100), t('fx_echo'));
    const rev = slider(0, 100, 1, Math.round(s.fx.reverb * 100), t('fx_reverb'));
    fil.classList.add('bi'); pan.classList.add('bi');
    const hz = (a: number) => { const f = filterCutoffHz(a); return f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`; };
    const choose = (labels: string[], cur: number, on: (i: number) => void, label: string) => {
      const g = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': label } });
      labels.forEach((l, i) => { const b = h('button', { textContent: l, attrs: { role: 'radio', 'aria-checked': String(i === cur) } });
        b.onclick = () => { g.querySelectorAll('button').forEach((x, k) => x.setAttribute('aria-checked', String(k === i))); on(i); }; g.append(b); });
      return g;
    };
    // Sin BPM las divisiones se muestran en ms a 120 BPM (StemFx.echoLabels)
    const divLabels = p.bpm ? ECHO_LABELS : ECHO_BEATS.map((b) => `${Math.round(60000 / FX_FALLBACK_BPM * b)} ms`);
    const sync = () => {
      panV.textContent = s.pan === 0 ? t('web_center') : s.pan < 0 ? `${t('pan_l')} ${-s.pan}` : `${t('pan_r')} ${s.pan}`;
      filV.textContent = s.fx.filter === 0 ? t('fx_off') : t(s.fx.filter < 0 ? 'fx_filter_lowpass' : 'fx_filter_highpass', hz(s.fx.filter));
      echoV.textContent = s.fx.echo > 0 ? `${Math.round(s.fx.echo * 100)} %` : t('fx_off');
      revV.textContent = s.fx.reverb > 0 ? `${Math.round(s.fx.reverb * 100)} %` : t('fx_off');
      clear.disabled = !fxActive(s.fx);
      this.viewBox.querySelector(`.stem[data-stem="${s.stem}"]`)?.classList.toggle('fx', fxActive(s.fx));
    };
    pan.addEventListener('input', () => { p.setPan(s.stem, +pan.value); sync(); });
    pan.ondblclick = () => { p.setPan(s.stem, 0); animateSlider(pan, 0); sync(); };
    fil.addEventListener('input', () => { p.setFx(s.stem, { filter: +fil.value / 100 }); sync(); });
    echo.addEventListener('input', () => { p.setFx(s.stem, { echo: +echo.value / 100 }); sync(); });
    rev.addEventListener('input', () => { p.setFx(s.stem, { reverb: +rev.value / 100 }); sync(); });
    const clear = h('button', { class: 'btn ghost', textContent: t('fx_clear') });
    clear.onclick = () => { const z = newFx(); p.setFx(s.stem, { filter: 0, echo: 0, reverb: 0, echoDivision: z.echoDivision, room: z.room }); sync(); for (const x of [fil, echo, rev]) animateSlider(x, 0); setTimeout(() => { if (clear.isConnected) { this.renderView(); redo?.(); } }, reducedMotion() ? 0 : 320); };
    // Exportar esta pista (ic_export del bottom sheet de Android; "Exportar" en mix.html)
    const exp = h('button', { class: 'expb', attrs: { 'aria-label': t('export_stem_button_desc') } });
    exp.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-5-5 5 5 5-5M5 19h14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
    exp.append(t('drawer_item_export'));
    exp.hidden = !this.hooks.onExport;
    exp.onclick = () => this.hooks.onExport?.(s.stem);
    const sec = (title: string, v: HTMLElement, ...kids: HTMLElement[]) => h('div', { class: 'fxs' }, h('div', { class: 'fxh' }, h('b', { textContent: title }), v), ...kids);
    const lr = (a: string, el: HTMLElement, b: string) => h('div', { class: 'lr' }, h('small', { textContent: a }), el, h('small', { textContent: b }));
    const panel = h('aside', { class: 'fxpanel', attrs: { 'aria-label': `${t('fx_title')}: ${name}` } },
      h('div', { class: 'fxtop' }, img(iconOf(s.stem, v2), 's', ''), h('b', { textContent: name }), exp),
      sec(t('pan_title'), panV, lr(t('pan_l'), pan, t('pan_r'))),
      sec(t('fx_filter'), filV, lr('LP', fil, 'HP')),
      sec(t('fx_echo'), echoV, echo, choose(divLabels, s.fx.echoDivision, (i) => { p.setFx(s.stem, { echoDivision: i }); }, t('fx_echo'))),
      sec(t('fx_reverb'), revV, rev, choose([t('fx_room_small'), t('fx_room_medium'), t('fx_room_large')], s.fx.room, (i) => { p.setFx(s.stem, { room: i }); }, t('fx_reverb'))),
      clear);
    sync();
    return panel;
  }

  private stemRow(s: StemState, v2: boolean): HTMLElement {
    const name = t(titleKey(s.stem, v2)) || s.stem;
    const val = h('span', { class: 'val', textContent: String(s.volume) });
    const r = slider(0, 100, 1, s.volume, name);
    const row = h('div', { class: `stem${s.volume === 0 ? ' muted' : ''}${fxActive(s.fx) ? ' fx' : ''}` });
    row.dataset.stem = s.stem;
    const mark = () => { val.textContent = String(s.volume); row.classList.toggle('muted', s.volume === 0); };
    const sync = () => { mark(); setSlider(r, s.volume); };
    const glide = () => { mark(); animateSlider(r, s.volume); }; // el motor ya tiene el valor final
    r.addEventListener('input', () => { this.p.setVolume(s.stem, +r.value); sync(); });
    // Icono = mute/unmute (slider a 0)
    const icon = h('button', { class: 's btn-ic', attrs: { 'aria-label': `${t('cd_stem_mute')}: ${name}` } }, img(iconOf(s.stem, v2), 's', ''), maskIcon(iconOf(s.stem, v2), 'mi s'));
    icon.onclick = () => { if (this.mobile) this.stemMenu(icon, s, glide); else { this.p.toggleMute(s.stem); glide(); } };
    const solo = h('button', { class: 'solo', textContent: 'S', attrs: { 'aria-pressed': String(s.solo), 'aria-label': `${t('web_solo')}: ${name}` } });
    solo.onclick = () => { this.p.toggleSolo(s.stem); this.refreshSolo(); };
    const rs = h('button', { class: 'rs', attrs: { 'aria-label': `${t('cd_restore_volume')}: ${name}` }, onclick: () => { this.p.setVolume(s.stem, DEFAULT_VOLUME); glide(); } }, img(icRestore, '', ''));
    // Nombre = elegir el stem del panel de FX
    const nm = h('button', { class: 'nm', textContent: name, attrs: { 'aria-label': `${t('cd_stem_options')}: ${name}` } });
    nm.onclick = () => { this.fxStem = s.stem; this.renderView(); };
    const more = h('button', { class: 'mmore', attrs: { 'aria-label': `${t('cd_stem_options')}: ${name}` }, onclick: () => this.stemSheet(s) });
    more.innerHTML = MORE_SVG;
    row.append(icon, nm, r, val, solo, rs, more);
    return row;
  }

  private popover(anchor: HTMLButtonElement, host: HTMLElement, build: (pop: HTMLElement) => void) {
    if (anchor.getAttribute('aria-expanded') === 'true') return;
    host.querySelector('.pop')?.remove();
    const pop = h('div', { class: 'pop', attrs: { role: 'dialog' } });
    build(pop);
    anchor.setAttribute('aria-expanded', 'true');
    host.append(pop);
    dismissable(pop, () => anchor.setAttribute('aria-expanded', 'false'), [anchor]);
    pop.querySelector('input')?.focus();
  }

  private pitchPop(anchor: HTMLButtonElement, host: HTMLElement) {
    this.popover(anchor, host, (pop) => {
      const show = h('b');
      const r = slider(PITCH_MIN, PITCH_MAX, 1, this.p.pitch, t('cd_pitch'));
      const apply = (v: number) => { const before = this.p.pitch; this.p.setPitch(v); if (this.p.pitch !== before) this.hooks.onPitch?.(); setSlider(r, this.p.pitch); show.textContent = this.pitchVal.textContent = this.p.pitch > 0 ? `+${this.p.pitch}` : String(this.p.pitch); };
      r.addEventListener('input', () => apply(+r.value));
      apply(this.p.pitch);
      pop.append(h('div', { class: 'hd' }, h('span', { textContent: t('cd_pitch') }), show), r,
        h('div', { class: 'row' }, h('button', { textContent: '−1', onclick: () => apply(this.p.pitch - 1) }),
          h('button', { textContent: '0', onclick: () => apply(0) }), h('button', { textContent: '+1', onclick: () => apply(this.p.pitch + 1) })));
    });
  }

  /** Menu del reproductor (drawer de Android): por ahora, el fondo animado. */
  private menuPop(anchor: HTMLButtonElement, host: HTMLElement) {
    this.popover(anchor, host, (pop) => {
      pop.classList.add('menu-pop');
      const neb = this.hooks.nebula;
      const sw = h('button', { class: 'switch', attrs: { role: 'switch', 'aria-checked': String(neb.get()), 'aria-label': t('drawer_switch_nebula') } });
      sw.onclick = () => { neb.set(!neb.get()); sw.setAttribute('aria-checked', String(neb.get())); };
      pop.append(h('div', { class: 'hd' }, h('span', { textContent: t('drawer_switch_nebula') }), sw));
      // Sonido en downbeat + sonido (solo suena con el metronomo encendido, como Android)
      const db = this.hooks.downbeat;
      const dsw = h('button', { class: 'switch', attrs: { role: 'switch', 'aria-checked': String(db.get().on), 'aria-label': t('drawer_switch_downbeat') } });
      const pick = h('button', { class: 'menuitem dbpick', attrs: { 'aria-expanded': 'false' } });
      const list = h('div', { class: 'dblist', hidden: true, attrs: { role: 'radiogroup', 'aria-label': t('downbeat_sound_dialog_title') } });
      const syncDb = () => {
        const { on, type } = db.get();
        dsw.setAttribute('aria-checked', String(on));
        pick.hidden = !on; if (!on) { list.hidden = true; pick.setAttribute('aria-expanded', 'false'); }
        pick.replaceChildren(h('span', { textContent: t('drawer_item_downbeat_sound') }), h('small', { textContent: t(`downbeat_sound_${DOWNBEAT_SOUNDS[type]}`) }));
        list.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-checked', String(i === type)));
      };
      DOWNBEAT_SOUNDS.forEach((id, i) => list.append(h('button', { textContent: t(`downbeat_sound_${id}`), attrs: { role: 'radio' },
        onclick: () => { db.setType(i); list.hidden = true; pick.setAttribute('aria-expanded', 'false'); syncDb(); } })));
      dsw.onclick = () => { db.setOn(!db.get().on); syncDb(); };
      pick.onclick = () => { list.hidden = !list.hidden; pick.setAttribute('aria-expanded', String(!list.hidden)); };
      pop.append(h('div', { class: 'hd' }, h('span', { textContent: t('drawer_switch_downbeat') }), dsw), pick, list);
      syncDb();
      if (this.hooks.onReprocess) {
        const rp = h('button', { class: 'menuitem', textContent: t('drawer_item_reprocess') });
        rp.onclick = () => { pop.remove(); anchor.setAttribute('aria-expanded', 'false'); this.hooks.onReprocess!(); };
        pop.append(rp);
      }
      if (this.hooks.onExport) {
        const ex = h('button', { class: 'menuitem', textContent: t('drawer_item_export') });
        ex.onclick = () => { pop.remove(); anchor.setAttribute('aria-expanded', 'false'); this.hooks.onExport!(null); };
        pop.append(ex);
      }
      if (this.hooks.hasBasicChords) {
        const g = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': t('chords_dialog_title') } });
        [t('chords_basic'), t('chords_advanced')].forEach((label, i) => {
          const b = h('button', { textContent: label, attrs: { role: 'radio', 'aria-checked': String((i === 0) === this.p.chordsBasic) } });
          b.onclick = () => { g.querySelectorAll('button').forEach((x, k) => x.setAttribute('aria-checked', String(k === i))); this.hooks.onChordsBasic(i === 0); };
          g.append(b);
        });
        pop.append(h('div', { class: 'hd' }, h('span', { textContent: t('chords_dialog_title') })), g);
      }
    });
  }

  /** Metronomo: encendido, 0.5x (A/B) / 1x / 2x y volumen (metronome_modal_sheet_dialog). */
  private metroPop(anchor: HTMLButtonElement, host: HTMLElement) {
    this.popover(anchor, host, (pop) => {
      const p = this.p;
      const sw = h('button', { class: 'switch', attrs: { role: 'switch', 'aria-checked': String(p.metroOn), 'aria-label': t('tv_metronome_title') } });
      const speeds = h('div', { class: 'seg', attrs: { role: 'radiogroup' } });
      const ab = h('div', { class: 'seg', attrs: { role: 'radiogroup' } });
      const vol = slider(0, 100, 1, p.metroVolume, t('tv_metronome_volume'));
      const volV = h('span', { class: 'val' });
      const sync = () => {
        sw.setAttribute('aria-checked', String(p.metroOn));
        speeds.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-checked', String(i === p.metroSpeed)));
        ab.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-checked', String(i === Number(p.metroHalfB))));
        ab.hidden = p.metroSpeed !== 0; // A/B solo en 0.5x
        volV.textContent = String(p.metroVolume);
        this.refreshActs();
      };
      sw.onclick = () => { p.setMetronome(!p.metroOn); sync(); };
      ['0.5×', '1×', '2×'].forEach((label, i) => speeds.append(h('button', { textContent: label, attrs: { role: 'radio' },
        onclick: () => { p.setMetronome(true, i as MetroSpeed); sync(); } })));
      [t('metronome_half_variant_a'), t('metronome_half_variant_b')].forEach((label, i) => ab.append(h('button', { textContent: label, attrs: { role: 'radio' },
        onclick: () => { p.setHalfVariantB(i === 1); sync(); } })));
      vol.addEventListener('input', () => { p.setMetronome(p.metroOn, p.metroSpeed, +vol.value); sync(); });
      // Balance (s_metronomePan): doble clic = centro, como el de los stems
      const pan = slider(-100, 100, 1, p.metroPan, t('pan_title'));
      pan.classList.add('bi', 'mpan');
      const panV = h('span', { class: 'val' });
      const syncPan = () => { panV.textContent = p.metroPan === 0 ? t('web_center') : p.metroPan < 0 ? `${t('pan_l')} ${-p.metroPan}` : `${t('pan_r')} ${p.metroPan}`; };
      pan.addEventListener('input', () => { p.setMetroPan(+pan.value); syncPan(); });
      pan.ondblclick = () => { p.setMetroPan(0); animateSlider(pan, 0); syncPan(); };
      syncPan();
      pop.append(h('div', { class: 'hd' }, h('span', { textContent: t('tv_metronome_title') }), sw), speeds, ab,
        h('div', { class: 'hd' }, h('span', { textContent: t('tv_metronome_volume') }), volV), vol,
        h('div', { class: 'hd' }, h('span', { textContent: t('pan_title') }), panV), pan);
      sync();
    });
  }

  private tempoPop(anchor: HTMLButtonElement, host: HTMLElement) {
    this.popover(anchor, host, (pop) => {
      const show = h('b');
      const bpm = this.p.bpm;
      const r = bpm ? slider(BPM_MIN, BPM_MAX, 1, this.p.targetBpm!, t('web_tempo')) : slider(MULT_MIN, MULT_MAX, MULT_STEP, this.p.tempoMult, t('web_tempo'));
      const apply = (v: number) => {
        if (bpm) this.p.setTempoBpm(v); else this.p.setTempoMult(v);
        this.refreshActs();
        setSlider(r, bpm ? this.p.targetBpm! : this.p.tempoMult);
        show.textContent = this.tempoVal.textContent;
      };
      r.addEventListener('input', () => apply(+r.value));
      apply(bpm ? this.p.targetBpm! : this.p.tempoMult);
      const d = bpm ? 1 : MULT_STEP;
      const cur = () => (bpm ? this.p.targetBpm! : this.p.tempoMult);
      pop.append(h('div', { class: 'hd' }, h('span', { textContent: t('web_tempo') }), show), r,
        h('div', { class: 'row' }, h('button', { attrs: { 'aria-label': `−${bpm ? 1 : MULT_STEP}` }, onclick: () => apply(cur() - d) }, icon('minus')),
          h('button', { textContent: bpm ? `${Math.round(bpm)}` : '1.00×', onclick: () => apply(bpm ? bpm : 1) }),
          h('button', { attrs: { 'aria-label': `+${bpm ? 1 : MULT_STEP}` }, onclick: () => apply(cur() + d) }, icon('plus'))));
    });
  }
}

