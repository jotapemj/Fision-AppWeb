// Marca animada de Fision: geometria (rejilla 512 del logo) y cinematica.
// Port de brand/FisionMotion.java (Android). Unidades: logo, ms y vueltas.

export const ATOM_X = 225, ATOM_Y = 255.5, ATOM_RM = 90, ATOM_SW = 29;
export const NEU_X = 44.5, NEU_Y = 255.5, NEU_RM = 29.6, NEU_SW = 30;
export const FRAGS = [[404.5, 75], [404.5, 436]];
export const FRAG_RM = 59, FRAG_SW = 30;
export const SQ = [[435.5, 225.5], [495.5, 255.5], [435.5, 285.5]];
export const SQ_S = 30, BAR_W = 30, RBAR_END = 389;
/** Centro del neutron cuando toca el nucleo. */
export const NEU_CONTACT = ATOM_X - (ATOM_RM + ATOM_SW / 2) - (NEU_RM + NEU_SW / 2);

// Spinner
export const P = 1100;                 // ciclo de extension / recogida
export const W = 1 / 1400;             // giro base, vueltas por ms
export const L_MIN = 0.08, L_EXT = 0.62;
export const APPEAR = 220;             // fade-in inicial
export const MIN_SPIN = 600;           // giro minimo antes de cerrar
const D_CLOSE_MIN = 380, D_CLOSE_MAX = 900;
const RATIO_MAX = 2.6;                 // v*D/delta: Hermite monotono, sin rebasar
const HEAD_AVG_MAX = 1 / 450;
export const START_DEG = -90;          // el arco empieza y cierra a las 12

// Fision (ms desde que el anillo se cierra)
export const N_START = -140, N_FLY = 240, IMPACT = N_START + N_FLY;
export const N_RECOIL = 320, N_RECOIL_V = 0.24, N_START_X = -110, N_FADE = 0.8, N_GHOSTS = 3;
export const BOUNCE_A = 11, BOUNCE_TAU = 130, BOUNCE_T = 280;
export const FRAG_START = IMPACT + 70, FRAG_DUR = 620;
export const SQ_START = IMPACT + 150, SQ_STAG = 60, SQ_DUR = 560;
export const SETTLED = SQ_START + 2 * SQ_STAG + SQ_DUR;
export const NO_TF = -1e9;
export const MARK_MIN = -200, MARK_MAX = 532; // lienzo de la marca: incluye el vuelo del neutron y sus estelas

export const c01 = (x: number) => Math.max(0, Math.min(1, x));
export const easeOut = (x: number) => { const i = 1 - x; return 1 - i * i * i; };
export const smoother = (x: number) => x * x * x * (x * (6 * x - 15) + 10);
export const backOut = (x: number, k: number) => { const d = x - 1; return 1 + (k + 1) * d * d * d + k * d * d; };
export function herm(p0: number, v0: number, p1: number, v1: number, dur: number, t: number) {
  const s = c01(t / dur), s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * dur * v0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * dur * v1;
}

/** Spinner estable en u (ms): [cabeza, cola] en vueltas. */
export function steady(u: number): [number, number] {
  const k = Math.floor(u / P), s = u / P - k, base = W * u + k * L_EXT;
  return [base + L_MIN + L_EXT * smoother(c01(2 * s)), base + L_EXT * smoother(c01(2 * s - 1))];
}

export interface ClosePlan { h0: number; t0: number; vH: number; vT: number; dur: number; t1: number; extraTurns: number }

/** La cola frena en el punto de partida (vuelta entera) y la cabeza la alcanza; vuelta extra si queda demasiado cerca. */
export function closePlan(u0: number): ClosePlan {
  const s0 = steady(u0), a = steady(u0 - 0.5), b = steady(u0 + 0.5);
  const vH = b[0] - a[0], vT = b[1] - a[1], f0 = s0[0] - s0[1];
  let dT = Math.ceil(s0[1]) - s0[1];
  for (let k = 0; k < 4; k++, dT += 1) {
    const dH = dT + 1 - f0;
    const d = Math.max(D_CLOSE_MIN, Math.min(D_CLOSE_MAX, Math.max(2 * dT / vT, dH / HEAD_AVG_MAX)));
    if (vT * d / dT <= RATIO_MAX && vH * d / dH <= RATIO_MAX) {
      return { h0: s0[0], t0: s0[1], vH, vT, dur: Math.round(d), t1: s0[1] + dT, extraTurns: k };
    }
  }
  return { h0: s0[0], t0: s0[1], vH, vT, dur: D_CLOSE_MAX, t1: s0[1] + dT, extraTurns: 0 };
}

/** Arco durante el cierre: [cabeza, cola]. La cabeza nunca pasa la union. */
export function closeArc(p: ClosePlan, t: number): [number, number] {
  const tail = herm(p.t0, p.vT, p.t1, 0, p.dur, t);
  const head = herm(p.h0, p.vH, p.t1 + 1, 0, p.dur, t);
  return [Math.min(tail + 1, head), tail];
}

/** Tiempo de animacion tras dt ms reales desde el fin de la carga: rampa lineal de 1x a 2x en 150 ms. */
export function warp(dt: number, endSpeed = 2, rampMs = 150): number {
  const extra = endSpeed - 1;
  return dt < rampMs ? dt + extra * dt * dt / (2 * rampMs) : dt + extra * (dt - rampMs / 2);
}

export interface MarkState { head: number; tail: number; alpha: number; grow: number; tf: number }

const FRAG_DIR = FRAGS.map(([x, y]) => { const dx = x - ATOM_X, dy = y - ATOM_Y, d = Math.hypot(dx, dy); return [dx / d, dy / d, d]; });

