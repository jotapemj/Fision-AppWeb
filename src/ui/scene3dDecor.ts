// Decoracion de la sala 3D (Audio3DSceneController: addRoomPanels, addRoomScreen, addRoomTraps,
// addStudioFrontWall). Coordenadas locales de pared como en Android: origen en su centro
// (y mundo 0.5), +Z hacia dentro de la sala, +X a la derecha mirando la pared.
import * as THREE from 'three';
import { ROOM_CEIL_Y, ROOM_FLOOR_SURFACE_Y, ROOM_FLOOR_Y, ROOM_HALF_X, ROOM_HALF_Z } from '../player/audio3d.ts';

type RGB = [number, number, number];

export const WALL_LOCAL_FLOOR_Y = ROOM_FLOOR_SURFACE_Y - (ROOM_FLOOR_Y + ROOM_CEIL_Y) / 2;
const PANEL_W = 0.6, PANEL_H = 0.6, PANEL_D = 0.03, PANEL_COLS = 6, PANEL_ROWS = 4;
const PANEL_COL_SPACING_X = 1.35, PANEL_ROW_SPACING_Y = 0.8, PANEL_OFFSET_Z = 0.025;
const TRAP_RADIUS = 0.15;
const SCREEN_LOCAL_Y = 0.4, SCREEN_IMG_SIZE = 1.88, SCREEN_BEZEL_SIZE = 2.0, SCREEN_BEZEL_D = 0.06, CARD_PX = 1024;
const BACKLIGHT_SIZE = 2.89, BACKLIGHT_Z = 0.004, BACKLIGHT_PX = 256, BACKLIGHT_ALPHA = 0.78, BACKLIGHT_FALLOFF = 0.68;
const BACKLIGHT_CORNER = 0.45, BACKLIGHT_BLUR = 14;
const GLASS_CENTER_X = 0.6, GLASS_W = 4.4, GLASS_H = 1.7, GLASS_BOTTOM = 0.95, GLASS_FRAME_T = 0.08, GLASS_FRAME_D = 0.1;
const DOOR_CENTER_X = -3.0, DOOR_W = 1.0, DOOR_H = 2.15, DOOR_D = 0.05, DOOR_FRAME_T = 0.07, DOOR_FRAME_D = 0.09;
export const PANEL_COLOR: RGB = [40, 42, 46];
export const TRAP_COLOR: RGB = [30, 31, 34];

const srgb = (c: RGB) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
const std = (c: RGB, metalness: number, roughness: number) => new THREE.MeshStandardMaterial({ color: srgb(c), metalness, roughness });
const canvas = (w: number, h: number) => Object.assign(document.createElement('canvas'), { width: w, height: h });
function texOf(c: HTMLCanvasElement) { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }

/** Paneles acusticos 6x4 en la pared de la tele y las laterales; la tele abre su hueco en la rejilla. */
export function addPanels(walls: { mesh: THREE.Mesh; tv: boolean }[], map: THREE.Texture) {
  const mat = new THREE.MeshStandardMaterial({ map, metalness: 0, roughness: 0.95 });
  const geo = new THREE.BoxGeometry(PANEL_W, PANEL_H, PANEL_D);
  const sx = -(PANEL_COLS - 1) * PANEL_COL_SPACING_X / 2, sy = -(PANEL_ROWS - 1) * PANEL_ROW_SPACING_Y / 2;
  for (const w of walls) for (let c = 0; c < PANEL_COLS; c++) for (let r = 0; r < PANEL_ROWS; r++) {
    const px = sx + c * PANEL_COL_SPACING_X, py = sy + r * PANEL_ROW_SPACING_Y;
    if (w.tv && Math.abs(px) < (SCREEN_BEZEL_SIZE + PANEL_W) / 2 + 0.1 && Math.abs(py - SCREEN_LOCAL_Y) < (SCREEN_BEZEL_SIZE + PANEL_H) / 2 + 0.1) continue;
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, PANEL_OFFSET_Z);
    w.mesh.add(m);
  }
}

