// Telon de carga de cancion (brand/FisionLoadingSurface de Android): negro con el
// nucleo-spinner blanco; al terminar la carga el anillo se cierra, se reproduce la
// fision, se mantiene la marca y el telon se funde. Carga muy rapida: solo fundido.
import { APPEAR, MARK_MAX, MARK_MIN, ATOM_RM, ATOM_SW, ATOM_X, ATOM_Y, MIN_SPIN, NO_TF, SETTLED, c01, closeArc, closePlan, drawMark, steady, warp, type ClosePlan, type MarkState } from '../brand/fisionMotion.ts';

const FADE_OUT_MS = 280, QUICK_FADE_MS = 180, HOLD_MS = 250, QUICK_MS = 250;
const NUCLEUS_PX = 64;

export class Curtain {
  readonly el = document.createElement('canvas');
  private ctx = this.el.getContext('2d')!;
  private mark = document.createElement('canvas'); // fundido de la marca entera (sin solapes de alpha)
  private start = -1;
  private nucleus = NUCLEUS_PX;
  private fadeIn: number;
  private onCovered: (() => void) | null;
  private readyAt = -1;
  private plan: ClosePlan | null = null;
  private quick = false;
  private onReveal: (() => void) | null = null;
  private onGone: (() => void) | null = null;
  private fadeOutStart = -1;
  private raf = 0;
  readonly covered: Promise<void>;

  /** fadeInMs 0 = opaco desde el principio (apertura); 220 al cambiar de cancion. */
  constructor(fadeInMs: number, opts: { nucleus?: number; cls?: string; start?: number } = {}) {
    this.el.className = opts.cls ?? 'curtain-c';
    this.nucleus = opts.nucleus ?? NUCLEUS_PX;
    this.start = opts.start ?? -1;
    this.el.setAttribute('role', 'status');
    this.fadeIn = fadeInMs;
    let res!: () => void;
    this.covered = new Promise((r) => (res = r));
    this.onCovered = res;
    if (fadeInMs <= 0) { res(); this.onCovered = null; }
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Fin de la carga. resolve=false: spinner normal, solo fundido rapido. */
  finish(onReveal: () => void, onGone: () => void, resolve = true) {
    if (this.readyAt >= 0 || this.quick) return;
    this.onReveal = onReveal; this.onGone = onGone;
    const t = this.start < 0 ? 0 : performance.now() - this.start;
    if (!resolve || t < QUICK_MS) this.quick = true;
    else { this.readyAt = Math.max(t, MIN_SPIN); this.plan = closePlan(this.readyAt); }
  }

  destroy() { cancelAnimationFrame(this.raf); this.el.remove(); }

  private frame = (now: number) => {
    if (this.start < 0) this.start = now;
    const t = now - this.start;
    let curtainA = this.fadeIn > 0 ? c01(t / this.fadeIn) : 1;
    if (this.onCovered && curtainA >= 1) { this.onCovered(); this.onCovered = null; }
    const s: MarkState = { head: 0, tail: 0, alpha: c01(t / APPEAR), grow: 1, tf: NO_TF };
    if (!this.plan || t < this.readyAt) [s.head, s.tail] = steady(t);
    else {
      // Cierre y fision a 2x tras la carga
      const local = warp(t - this.readyAt);
      s.tf = local - this.plan.dur;
      if (local < this.plan.dur) [s.head, s.tail] = closeArc(this.plan, local);
      else { s.tail = this.plan.t1; s.head = this.plan.t1 + 1; }
    }
    const done = this.quick || (this.plan !== null && s.tf >= SETTLED + HOLD_MS);
    if (done && this.fadeOutStart < 0) { this.fadeOutStart = now; this.onReveal?.(); }
    let gone = false;
    if (this.fadeOutStart >= 0) {
      const out = c01((now - this.fadeOutStart) / (this.quick ? QUICK_FADE_MS : FADE_OUT_MS));
      curtainA *= 1 - out;
      gone = out >= 1;
    }
    this.draw(s, curtainA);
    if (gone) { this.onGone?.(); this.destroy(); return; }
    this.raf = requestAnimationFrame(this.frame);
  };

  private draw(s: MarkState, a: number) {
    const c = this.el, ctx = this.ctx, dpr = devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    ctx.clearRect(0, 0, w, h);
    if (a <= 0) return;
    ctx.fillStyle = `rgba(0,0,0,${a})`;
    ctx.fillRect(0, 0, w, h);
    const k = this.nucleus * dpr / (2 * (ATOM_RM + ATOM_SW / 2));
    // Marca opaca en un lienzo aparte y luego con el alpha del telon
    const size = Math.ceil((MARK_MAX - MARK_MIN) * k);
    const m = this.mark, mc = m.getContext('2d')!;
    if (m.width !== size) { m.width = size; m.height = size; }
    mc.clearRect(0, 0, size, size);
    mc.save(); mc.scale(k, k); mc.translate(-MARK_MIN, -MARK_MIN);
    drawMark(mc, s);
    mc.restore();
    ctx.globalAlpha = a;
    ctx.drawImage(m, w / 2 - (ATOM_X - MARK_MIN) * k, h / 2 - (ATOM_Y - MARK_MIN) * k);
    ctx.globalAlpha = 1;
  }
}

// Spinner de la vista 3D (sceneSpinner de Android): 48 px, sin resolver. Dos seguidos (carga del
// modulo y de la escena) comparten fase para no dar un salto.
let spinT0 = 0, spinLast = -1e9;
export function sceneSpinner(label: string): { el: HTMLElement; finish: () => void } {
  const now = performance.now();
  if (now - spinLast > 500) spinT0 = now;
  spinLast = now;
  const c = new Curtain(0, { nucleus: 48, cls: 'd3spin', start: spinT0 });
  const el = document.createElement('div');
  el.className = 'd3load';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', label);
  el.append(c.el);
  return { el, finish: () => { spinLast = performance.now(); c.finish(() => {}, () => el.remove(), false); } };
}
