// Fondo animado (NebulaBackgroundView): 3 blobs en orbita + ancla bajo el transporte,
// mezcla aditiva, velo 0x66000000, 30 fps, pulso por beat. Opt-in (nebula_enabled = false).
import { accentPalette, brightnessCap, decayPulse, orbits } from '../player/nebulaMath.ts';

export interface NebulaColors { blobs: number[][]; anchor: number[] }

const FRAME_MS = 1000 / 30;
const SCALE = 0.5; // todo es difuso: media resolucion basta
const ANCHOR_Y = 1.02, ANCHOR_W = 1.30, ANCHOR_SQUASH = 0.36;

export class Nebula {
  readonly el: HTMLCanvasElement = document.createElement('canvas');
  private ctx = this.el.getContext('2d')!;
  private orbit = orbits();
  private palette: NebulaColors = accentPalette('#27B397');
  private capped: boolean;
  private cap: number; // tope de brillo para que los textos se lean
  private pulse = 0;
  private t0 = performance.now();
  private last = 0;
  private raf = 0;
  private on = false;
  private orbitK = 1;      // 0 = blobs en orbita ocultos (vista 3D): queda el ancla
  private orbitTo = 1;
  private still = matchMedia('(prefers-reduced-motion: reduce)');
  private speed: number;

  /** `speed` multiplica el giro de las orbitas (el centro sin cancion va a 0.5). `capped`: tope de brillo
   *  (detras del reproductor; el centro sin cancion va sin tope). */
  constructor(speed = 1, capped = true) {
    this.speed = speed;
    this.capped = capped;
    this.cap = capped ? brightnessCap(this.palette) : 1;
    this.el.className = 'nebula';
    this.el.setAttribute('aria-hidden', 'true');
    (this.el as HTMLCanvasElement & { nebula?: Nebula }).nebula = this; // acceso de las pruebas
    document.addEventListener('visibilitychange', () => this.sync());
  }

  /** Paleta: la del acento (fromAccent) o la de la portada. */
  setColors(p: NebulaColors) { this.palette = p; this.cap = this.capped ? brightnessCap(p) : 1; }

  setEnabled(on: boolean) { this.on = on; this.el.classList.toggle('on', on); this.sync(); }

  /** Vista 3D: los 3 blobs en orbita se funden (500 ms); el ancla se queda. */
  setOrbitBlobsVisible(v: boolean) { this.orbitTo = v ? 1 : 0; if (this.still.matches || !this.on) this.orbitK = this.orbitTo; }

  /** Pulso en un beat (0..1); se queda el maximo. */
  beat(intensity: number) { if (intensity > this.pulse) this.pulse = intensity; }

  destroy() { this.on = false; cancelAnimationFrame(this.raf); }

  // Solo dibuja encendida y con la pestana visible
  private sync() {
    cancelAnimationFrame(this.raf);
    if (this.on && !document.hidden) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    if (now - this.last < FRAME_MS - 4) return;
    const dt = this.last ? (now - this.last) / 1000 : 0;
    this.last = now;
    this.pulse = decayPulse(this.pulse, dt);
    this.orbitK = this.orbitTo > this.orbitK ? Math.min(this.orbitTo, this.orbitK + dt / 0.5) : Math.max(this.orbitTo, this.orbitK - dt / 0.5);
    this.draw(this.still.matches ? 0 : (now - this.t0) / 1000 * this.speed);
  };

  private draw(t: number) {
    const c = this.el, ctx = this.ctx;
    const w = Math.max(1, Math.round(c.clientWidth * SCALE)), hgt = Math.max(1, Math.round(c.clientHeight * SCALE));
    if (c.width !== w || c.height !== hgt) { c.width = w; c.height = hgt; }
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, hgt);
    ctx.globalCompositeOperation = 'lighter'; // PorterDuff ADD
    const p = this.pulse, min = Math.min(w, hgt);
    if (this.orbitK > 0) this.orbit.forEach((o, i) => {
      const a = 2 * Math.PI * o.freq * t + o.phase;
      const cx = w / 2 + w * o.rx * Math.cos(a), cy = hgt / 2 + hgt * o.ry * Math.sin(a);
      const r = i === 0 ? min * 0.30 * (1 + p * 0.40) : min * 0.55 * (1 + p * 0.10);
      const alpha = Math.min(230, i === 0 ? 170 + p * 70 : 135 + p * 60) / 255;
      this.blob(cx, cy, r, this.palette.blobs[i], alpha * this.orbitK * this.cap, 0.20);
    });
    // Ancla: elipse fija bajo el borde, como un foco tras el transporte
    const ax = w / 2, ay = hgt * ANCHOR_Y, ar = w * ANCHOR_W * (1 + p * 0.15);
    ctx.save();
    ctx.translate(ax, ay); ctx.scale(1, ANCHOR_SQUASH); ctx.translate(-ax, -ay);
    this.blob(ax, ay, ar, this.palette.anchor, Math.min(240, 160 + p * 80) / 255 * this.cap, 0);
    ctx.restore();
    // Velo "cristal esmerilado"
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, w, hgt);
  }

  private blob(cx: number, cy: number, r: number, rgb: number[], alpha: number, plateau: number) {
    const g = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const col = (a: number) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
    g.addColorStop(0, col(alpha));
    if (plateau) g.addColorStop(plateau, col(alpha));
    g.addColorStop(1, col(0));
    this.ctx.fillStyle = g;
    this.ctx.beginPath(); this.ctx.arc(cx, cy, r, 0, 2 * Math.PI); this.ctx.fill();
  }
}