function fragDistance(i: number, tf: number): number {
  const p = tf < 0 ? 0 : c01((tf - FRAG_START) / FRAG_DUR);
  if (p <= 0) return -1;
  const d0 = ATOM_RM + ATOM_SW / 2;
  return d0 + (FRAG_DIR[i][2] - d0) * backOut(p, 1.5);
}

/** Dibuja un frame en unidades del logo (FisionRenderer.draw). El llamador fija la transformacion. */
export function drawMark(c: CanvasRenderingContext2D, s: MarkState, rgb = '255,255,255') {
  const tf = s.tf;
  const col = (a: number) => `rgba(${rgb},${c01(a)})`;
  let bx = 0, bs = 1;
  if (tf >= IMPACT) {
    const u = tf - IMPACT, env = Math.exp(-u / BOUNCE_TAU), osc = Math.sin(2 * Math.PI * u / BOUNCE_T);
    bx = BOUNCE_A * env * osc;
    bs = 1 + 0.035 * env * Math.abs(osc);
  }
  const ax = ATOM_X + bx, scale = bs * s.grow;
  const line = (x1: number, y1: number, x2: number, y2: number, a: number) => {
    c.lineCap = 'butt'; c.lineWidth = BAR_W; c.strokeStyle = col(a);
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  };
  const ring = (x: number, y: number, r: number, w: number, a: number) => {
    c.lineCap = 'round'; c.lineWidth = w; c.strokeStyle = col(a);
    c.beginPath(); c.arc(x, y, r, 0, 2 * Math.PI); c.stroke();
  };

  if (tf !== NO_TF) {
    // Radios hacia los fragmentos y barra hacia los neutrones liberados (bajo los anillos)
    FRAGS.forEach((_, i) => {
      const d = fragDistance(i, tf);
      if (d < 0) return;
      const p = c01((tf - FRAG_START) / FRAG_DUR), [dx, dy] = FRAG_DIR[i], sc = 0.3 + 0.7 * easeOut(p);
      const x = ATOM_X + dx * d, y = ATOM_Y + dy * d, sx = ax + dx * ATOM_RM, sy = ATOM_Y + dy * ATOM_RM;
      const ex = x - dx * FRAG_RM * sc, ey = y - dy * FRAG_RM * sc;
      if ((ex - sx) * dx + (ey - sy) * dy > 0) line(sx, sy, ex, ey, c01(p / 0.2));
    });
    const pb = tf < 0 ? 0 : c01((tf - SQ_START) / SQ_DUR);
    if (pb > 0) line(ax + ATOM_RM, ATOM_Y, ax + ATOM_RM + (RBAR_END - ATOM_X - ATOM_RM) * easeOut(pb), ATOM_Y, c01(pb / 0.15));
  }

  // Neutron: entra ya en movimiento con fade-in, choca, retrocede y se asienta
  if (tf >= N_START) {
    let nx: number, na: number;
    if (tf < IMPACT) {
      const p = (tf - N_START) / N_FLY;
      nx = N_START_X + (NEU_CONTACT - N_START_X) * p;
      na = smoother(c01(p / N_FADE));
      const v = (NEU_CONTACT - N_START_X) / N_FLY;
      for (let i = 0; i < N_GHOSTS; i++) ring(nx - v * 16 * (i + 1), NEU_Y, NEU_RM, NEU_SW, na * 0.22 / (i + 1));
    } else {
      nx = herm(NEU_CONTACT, -N_RECOIL_V, NEU_X, 0, N_RECOIL, tf - IMPACT);
      na = 1;
      line(nx + NEU_RM, NEU_Y, ax - ATOM_RM, ATOM_Y, 1); // enlace nacido en el choque
    }
    ring(nx, NEU_Y, NEU_RM, NEU_SW, na);
  }

  // Nucleo: arco del spinner o anillo cerrado
  const f = s.head - s.tail;
  const rot = ((((s.tail % 1) + 1) % 1) * 360 + START_DEG) * Math.PI / 180;
  c.save();
  c.translate(ax, ATOM_Y); c.scale(scale, scale); c.translate(-ATOM_X, -ATOM_Y);
  c.lineCap = 'round'; c.lineWidth = ATOM_SW; c.strokeStyle = col(s.alpha);
  c.beginPath();
  if (f >= 0.999) c.arc(ATOM_X, ATOM_Y, ATOM_RM, 0, 2 * Math.PI);
  else c.arc(ATOM_X, ATOM_Y, ATOM_RM, rot, rot + Math.max(0.5, f * 360) * Math.PI / 180);
  c.stroke();
  c.restore();

  if (tf !== NO_TF) {
    FRAGS.forEach((_, i) => {
      const d = fragDistance(i, tf);
      if (d < 0) return;
      const p = c01((tf - FRAG_START) / FRAG_DUR), sc = 0.3 + 0.7 * easeOut(p);
      ring(ATOM_X + FRAG_DIR[i][0] * d, ATOM_Y + FRAG_DIR[i][1] * d, FRAG_RM * sc, FRAG_SW * sc, c01(p / 0.2));
    });
    SQ.forEach(([qx, qy], i) => {
      const p = tf < 0 ? 0 : c01((tf - SQ_START - i * SQ_STAG) / SQ_DUR);
      if (p <= 0) return;
      const x0 = ATOM_X + ATOM_RM + ATOM_SW / 2, e = backOut(p, 1.3);
      const x = x0 + (qx - x0) * e, y = ATOM_Y + (qy - ATOM_Y) * e, z = SQ_S * (0.3 + 0.7 * easeOut(p)) / 2;
      c.fillStyle = col(c01(p / 0.2));
      c.fillRect(x - z, y - z, 2 * z, 2 * z);
    });
  }
}
