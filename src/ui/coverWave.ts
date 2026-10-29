// Portada durante la descarga (CoverFillWaveView de Android): portada oscurecida que se
// llena de abajo arriba con la portada real, bajo una ola senoidal. El nivel persigue al %.

const WAVE_CYCLES = 0.8, PHASE_SPEED = 3.2, LEVEL_EASE = 4;
const AMP_FRAC = 6 / 48; // 6 dp sobre la portada de 48 dp de Android

const waves = new Set<CoverWave>();
let raf = 0, last = 0;
function loop(now: number) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
  last = now;
  for (const w of waves) w.tick(dt);
  raf = waves.size ? requestAnimationFrame(loop) : 0;
  if (!raf) last = 0;
}

export class CoverWave {
  readonly el = document.createElement('canvas');
  private img: HTMLImageElement | null = null;
  private progress = 0;
  private shown = 0;
  private phase = 0;

  constructor() {
    this.el.className = 'wave';
    this.el.setAttribute('aria-hidden', 'true');
  }

  setCover(url: string | null) {
    if (!url) return;
    const im = new Image();
    im.onload = () => { this.img = im; this.draw(); };
    im.src = url;
  }

  setProgress(p: number) {
    p = Math.max(0, Math.min(1, p));
    if (p < this.shown) this.shown = p; // bajada = descarga nueva: sin suavizar
    this.progress = p;
    if (!waves.has(this)) { waves.add(this); if (!raf) raf = requestAnimationFrame(loop); }
  }

  stop() { waves.delete(this); }

  tick(dt: number) {
    this.phase = (this.phase + PHASE_SPEED * dt) % (2 * Math.PI);
    this.shown += (this.progress - this.shown) * (1 - Math.exp(-LEVEL_EASE * dt));
    if (!this.el.isConnected && dt > 0) return;
    this.draw();
  }

  private draw() {
    const c = this.el, dpr = devicePixelRatio || 1;
    const w = Math.round((c.clientWidth || 36) * dpr), h = Math.round((c.clientHeight || 36) * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    if (!this.img) { ctx.fillStyle = '#252525'; ctx.fillRect(0, 0, w, h); }
    // 1) Portada oscurecida (saturacion 0.6, brillo 0.28)
    if (this.img) { ctx.filter = 'saturate(0.6) brightness(0.28)'; ctx.drawImage(this.img, 0, 0, w, h); ctx.filter = 'none'; }
    // 2) Ola: a nivel 0 la base esta bajo el borde; a 1, por encima de la cresta
    const amp = h * AMP_FRAC, base = (1 - this.shown) * (h + 2 * amp) - amp;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i <= 48; i++) ctx.lineTo(i / 48 * w, base + amp * Math.sin(i / 48 * WAVE_CYCLES * 2 * Math.PI + this.phase));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.clip();
    // 3) Portada a brillo real dentro de la ola
    if (this.img) ctx.drawImage(this.img, 0, 0, w, h);
    else { ctx.fillStyle = '#5a5a5a'; ctx.fillRect(0, 0, w, h); }
    ctx.restore();
  }
}
