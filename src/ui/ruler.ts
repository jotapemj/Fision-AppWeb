// Regla horizontal (RulerPickerView): marcas menores cada paso, mayores con numero cada 10, marca de referencia
// (valor neutro) en acento, triangulo fijo en el centro. Arrastre 1:1 sin inercia; al soltar, iman de 180 ms
// al paso; restaurar = animar al neutro en 420 ms pasando por cada valor (el motor desliza, no salta).
import { h } from './dom.ts';

export interface RulerOpts {
  min: number; max: number; step: number; value: number;
  /** Separacion entre marcas en px (14 por defecto; el tono usa 28). */
  spacing?: number;
  /** Valor de referencia (posicion original). */
  neutral?: number;
  label: string;
  /** Cada valor nuevo (arrastrando, al soltar o animando). */
  onChange(v: number): void;
}

const TOP = 14, MINOR_H = 10, MAJOR_H = 18, LABEL = 12, LABEL_GAP = 6, MARK_H = 10, MARK_W = 6, MARK_GAP = 3;
const SNAP_MS = 180, RESTORE_MS = 420;
const decel = (k: number) => 1 - (1 - k) * (1 - k); // DecelerateInterpolator

export class Ruler {
  readonly el: HTMLCanvasElement;
  private o: RulerOpts;
  private pos: number; // posicion continua en unidades de valor
  private last: number;
  private anim = 0;

  constructor(o: RulerOpts) {
    this.o = o;
    this.pos = this.last = this.clamp(o.value);
    this.el = h('canvas', { class: 'ruler', attrs: { role: 'slider', tabindex: '0', 'aria-label': o.label, 'aria-valuemin': String(o.min), 'aria-valuemax': String(o.max) } });
    this.el.style.height = `${TOP + MAJOR_H + LABEL_GAP + LABEL + 6}px`;
    this.drag();
    // Teclado: flechas = un paso
    this.el.onkeydown = (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      this.set(this.value + d * o.step, true);
    };
    new ResizeObserver(() => this.draw()).observe(this.el);
    this.aria();
  }

  get value() { return this.snap(this.pos); }

  /** Fija el valor (fromUser: avisa). */
  set(v: number, fromUser = false) {
    cancelAnimationFrame(this.anim);
    this.pos = this.clamp(v);
    this.emit(fromUser);
    this.draw();
  }

  /** Restaurar: anima hasta el neutro avisando en cada valor nuevo. */
  restore() { if (this.o.neutral !== undefined) this.animateTo(this.o.neutral, RESTORE_MS); }

  private clamp(v: number) { return Math.min(this.o.max, Math.max(this.o.min, v)); }
  private snap(v: number) { const s = this.o.step; return this.clamp(Math.round((v - this.o.min) / s) * s + this.o.min); }

  private emit(fromUser: boolean) {
    const v = this.value;
    if (v === this.last) return;
    this.last = v;
    this.aria();
    if (fromUser) this.o.onChange(v);
  }

  private aria() { this.el.setAttribute('aria-valuenow', String(this.value)); }

  private animateTo(target: number, ms: number) {
    cancelAnimationFrame(this.anim);
    const from = this.pos, to = this.clamp(target), t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      this.pos = from + (to - from) * decel(k);
      this.emit(true);
      this.draw();
      if (k < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  private drag() {
    const c = this.el;
    let x0 = 0, id = -1;
    c.style.touchAction = 'pan-y';
    c.onpointerdown = (e) => { cancelAnimationFrame(this.anim); id = e.pointerId; x0 = e.clientX; c.setPointerCapture(id); };
    c.onpointermove = (e) => {
      if (e.pointerId !== id) return;
      const sp = this.o.spacing ?? 14;
      // Arrastrar a la derecha trae valores menores al centro
      this.pos = this.clamp(this.pos - (e.clientX - x0) / sp * this.o.step);
      x0 = e.clientX;
      this.emit(true);
      this.draw();
    };
    const up = (e: PointerEvent) => { if (e.pointerId !== id) return; id = -1; this.animateTo(this.value, SNAP_MS); };
    c.onpointerup = up; c.onpointercancel = up;
  }

  private draw() {
    const c = this.el, dpr = devicePixelRatio || 1;
    const w = c.clientWidth, hh = c.clientHeight;
    if (!w) return;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    const cs = getComputedStyle(c);
    const accent = cs.getPropertyValue('--accent').trim() || '#27B397';
    const { min, max, step } = this.o, sp = this.o.spacing ?? 14, cx = w / 2, bottom = TOP + MAJOR_H;
    const half = cx / sp * step;
    g.lineCap = 'round';
    g.textAlign = 'center';
    g.font = `${LABEL}px ${cs.fontFamily}`;
    const k0 = Math.max(0, Math.floor((this.pos - half - min) / step)), k1 = Math.min((max - min) / step, Math.ceil((this.pos + half - min) / step));
    for (let k = k0; k <= k1; k++) {
      const v = min + k * step, x = cx + (v - this.pos) / step * sp;
      const major = v % 10 === 0, ref = v === this.o.neutral;
      g.strokeStyle = ref ? accent : major ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.55)';
      g.lineWidth = ref ? 3 : major ? 1.5 : 1;
      g.beginPath(); g.moveTo(x, bottom - (ref || major ? MAJOR_H : MINOR_H)); g.lineTo(x, bottom); g.stroke();
      if (major) { g.fillStyle = 'rgba(255,255,255,.85)'; g.fillText(String(v), x, bottom + LABEL_GAP + LABEL); }
    }
    // Triangulo hacia abajo sobre la fila de marcas
    const apex = TOP - MARK_GAP;
    g.fillStyle = accent;
    g.beginPath(); g.moveTo(cx, apex); g.lineTo(cx - MARK_W, apex - MARK_H); g.lineTo(cx + MARK_W, apex - MARK_H); g.closePath(); g.fill();
  }
}
