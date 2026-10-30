// Reproductor de escritorio (maquetas player.html y mix.html).
import type { LibraryEntry } from '../api/client.ts';
import { t } from '../i18n/i18n.ts';
import { BPM_MAX, BPM_MIN, ECHO_BEATS, ECHO_LABELS, FX_FALLBACK_BPM, MULT_MAX, MULT_MIN, MULT_STEP, PITCH_MAX, PITCH_MIN, filterCutoffHz, fxActive, newFx, type MetroSpeed, type Player, type StemState } from '../player/player.ts';
import { DEFAULT_VOLUME, isDrumPart, titleKey } from '../player/stems.ts';
import { iconOf } from './stemIcons.ts';
import { LyricsView, type LyricsState } from './lyricsView.ts';
import { LYRICS_CLOCK_OFFSET_MS } from '../player/lyrics.ts';
import { currentBeat, nextChord, soundingChord, type BeatCell } from '../player/chords.ts';
import { ChordStrip } from './chordStrip.ts';
import { ChordDiagrams } from './chordDiagrams.ts';
import { dismissable, fmtTime, h, img, setSlider, slider } from './dom.ts';
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
import type { Scene3D } from './scene3d.ts';

export type View = 'lyrics' | 'chords' | 'mix' | '3d';

export interface PlayerHooks {
  onPrev(): void; onNext(): void; onEnded(r: 'next'): void; onPlayState(playing: boolean): void;
  /** Beat nuevo: posicion en el compas, compas y tempo oido (BPM x multiplicador). */
  onBeat(pos: number, beatsPerBar: number, heardBpm: number | null): void;
  nebula: { get(): boolean; set(on: boolean): void };
  /** Formato de acorde con los ajustes (latino, bemoles, transporte con el tono). */
  formatChord(c: string | null): string;
  /** Transporte (trasponer con el tono), cifrado latino y bemoles: para diagramas y nombres de nota. */
  chordNotation(): { shift: number; latin: boolean; flat: boolean };
  /** Hay chords_basic.txt: se ofrece Basicos / Avanzado. */
  hasBasicChords: boolean;
  onChordsBasic(basic: boolean): void;
  onPitch?(): void;
  /** Vista elegida (la nebulosa oculta sus blobs en 3D). */
  onView?(v: View): void;
  /** Reprocesar en el server (solo canciones del server). */
  onReprocess?(): void;
}

const MIX_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v16M12 4v16M18 4v16" stroke="currentColor" stroke-width="1.5"/><rect x="3.5" y="13" width="5" height="3" rx="1" fill="currentColor"/><rect x="9.5" y="7" width="5" height="3" rx="1" fill="currentColor"/><rect x="15.5" y="11" width="5" height="3" rx="1" fill="currentColor"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="#000"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="#000"/></svg>';
const SPEED_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 15a8 8 0 1 1 16 0" stroke="#fff" stroke-width="1.6" fill="none"/><path d="M12 15l4-5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>';
const VIEW_PREF = 'fision.view'; // vista recordada (comodidad por navegador)
function loadView(): View { try { const v = localStorage.getItem(VIEW_PREF); return v === 'lyrics' || v === 'chords' || v === '3d' ? v : 'mix'; } catch { return 'mix'; } }

