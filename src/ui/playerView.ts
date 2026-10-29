// Reproductor de escritorio (maquetas player.html y mix.html).
import type { LibraryEntry } from '../api/client.ts';
import { t } from '../i18n/i18n.ts';
import { BPM_MAX, BPM_MIN, MULT_MAX, MULT_MIN, MULT_STEP, PITCH_MAX, PITCH_MIN, type Player, type StemState } from '../player/player.ts';
import { DEFAULT_VOLUME, isDrumPart, titleKey } from '../player/stems.ts';
import { iconOf } from './stemIcons.ts';
import { dismissable, fmtTime, h, img, setSlider, slider } from './dom.ts';
import icLyrics from '../assets/icons/ic_lyrics.svg';
import icChords from '../assets/icons/ic_chord_carousel.svg';
import icItd from '../assets/icons/ic_itd.png';
import icRepeat from '../assets/icons/ic_repeat.svg';
import icPitch from '../assets/icons/ic_pitch.svg';
import icBack5 from '../assets/icons/ic_seek_back_5.svg';
import icFwd5 from '../assets/icons/ic_seek_forward_5.svg';
import icPrev from '../assets/icons/ic_skip_previous.svg';
import icNext from '../assets/icons/ic_skip_next.svg';
import icRestore from '../assets/icons/ic_restore_stem.svg';
import icDrumset from '../assets/icons/ic_drumset.png';

export type View = 'lyrics' | 'chords' | 'mix' | '3d';

export interface PlayerHooks { onPrev(): void; onNext(): void; onEnded(r: 'next'): void; onPlayState(playing: boolean): void }

const MIX_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v16M12 4v16M18 4v16" stroke="currentColor" stroke-width="1.5"/><rect x="3.5" y="13" width="5" height="3" rx="1" fill="currentColor"/><rect x="9.5" y="7" width="5" height="3" rx="1" fill="currentColor"/><rect x="15.5" y="11" width="5" height="3" rx="1" fill="currentColor"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="#000"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="#000"/></svg>';
const SPEED_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 15a8 8 0 1 1 16 0" stroke="#fff" stroke-width="1.6" fill="none"/><path d="M12 15l4-5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>';
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
  private view: View = 'mix';
  private viewBox = h('div', { class: 'view' });
  private tabs = new Map<View, HTMLButtonElement>();
  private seekEl: HTMLInputElement;
  private posEl = h('span');
  private playBtn: HTMLButtonElement;
  private repeatVal = h('b');
  private pitchVal = h('b');
  private tempoVal = h('b');
  private seeking = false;
  private raf = 0;
  private drumsOpen = true;

  constructor(p: Player, song: LibraryEntry, cover: string | null, hooks: PlayerHooks) {
    this.p = p; this.hooks = hooks;
    const top = h('div', { class: 'top' },
      cover ? img(cover, 'cover', t('cd_cover')) : h('span', { class: 'cover' }),
      h('span', { class: 't' }, h('b', { textContent: song.title || song.filename }), h('span', { textContent: song.artist })));

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
    this.main = h('section', { class: 'main' }, top, h('div', { class: 'vbar' }, seg), this.viewBox);

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
      act(null, SPEED_SVG, t('web_tempo'), this.tempoVal, (b) => this.tempoPop(b, acts)));
    this.bar = h('div', { class: 'pbar' }, seek, btns, acts);

    this.refreshActs();
    this.refreshPlay();
    this.renderView();
    this.loop();
  }

  destroy() { cancelAnimationFrame(this.raf); }

  async toggle() { await this.p.toggle(); this.refreshPlay(); }

  private refreshPlay() {
    this.playBtn.innerHTML = this.p.playing ? PAUSE_SVG : PLAY_SVG;
    this.playBtn.setAttribute('aria-label', t(this.p.playing ? 'web_pause' : 'web_play'));
    this.hooks.onPlayState(this.p.playing);
  }

  private refreshActs() {
    this.repeatVal.textContent = t(['web_repeat_off', 'web_repeat_all', 'web_repeat_one'][this.p.repeat]);
    this.pitchVal.textContent = this.p.pitch > 0 ? `+${this.p.pitch}` : String(this.p.pitch);
    this.tempoVal.textContent = this.p.targetBpm ? `${this.p.targetBpm} BPM` : `${this.p.tempoMult.toFixed(2)}×`;
  }

  private loop = () => {
    const end = this.p.checkEnd();
    if (end === 'next') this.hooks.onEnded(end);
    else if (end === 'stopped') this.refreshPlay();
    const pos = this.p.positionMs;
    this.posEl.textContent = fmtTime(pos);
    if (!this.seeking) setSlider(this.seekEl, this.p.durationMs ? Math.round(pos / this.p.durationMs * 1000) : 0);
    this.raf = requestAnimationFrame(this.loop);
  };

  private setView(v: View) {
    this.view = v;
    for (const [k, b] of this.tabs) b.setAttribute('aria-selected', String(k === v));
    this.renderView();
  }

  private renderView() {
    if (this.view !== 'mix') { this.viewBox.replaceChildren(h('p', { class: 'soon', textContent: t('web_view_soon') })); return; }
    const mix = h('div', { class: 'mix' });
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
    this.viewBox.replaceChildren(mix);
  }

  private stemRow(s: StemState, v2: boolean): HTMLElement {
    const name = t(titleKey(s.stem, v2)) || s.stem;
    const val = h('span', { class: 'val', textContent: String(s.volume) });
    const r = slider(0, 100, 1, s.volume, name);
    const row = h('div', { class: `stem${s.volume === 0 ? ' muted' : ''}` });
    const sync = () => { val.textContent = String(s.volume); setSlider(r, s.volume); row.classList.toggle('muted', s.volume === 0); };
    r.addEventListener('input', () => { this.p.setVolume(s.stem, +r.value); sync(); });
    // Icono = mute/unmute (slider a 0)
    const icon = h('button', { class: 's btn-ic', attrs: { 'aria-label': `${t('cd_stem_mute')}: ${name}` }, onclick: () => { this.p.toggleMute(s.stem); sync(); } }, img(iconOf(s.stem, v2), 's', ''));
    const solo = h('button', { class: 'solo', textContent: 'S', attrs: { 'aria-pressed': String(s.solo), 'aria-label': `${t('web_solo')}: ${name}` } });
    solo.onclick = () => { this.p.toggleSolo(s.stem); solo.setAttribute('aria-pressed', String(s.solo)); };
    const rs = h('button', { class: 'rs', attrs: { 'aria-label': `${t('cd_restore_volume')}: ${name}` }, onclick: () => this.animateTo(s, DEFAULT_VOLUME, sync) }, img(icRestore, '', ''));
    row.append(icon, h('span', { class: 'nm', textContent: name }), r, val, solo, rs);
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
      const apply = (v: number) => { this.p.setPitch(v); setSlider(r, this.p.pitch); show.textContent = this.pitchVal.textContent = this.p.pitch > 0 ? `+${this.p.pitch}` : String(this.p.pitch); };
      r.addEventListener('input', () => apply(+r.value));
      apply(this.p.pitch);
      pop.append(h('div', { class: 'hd' }, h('span', { textContent: t('cd_pitch') }), show), r,
        h('div', { class: 'row' }, h('button', { textContent: '−1', onclick: () => apply(this.p.pitch - 1) }),
          h('button', { textContent: '0', onclick: () => apply(0) }), h('button', { textContent: '+1', onclick: () => apply(this.p.pitch + 1) })));
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

