// Mini-player del movil (mini_player.xml + MiniPlayerController): portada, titulo y artista, play/pausa y
// progreso de 2 px. Tocar = abrir el reproductor; arrastrar = el texto sigue al dedo y asoma la cancion de al
// lado; soltar pasado el 30 % del ancho = siguiente (izquierda) o anterior (derecha); si no, vuelve.
import { t } from '../i18n/i18n.ts';
import { h, img } from './dom.ts';

export interface MiniSong { title: string; artist: string; cover: string | null }

export interface MiniHooks {
  /** Abrir el reproductor a pantalla completa. */
  onOpen(): void;
  onToggle(): void;
  /** Cambiar de cancion sin abrir el reproductor (1 = siguiente). */
  onStep(dir: 1 | -1): void;
  /** Cancion de al lado para la vista previa del arrastre (null = no hay). */
  adjacent(dir: 1 | -1): MiniSong | null;
  /** Estado del que suena: para la barra y el boton. */
  state(): { playing: boolean; positionMs: number; durationMs: number } | null;
}

const PLAY = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="#fff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M7 5.5h3.2v13H7zM13.8 5.5H17v13h-3.2z" fill="#fff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const COMMIT = 0.3, TAP_MS = 300, SLOP = 8, SNAP_MS = 220;

export class MiniPlayer {
  readonly el: HTMLElement;
  private hooks: MiniHooks;
  private cover = h('span', { class: 'mcv' });
  private cur = h('div', { class: 'mtx' });
  private prev = h('div', { class: 'mtx' });
  private next = h('div', { class: 'mtx' });
  private wrap = h('div', { class: 'mwrap' }, this.prev, this.cur, this.next);
  private play = h('button', { class: 'mplay' });
  private bar = h('i');
  private raf = 0;
  private playing: boolean | null = null;

  constructor(hooks: MiniHooks) {
    this.hooks = hooks;
    const swipe = h('div', { class: 'mswipe', attrs: { role: 'button', tabindex: '0', 'aria-label': t('web_open_player') } });
    swipe.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hooks.onOpen(); } };
    this.play.onclick = () => hooks.onToggle();
    this.el = h('div', { class: 'mini' }, this.cover, this.wrap, swipe, this.play, h('span', { class: 'mprog' }, this.bar));
    this.el.hidden = true;
    this.drag(swipe);
  }

  /** Cancion que suena (null = sin cancion: se oculta). */
  set(song: MiniSong | null) {
    this.el.hidden = !song;
    if (!song) { cancelAnimationFrame(this.raf); return; }
    this.cover.replaceChildren(...(song.cover ? [img(song.cover, '', '')] : []));
    this.fill(this.cur, song);
    this.playing = null;
    cancelAnimationFrame(this.raf);
    this.tick();
  }

  destroy() { cancelAnimationFrame(this.raf); }

  private fill(el: HTMLElement, s: MiniSong | null) {
    el.replaceChildren(...(s ? [h('b', { textContent: s.title }), h('span', { textContent: s.artist })] : []));
  }

  // Progreso y boton al dia mientras se ve (refresco de Android: cada 250 ms; aqui por frame)
  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    if (this.el.offsetParent === null) return;
    const st = this.hooks.state();
    if (!st) return;
    this.bar.style.width = `${st.durationMs ? Math.min(100, st.positionMs / st.durationMs * 100) : 0}%`;
    if (st.playing !== this.playing) {
      this.playing = st.playing;
      this.play.innerHTML = st.playing ? PAUSE : PLAY;
      this.play.setAttribute('aria-label', t(st.playing ? 'web_pause' : 'web_play'));
    }
  };

  private place(dx: number, w: number, anim: boolean) {
    for (const [el, off] of [[this.prev, -w], [this.cur, 0], [this.next, w]] as const) {
      el.style.transition = anim ? `transform ${SNAP_MS}ms cubic-bezier(.4,0,.2,1)` : 'none';
      el.style.transform = `translateX(${off + dx}px)`;
    }
  }

  private drag(area: HTMLElement) {
    let x0 = 0, t0 = 0, id = -1, moved = false;
    area.onpointerdown = (e) => {
      id = e.pointerId; x0 = e.clientX; t0 = performance.now(); moved = false;
      area.setPointerCapture(id);
      this.fill(this.prev, this.hooks.adjacent(-1));
      this.fill(this.next, this.hooks.adjacent(1));
    };
    area.onpointermove = (e) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - x0;
      if (!moved && Math.abs(dx) < SLOP) return;
      moved = true;
      this.place(dx, this.wrap.clientWidth, false);
    };
    const end = (e: PointerEvent, cancel: boolean) => {
      if (e.pointerId !== id) return;
      id = -1;
      const dx = e.clientX - x0, w = this.wrap.clientWidth;
      if (!moved) { if (!cancel && performance.now() - t0 < TAP_MS) this.hooks.onOpen(); return; }
      const dir: 1 | -1 = dx < 0 ? 1 : -1;
      // Pasado el 30 % y con cancion al lado: se confirma; si no, vuelve a su sitio
      if (!cancel && Math.abs(dx) > w * COMMIT && this.hooks.adjacent(dir)) {
        this.place(-dir * w, w, true);
        setTimeout(() => {
          this.fill(this.cur, this.hooks.adjacent(dir));
          this.place(0, w, false);
          this.hooks.onStep(dir);
        }, SNAP_MS);
      } else this.place(0, w, true);
    };
    area.onpointerup = (e) => end(e, false);
    area.onpointercancel = (e) => end(e, true);
  }
}