const withSvg = (el: HTMLElement, markup: string) => { el.insertAdjacentHTML('afterbegin', markup); return el; };

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
  private chords: { cells: BeatCell[]; beatsPerBar: number; strip: ChordStrip; diagrams: ChordDiagrams } | null = null;
  private beat = -2;
  private chordBeat = -2;
  private nowCh = h('b', { class: 'ch' });
  private nextCh = h('b', { class: 'ch nx' });
  private nowNext = h('span', { class: 'now-ch', hidden: true });
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
  private scene3d: Scene3D | null = null; // se construye la primera vez y vive con la cancion
  private scene3dLoading = false;
  private dead = false;
  private card: { cover: string | null; title: string; artist: string };

  constructor(p: Player, song: LibraryEntry, cover: string | null, hooks: PlayerHooks) {
    this.p = p; this.hooks = hooks;
    this.card = { cover, title: song.title || song.filename, artist: song.artist ?? '' };
    this.lyrics = new LyricsView({ kind: 'loading' }, (sec) => p.seek(sec * 1000));
    const top = h('div', { class: 'top' },
      cover ? img(cover, 'cover', t('cd_cover')) : h('span', { class: 'cover' }),
      h('span', { class: 't' }, h('b', { textContent: song.title || song.filename }), h('span', { textContent: song.artist })),
      h('span', { class: 'sp' }));
    const menuBtn = h('button', { class: 'ib', attrs: { 'aria-label': t('web_menu'), 'aria-haspopup': 'dialog' } }, img(icMenu, '', ''));
    menuBtn.onclick = () => this.menuPop(menuBtn, top);
    top.append(menuBtn);

    const seg = h('div', { class: 'seg2', attrs: { role: 'tablist' } });
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
    this.nowNext.append(h('small', { textContent: t('web_now') }), this.nowCh, h('small', { textContent: t('web_next_chord') }), this.nextCh);
    this.main = h('section', { class: 'main' }, top, h('div', { class: 'vbar' }, seg, h('span', { class: 'sp' }), this.nowNext), this.viewBox);

    // --- barra inferior ---
    this.seekEl = slider(0, 1000, 1, 0, t('web_position'));
    this.seekEl.onpointerdown = () => (this.seeking = true);
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
    const acts = h('div', { class: 'acts' },
      act(icRepeat, '', t('web_repeat'), this.repeatVal, () => { p.cycleRepeat(); this.refreshActs(); }),
      act(icPitch, '', t('cd_pitch'), this.pitchVal, (b) => this.pitchPop(b, acts)),
      p.hasMetronome ? act(icMetronome, '', t('cd_metronome'), this.metroVal, (b) => this.metroPop(b, acts)) : null,
      act(null, SPEED_SVG, t('web_tempo'), this.tempoVal, (b) => this.tempoPop(b, acts)));
    this.bar = h('div', { class: 'pbar' }, seek, btns, acts);

    this.refreshActs();
    this.refreshPlay();
    this.renderView();
    hooks.onView?.(this.view);
    this.loop();
  }

  destroy() { this.dead = true; cancelAnimationFrame(this.raf); this.scene3d?.destroy(); this.scene3d = null; }

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
    const diagrams = new ChordDiagrams(cells, { notation: () => this.hooks.chordNotation(), format: (c) => this.hooks.formatChord(c),
      seekBeat: (b) => this.p.seek((cells[b]?.time ?? 0) * 1000) });
    this.chords = { cells, beatsPerBar, strip: new ChordStrip(cells, beatsPerBar, (sec) => this.p.seek(sec * 1000), (c) => this.hooks.formatChord(c)), diagrams };
    this.nowNext.hidden = false;
    this.chordBeat = -2;
    if (this.view === 'chords') this.renderView();
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
  }

  private loop = () => {
    const end = this.p.checkEnd();
    if (end === 'next') this.hooks.onEnded(end);
    else if (end === 'stopped') this.refreshPlay();
    const pos = this.p.positionMs;
    this.posEl.textContent = fmtTime(pos);
    if (!this.seeking) setSlider(this.seekEl, this.p.durationMs ? Math.round(pos / this.p.durationMs * 1000) : 0);
    if (this.view === 'lyrics') this.lyrics.tick((pos + LYRICS_CLOCK_OFFSET_MS) / 1000);
    if (this.beats) {
      const b = currentBeat(this.beats.cells, pos / 1000);
      if (b !== this.beat) {
        const forward = b === this.beat + 1; // pulso solo al avanzar beat a beat (no en seeks)
        this.beat = b;
        if (forward && b >= 0 && this.p.playing) this.hooks.onBeat(this.beats.cells[b].pos, this.beats.beatsPerBar, this.p.bpm ? this.p.bpm * this.p.tempoMult : null);
      }
    }
    if (this.chords) {
      const b = this.beat;
      if (b !== this.chordBeat) {
        this.chordBeat = b;
        this.chords.strip.setBeat(b);
        const fmt = (c: string | null) => this.hooks.formatChord(c);
        const now = fmt(soundingChord(this.chords.cells, b)), next = fmt(nextChord(this.chords.cells, b));
        this.nowCh.textContent = now || '–'; this.nextCh.textContent = next || '–';
        this.chords.diagrams.setBeat(b);
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private setView(v: View) {
    this.view = v;
    try { localStorage.setItem(VIEW_PREF, v); } catch { /* sin storage */ }
    for (const [k, b] of this.tabs) b.setAttribute('aria-selected', String(k === v));
    this.hooks.onView?.(v);
    this.renderView();
  }

  private renderView() {
    this.viewBox.className = this.view === 'lyrics' ? 'view lyr' : 'view';
    if (this.view === 'lyrics') { this.viewBox.replaceChildren(this.lyrics.el); return; }
    if (this.view !== '3d') this.scene3d?.watchAccent(this.main); // sigue al acento aunque no se vea
    if (this.view === 'chords' && this.chords) {
      const meta = h('p', { class: 'chmeta', textContent: `${this.p.bpm ? Math.round(this.p.bpm) + ' BPM · ' : ''}${this.chords.beatsPerBar}/4` });
      this.viewBox.className = 'view chv';
      this.viewBox.replaceChildren(meta, this.chords.strip.el, this.chords.diagrams.el);
      this.chordBeat = -2; // repintar la tira al volver
      this.chords.strip.invalidate();
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
        img(icDrumset, '', ''), `${t('title_drumset')} · ${drums.length}`, h('span', { class: 'chev', textContent: '▾', attrs: { 'aria-hidden': 'true' } }));
      head.onclick = () => { this.drumsOpen = !this.drumsOpen; body.hidden = !this.drumsOpen; head.setAttribute('aria-expanded', String(this.drumsOpen)); };
      mix.append(head, body);
    }
    const sel = this.p.stems.find((s) => s.stem === this.fxStem) ?? this.p.stems[0];
    this.fxStem = sel?.stem ?? null;
    mix.querySelectorAll<HTMLElement>('.stem').forEach((r) => r.classList.toggle('sel', r.dataset.stem === this.fxStem));
    if (this.p.audio3d) mix.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.stem input, .stem .s, .stem .rs').forEach((c) => (c.disabled = true));
    const note = this.p.audio3d ? h('p', { class: 'note3d', textContent: t('web_3d_locked') }) : '';
    this.viewBox.replaceChildren(note, h('div', { class: 'mixwrap' }, mix, sel ? this.fxPanel(sel, v2) : ''));
  }

  /** Vista 3D: three.js se carga aparte, la primera vez que hace falta. */
  private show3D() {
    this.viewBox.className = 'view v3d';
    if (this.scene3d) { this.viewBox.replaceChildren(this.scene3d.el); this.scene3d.watchAccent(this.main); return; }
    this.viewBox.replaceChildren(h('div', { class: 'd3load', attrs: { role: 'status', 'aria-label': t('web_3d_loading') } }, h('span', { class: 'spin' })));
    if (this.scene3dLoading) return;
    this.scene3dLoading = true;
    void import('./scene3d.ts').then(({ Scene3D }) => {
      this.scene3dLoading = false;
      if (this.dead) return; // cancion cerrada mientras cargaba
      this.scene3d = new Scene3D(this.p, this.card, { onEnabled: (on) => this.tabs.get('3d')!.classList.toggle('on3d', on) });
      if (this.view === '3d') this.show3D();
    });
  }

  /** Panel derecho (mix.html): balance, filtro, eco con division, reverb con sala (player_modal_sheet_dialog). */
  private fxPanel(s: StemState, v2: boolean): HTMLElement {
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
    pan.ondblclick = () => { p.setPan(s.stem, 0); setSlider(pan, 0); sync(); };
    fil.addEventListener('input', () => { p.setFx(s.stem, { filter: +fil.value / 100 }); sync(); });
    echo.addEventListener('input', () => { p.setFx(s.stem, { echo: +echo.value / 100 }); sync(); });
    rev.addEventListener('input', () => { p.setFx(s.stem, { reverb: +rev.value / 100 }); sync(); });
    const clear = h('button', { class: 'btn ghost', textContent: t('fx_clear') });
    clear.onclick = () => { const z = newFx(); p.setFx(s.stem, { filter: 0, echo: 0, reverb: 0, echoDivision: z.echoDivision, room: z.room }); this.renderView(); };
    const sec = (title: string, v: HTMLElement, ...kids: HTMLElement[]) => h('div', { class: 'fxs' }, h('div', { class: 'fxh' }, h('b', { textContent: title }), v), ...kids);
    const lr = (a: string, el: HTMLElement, b: string) => h('div', { class: 'lr' }, h('small', { textContent: a }), el, h('small', { textContent: b }));
    const panel = h('aside', { class: 'fxpanel', attrs: { 'aria-label': `${t('fx_title')}: ${name}` } },
      h('div', { class: 'fxtop' }, img(iconOf(s.stem, v2), 's', ''), h('b', { textContent: name })),
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
    const sync = () => { val.textContent = String(s.volume); setSlider(r, s.volume); row.classList.toggle('muted', s.volume === 0); };
    r.addEventListener('input', () => { this.p.setVolume(s.stem, +r.value); sync(); });
    // Icono = mute/unmute (slider a 0)
    const icon = h('button', { class: 's btn-ic', attrs: { 'aria-label': `${t('cd_stem_mute')}: ${name}` }, onclick: () => { this.p.toggleMute(s.stem); sync(); } }, img(iconOf(s.stem, v2), 's', ''));
    const solo = h('button', { class: 'solo', textContent: 'S', attrs: { 'aria-pressed': String(s.solo), 'aria-label': `${t('web_solo')}: ${name}` } });
    solo.onclick = () => { this.p.toggleSolo(s.stem); solo.setAttribute('aria-pressed', String(s.solo)); };
    const rs = h('button', { class: 'rs', attrs: { 'aria-label': `${t('cd_restore_volume')}: ${name}` }, onclick: () => this.animateTo(s, DEFAULT_VOLUME, sync) }, img(icRestore, '', ''));
    // Nombre = elegir el stem del panel de FX
    const nm = h('button', { class: 'nm', textContent: name, attrs: { 'aria-label': `${t('cd_stem_options')}: ${name}` } });
    nm.onclick = () => { this.fxStem = s.stem; this.renderView(); };
    row.append(icon, nm, r, val, solo, rs);
    return row;
  }

  /** Restore: anima el slider hasta 75 (~250 ms). */
  private animateTo(s: StemState, target: number, sync: () => void) {
    const from = s.volume, t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 250), e = 1 - (1 - k) * (1 - k);
      this.p.setVolume(s.stem, from + (target - from) * e);
      sync();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
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
      if (this.hooks.onReprocess) {
        const rp = h('button', { class: 'menuitem', textContent: t('drawer_item_reprocess') });
        rp.onclick = () => { pop.remove(); anchor.setAttribute('aria-expanded', 'false'); this.hooks.onReprocess!(); };
        pop.append(rp);
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
      pop.append(h('div', { class: 'hd' }, h('span', { textContent: t('tv_metronome_title') }), sw), speeds, ab,
        h('div', { class: 'hd' }, h('span', { textContent: t('tv_metronome_volume') }), volV), vol);
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
        h('div', { class: 'row' }, h('button', { textContent: '−', onclick: () => apply(cur() - d) }),
          h('button', { textContent: bpm ? `${Math.round(bpm)}` : '1.00×', onclick: () => apply(bpm ? bpm : 1) }),
          h('button', { textContent: '+', onclick: () => apply(cur() + d) })));
    });
  }
}