/** Pilares (trampas de graves) en las esquinas, de suelo a techo; sx/sz dicen su esquina. */
export function addTraps(scene: THREE.Scene, map: THREE.Texture) {
  const h = ROOM_CEIL_Y - ROOM_FLOOR_Y, circ = 2 * Math.PI * TRAP_RADIUS;
  const t = map.clone(); t.repeat.set(1, Math.max(1, Math.round(h / circ))); t.needsUpdate = true; // sin deformar
  const mat = new THREE.MeshStandardMaterial({ map: t, metalness: 0, roughness: 0.95 });
  const geo = new THREE.CylinderGeometry(TRAP_RADIUS, TRAP_RADIUS, h, 16, 1, true);
  const out: { mesh: THREE.Mesh; sx: number; sz: number }[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(sx * (ROOM_HALF_X - TRAP_RADIUS), (ROOM_FLOOR_Y + ROOM_CEIL_Y) / 2, sz * (ROOM_HALF_Z - TRAP_RADIUS));
    scene.add(m);
    out.push({ mesh: m, sx, sz });
  }
  return out;
}

/** Pared detras del oyente: ventana de control con 3 panos y alfeizar, y puerta a su derecha. */
export function addStudioWall(wall: THREE.Mesh) {
  const glass = new THREE.MeshStandardMaterial({ color: srgb([14, 20, 26]), metalness: 0, roughness: 0.06, envMapIntensity: 2.5 });
  const frame = std([28, 29, 32], 0.6, 0.4), door = std([70, 52, 40], 0, 0.65), handle = std([182, 184, 188], 1, 0.3);
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); wall.add(b);
  };
  const fy = WALL_LOCAL_FLOOR_Y, gb = fy + GLASS_BOTTOM, gy = gb + GLASS_H / 2, gx = GLASS_CENTER_X, t = GLASS_FRAME_T, fd = GLASS_FRAME_D;
  box(GLASS_W, GLASS_H, 0.02, gx, gy, 0.03, glass);
  box(GLASS_W + 2 * t, t, fd, gx, gy + GLASS_H / 2 + t / 2, fd / 2, frame);
  box(GLASS_W + 2 * t, t, fd, gx, gy - GLASS_H / 2 - t / 2, fd / 2, frame);
  box(t, GLASS_H, fd, gx - GLASS_W / 2 - t / 2, gy, fd / 2, frame);
  box(t, GLASS_H, fd, gx + GLASS_W / 2 + t / 2, gy, fd / 2, frame);
  box(t * 0.6, GLASS_H, fd * 0.8, gx - GLASS_W / 6, gy, fd * 0.4, frame); // parteluces
  box(t * 0.6, GLASS_H, fd * 0.8, gx + GLASS_W / 6, gy, fd * 0.4, frame);
  box(GLASS_W + 2 * t + 0.1, 0.04, 0.22, gx, gb - t - 0.02, 0.11, frame); // alfeizar
  const streaks = new THREE.Mesh(new THREE.PlaneGeometry(GLASS_W, GLASS_H), new THREE.MeshBasicMaterial({ map: texOf(glassStreaks()), transparent: true, depthWrite: false }));
  streaks.position.set(gx, gy, 0.045);
  wall.add(streaks);
  // Puerta: oyente a la derecha (mundo -X)
  const dx = DOOR_CENTER_X, dy = fy + DOOR_H / 2, dt = DOOR_FRAME_T, dfd = DOOR_FRAME_D;
  box(DOOR_W, DOOR_H, DOOR_D, dx, dy, DOOR_D / 2, door);
  box(DOOR_W + 2 * dt, dt, dfd, dx, fy + DOOR_H + dt / 2, dfd / 2, frame);
  box(dt, DOOR_H, dfd, dx - DOOR_W / 2 - dt / 2, dy, dfd / 2, frame);
  box(dt, DOOR_H, dfd, dx + DOOR_W / 2 + dt / 2, dy, dfd / 2, frame);
  box(0.22, 0.7, 0.012, dx, fy + 1.45, DOOR_D + 0.006, glass); // ventanilla
  box(0.16, 0.03, 0.03, dx + DOOR_W / 2 - 0.16, fy + 1.0, DOOR_D + 0.04, handle);
  box(0.03, 0.03, 0.04, dx + DOOR_W / 2 - 0.1, fy + 1.0, DOOR_D + 0.02, handle);
}

/** Bandas diagonales suaves + brillo arriba: la lectura clasica de "cristal". */
function glassStreaks(): HTMLCanvasElement {
  const w = 1024, h = Math.max(1, Math.round(w * GLASS_H / GLASS_W)), c = canvas(w, h), x = c.getContext('2d')!;
  const sheen = x.createLinearGradient(0, 0, 0, h * 0.6);
  sheen.addColorStop(0, 'rgba(255,255,255,0.086)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = sheen; x.fillRect(0, 0, w, h * 0.6);
  x.save(); x.transform(1, 0, -0.45, 1, 0, 0); x.translate(h * 0.45 * 0.5, 0);
  for (const [fx, bw, a] of [[0.14, 70, 40], [0.21, 22, 32], [0.58, 120, 24], [0.68, 30, 36], [0.9, 50, 22]]) {
    const cx = fx * w, g = x.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, `rgba(255,255,255,${a / 255})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(cx - bw / 2, 0, bw, h);
  }
  x.restore();
  return c;
}

/** Tele de la pared frontal: marco, caratula con titulo y artista, y luz trasera con los colores del borde. */
export class SongScreen {
  private card = canvas(CARD_PX, CARD_PX);
  private glow = canvas(BACKLIGHT_PX, BACKLIGHT_PX);
  private cardTex = texOf(this.card);
  private glowTex = texOf(this.glow);
  private token = 0;

  constructor(wall: THREE.Mesh) {
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(SCREEN_BEZEL_SIZE, SCREEN_BEZEL_SIZE, SCREEN_BEZEL_D), std([10, 10, 12], 0.05, 0.75));
    bezel.position.set(0, SCREEN_LOCAL_Y, SCREEN_BEZEL_D / 2 + 0.005);
    // Sin luz propia (unlit): se lee como luz emitida sobre la pared oscura
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(BACKLIGHT_SIZE, BACKLIGHT_SIZE), new THREE.MeshBasicMaterial({ map: this.glowTex, transparent: true, depthWrite: false, toneMapped: false }));
    glow.position.set(0, SCREEN_LOCAL_Y, BACKLIGHT_Z);
    const img = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_IMG_SIZE, SCREEN_IMG_SIZE), new THREE.MeshBasicMaterial({ map: this.cardTex, toneMapped: false }));
    img.position.set(0, SCREEN_LOCAL_Y, SCREEN_BEZEL_D + 0.02);
    wall.add(glow, bezel, img);
    this.paintCard(null, '', '');
  }

  /** Gana la ultima llamada (la portada carga en diferido). */
  async set(coverUrl: string | null, title: string, artist: string, fallback: RGB) {
    const tk = ++this.token;
    let cover: HTMLImageElement | null = null;
    if (coverUrl) cover = await new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = coverUrl; });
    try { await document.fonts.load('bold 104px "Noto Sans"'); } catch { /* sin fuentes: la del sistema */ }
    if (tk !== this.token) return;
    this.paintCard(cover, title, artist);
    this.paintGlow(cover, fallback);
  }

  /** Sin portada la luz trasera toma el acento de la sala. */
  setFallback(fallback: RGB, hasCover: boolean) { if (!hasCover) this.paintGlow(null, fallback); }

  private paintCard(cover: HTMLImageElement | null, title: string, artist: string) {
    const s = CARD_PX, x = this.card.getContext('2d')!;
    x.clearRect(0, 0, s, s);
    if (cover) {
      const side = Math.min(cover.naturalWidth, cover.naturalHeight); // recorte centrado
      x.imageSmoothingQuality = 'high';
      x.drawImage(cover, (cover.naturalWidth - side) / 2, (cover.naturalHeight - side) / 2, side, side, 0, 0, s, s);
    } else {
      const g = x.createLinearGradient(0, 0, 0, s); g.addColorStop(0, 'rgb(34,36,42)'); g.addColorStop(1, 'rgb(14,15,18)');
      x.fillStyle = g; x.fillRect(0, 0, s, s);
    }
    if (title || artist) {
      const g = x.createLinearGradient(0, s * 0.4, 0, s);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.45, 'rgba(0,0,0,.59)'); g.addColorStop(1, 'rgba(0,0,0,.88)');
      x.fillStyle = g; x.fillRect(0, s * 0.4, s, s * 0.6);
      const pad = 64, width = s - pad * 2;
      const art = fitText(x, artist, width, 64, 44, 2, ''), tit = fitText(x, title, width, 104, 68, 2, 'bold ');
      // Se apila desde abajo: artista al final, titulo encima
      let bottom = s - pad;
      const draw = (f: Fitted | null, color: string, blur: number, dy: number) => {
        if (!f) return;
        bottom -= f.lines.length * f.size * 1.17;
        x.font = f.font; x.fillStyle = color; x.textBaseline = 'top';
        x.shadowColor = 'rgba(0,0,0,.78)'; x.shadowBlur = blur; x.shadowOffsetY = dy;
        f.lines.forEach((l, i) => x.fillText(l, pad, bottom + i * f.size * 1.17));
        x.shadowColor = 'transparent';
      };
      draw(art, 'rgba(255,255,255,.88)', 6, 2);
      if (art) bottom -= 18;
      draw(tit, '#fff', 8, 3);
    }
    this.cardTex.needsUpdate = true;
  }

  /** buildBacklightBitmap: 8 colores del borde llevados a "luz", mezclados por angulo, forma de
   *  cuadrado redondeado con caida exponencial hasta 0 y desenfoque de caja 2 pasadas. */
  private paintGlow(cover: HTMLImageElement | null, fallback: RGB) {
    let cols: RGB[] = Array.from({ length: 8 }, () => fallback);
    if (cover && cover.naturalWidth >= 8) {
      const n = 96, c = canvas(n, n), x = c.getContext('2d', { willReadFrequently: true })!;
      x.drawImage(cover, 0, 0, n, n);
      const d = x.getImageData(0, 0, n, n).data, b = n / 6, t3 = n / 3;
      const avg = (l: number, tp: number, r: number, bt: number): RGB => {
        let sr = 0, sg = 0, sb = 0, k = 0;
        for (let y = Math.floor(tp); y < bt; y++) for (let xx = Math.floor(l); xx < r; xx++) { const i = (y * n + xx) * 4; sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; k++; }
        return k ? [sr / k, sg / k, sb / k] : fallback;
      };
      // Por angulo desde +X en sentido antihorario (y arriba)
      cols = [avg(n - b, t3, n, 2 * t3), avg(n - b, 0, n, b), avg(t3, 0, 2 * t3, b), avg(0, 0, b, b),
        avg(0, t3, b, 2 * t3), avg(0, n - b, b, n), avg(t3, n - b, 2 * t3, n), avg(n - b, n - b, n, n)];
    }
    cols = cols.map(asLight);
    const n = BACKLIGHT_PX, half = n / 2, tvHalf = SCREEN_BEZEL_SIZE / BACKLIGHT_SIZE * half, reach = half - tvHalf;
    const corner = BACKLIGHT_CORNER * tvHalf, inner = tvHalf - corner;
    const pa = new Float32Array(n * n), pr = new Float32Array(n * n), pg = new Float32Array(n * n), pb = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      const dy = half - (y + 0.5);
      for (let xx = 0; xx < n; xx++) {
        const dx = xx + 0.5 - half, qx = Math.abs(dx) - inner, qy = Math.abs(dy) - inner;
        const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
        const tt = out <= 0 ? 0 : out / reach;
        if (tt >= 1) continue;
        const a = BACKLIGHT_ALPHA * Math.exp(-tt / BACKLIGHT_FALLOFF) * (1 - tt) * (1 - tt);
        const ang = Math.atan2(dy, dx);
        let wr = 0, wg = 0, wb = 0, ws = 0;
        for (let k = 0; k < 8; k++) { const w = Math.exp(2.2 * Math.cos(ang - k * Math.PI / 4)); wr += w * cols[k][0]; wg += w * cols[k][1]; wb += w * cols[k][2]; ws += w; }
        const i = y * n + xx;
        pa[i] = a; pr[i] = a * wr / ws; pg[i] = a * wg / ws; pb[i] = a * wb / ws;
      }
    }
    for (let k = 0; k < 2; k++) for (const ch of [pa, pr, pg, pb]) boxBlur(ch, n, BACKLIGHT_BLUR);
    const x = this.glow.getContext('2d')!, img = x.createImageData(n, n);
    for (let i = 0; i < n * n; i++) {
      const a = pa[i];
      if (a <= 0.002) continue;
      img.data[i * 4] = pr[i] / a; img.data[i * 4 + 1] = pg[i] / a; img.data[i * 4 + 2] = pb[i] / a; img.data[i * 4 + 3] = a * 255;
    }
    x.putImageData(img, 0, 0);
    this.glowTex.needsUpdate = true;
  }
}

interface Fitted { lines: string[]; size: number; font: string }

/** fitTextLayout: el mayor tamano (paso 4 px) que cabe en maxLines; al minimo, elipsis. */
function fitText(x: CanvasRenderingContext2D, text: string, width: number, max: number, min: number, maxLines: number, weight: string): Fitted | null {
  if (!text) return null;
  const wrap = (size: number) => {
    x.font = `${weight}${size}px "Noto Sans", sans-serif`;
    const lines: string[] = [];
    let cur = '';
    for (const w of text.split(/\s+/)) {
      const tryL = cur ? `${cur} ${w}` : w;
      if (x.measureText(tryL).width <= width || !cur) cur = tryL;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  };
  for (let s = max; s > min; s -= 4) { const l = wrap(s); if (l.length <= maxLines && l.every((ln) => x.measureText(ln).width <= width)) return { lines: l, size: s, font: x.font }; }
  let l = wrap(min);
  if (l.length > maxLines || l.some((ln) => x.measureText(ln).width > width)) {
    l = l.slice(0, maxLines);
    let last = l[maxLines - 1] ?? l[l.length - 1];
    while (last.length > 1 && x.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    l[l.length - 1] = `${last.trimEnd()}…`;
  }
  return { lines: l, size: min, font: x.font };
}

function asLight(c: RGB): RGB {
  const [r, g, b] = c.map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0, l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  if (s > 0.08) s = Math.max(s, 0.45);
  l = Math.min(0.62, Math.max(0.5, l));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

function boxBlur(ch: Float32Array, n: number, r: number) {
  const tmp = new Float32Array(n * n), span = 2 * r + 1, cl = (v: number) => Math.min(n - 1, Math.max(0, v));
  for (let y = 0; y < n; y++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += ch[y * n + cl(k)];
    for (let x = 0; x < n; x++) { tmp[y * n + x] = sum / span; sum += ch[y * n + cl(x + r + 1)] - ch[y * n + cl(x - r)]; }
  }
  for (let x = 0; x < n; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[cl(k) * n + x];
    for (let y = 0; y < n; y++) { ch[y * n + x] = sum / span; sum += tmp[cl(y + r + 1) * n + x] - tmp[cl(y - r) * n + x]; }
  }
}
