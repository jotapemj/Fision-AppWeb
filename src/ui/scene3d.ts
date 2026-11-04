// Vista 3D en escena (Audio3DSceneController de Android, con three.js en vez de Filament).
// Sala 9x3.8x9 m, busto en el centro, un sprite por stem. Arrastrar = mover sobre el cilindro de
// su radio; clic = elegir; doble clic = omnipresente; pulsacion larga = mute 3D. Baile incluido.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { t } from '../i18n/i18n.ts';
import type { Player } from '../player/player.ts';
import { titleKey } from '../player/stems.ts';
import {
  azOfWorld, CHEST_Y, clampDistance, clampHeight, Dance, DANCE_SPEED_MAX, DANCE_SPEED_MIN, defaultPose, HEAD_CENTER_Y,
  MAX_DISTANCE, MIN_DISTANCE, modified, ROOM_CEIL_Y, ROOM_FLOOR_SURFACE_Y, ROOM_FLOOR_Y, ROOM_HALF_X, ROOM_HALF_Z,
  SWING_MAX, SWING_MIN, worldPos, type Pose3D,
} from '../player/audio3d.ts';
import { audio3dInfoDialog } from './info3d.ts';
import { iconOf } from './stemIcons.ts';
import { addPanels, addStudioWall, addTraps, PANEL_COLOR, SongScreen, TRAP_COLOR } from './scene3dDecor.ts';
import { sceneSpinner } from './curtain.ts';
import { danceSetupDialog, danceTabs, fillDancePanel } from './dancePanel.ts';
import { h, img, setSlider, slider } from './dom.ts';

// Camara inicial (DEF_* de Android): detras de la cabeza, mirando la pared frontal
const DEF_AZ_DEG = 179.7, DEF_PITCH_DEG = 30, DEF_DIST = 4.36, FOCAL_MM = 19.1;
const HEAD_UNITS = 1.8; // busto ~1.8 m
const SPRITE = 0.5, RING = SPRITE * 1.55, OMNI = SPRITE * 2, SHADOW = SPRITE * 1.1;
const LONG_PRESS_MS = 450, DOUBLE_MS = 300, DOUBLE_PX = 60, SLOP_PX = 6;
const LIGHT_OFF = 0.2; // 3D apagado: luces al 20 %
const HIDE_EPS = 0.05, SHOW_EPS = 0.15; // dollhouse: histeresis al cruzar paredes
const WALL_FIXTURE_CLEARANCE = 0.35; // paneles, tele, alfeizar: la pared se oculta antes de atravesarlos
const LAMP_CD = 9, AMBIENT = 0.32; // calibrado a ojo (Android usa exposicion sunny-16 de Filament)
const WARM = 0xffb46b; // ~3500 K
const ACCENT_FALLBACK = [39, 179, 151] as const;

type RGB = [number, number, number];
type DanceTab = 'speed' | 'distance' | 'swing';

interface Sprite {
  stem: string;
  main: THREE.Sprite;
  ring: THREE.Sprite;
  halo: THREE.Sprite;
  shadow: THREE.Mesh;
}

// ---------- texturas procedurales (pared = fieltro, suelo = moqueta de bucle) ----------
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
/** Ruido de valor periodico (se repite sin costuras en la textura). */
function noise(size: number, cells: number, r: () => number): Float32Array {
  const g = Array.from({ length: cells * cells }, () => r() * 2 - 1), out = new Float32Array(size * size);
  const s = (v: number) => v * v * (3 - 2 * v);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = x / size * cells, fy = y / size * cells, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = s(fx - x0), ty = s(fy - y0);
    const at = (i: number, j: number) => g[((j % cells) * cells) + (i % cells)];
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx, b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    out[y * size + x] = a + (b - a) * ty;
  }
  return out;
}
const SIZE = 256;
let feltField: Float32Array | null = null, carpetField: Float32Array | null = null;
function felt(): Float32Array {
  if (feltField) return feltField;
  const r = rng(7), f = new Float32Array(SIZE * SIZE), n1 = noise(SIZE, 8, r), n2 = noise(SIZE, 32, r), n3 = noise(SIZE, 64, r);
  for (let i = 0; i < f.length; i++) f[i] = 0.12 * n1[i] + 0.1 * n2[i] + 0.12 * n3[i] + 0.1 * (r() * 2 - 1);
  return (feltField = f);
}
let corkField: Float32Array | null = null;
/** Corcho: celdas (Worley periodico, 40 por baldosa) con huecos oscuros en los bordes + manchas + grano. */
function cork(): Float32Array {
  if (corkField) return corkField;
  const r = rng(71), cells = 40, pts: number[] = [], val: number[] = [];
  for (let i = 0; i < cells * cells; i++) { pts.push(r(), r()); val.push(r() * 2 - 1); }
  const mottle = noise(SIZE, 4, r), f = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const fx = x / SIZE * cells, fy = y / SIZE * cells, cx = Math.floor(fx), cy = Math.floor(fy);
    let d1 = 9, d2 = 9, v = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const gx = (cx + i + cells) % cells, gy = (cy + j + cells) % cells, k = gy * cells + gx;
      const d = Math.hypot(cx + i + pts[k * 2] * 0.9 - fx, cy + j + pts[k * 2 + 1] * 0.9 - fy);
      if (d < d1) { d2 = d1; d1 = d; v = val[k]; } else if (d < d2) d2 = d;
    }
    const e = d2 - d1, gap = e < 0.06 ? -0.22 * (1 - e / 0.06) : 0;
    f[y * SIZE + x] = 0.16 * v + gap + 0.05 * mottle[y * SIZE + x] + 0.05 * (r() * 2 - 1);
  }
  return (corkField = f);
}
function carpet(): Float32Array {
  if (carpetField) return carpetField;
  const r = rng(11), f = new Float32Array(SIZE * SIZE), n1 = noise(SIZE, 8, r), rows = 64, per = SIZE / rows;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    // Bucles escalonados: fila a fila desplazados medio bucle
    const row = Math.floor(y / per), lx = ((x + (row % 2) * per / 2) % per) / per, ly = (y % per) / per;
    const loop = Math.cos((lx - 0.5) * Math.PI) * Math.cos((ly - 0.5) * Math.PI);
    f[y * SIZE + x] = 0.07 * (loop * 2 - 1) + 0.05 * n1[y * SIZE + x] + 0.14 * (r() * 2 - 1);
  }
  return (carpetField = f);
}
function bake(field: Float32Array, tint: RGB, contrast: number, tex?: THREE.CanvasTexture): THREE.CanvasTexture {
  const c = (tex?.image as HTMLCanvasElement | undefined) ?? Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
  const x = c.getContext('2d')!, d = x.createImageData(SIZE, SIZE);
  for (let i = 0; i < field.length; i++) {
    const k = Math.max(0, 1 + contrast * field[i]);
    d.data[i * 4] = Math.min(255, tint[0] * k); d.data[i * 4 + 1] = Math.min(255, tint[1] * k); d.data[i * 4 + 2] = Math.min(255, tint[2] * k); d.data[i * 4 + 3] = 255;
  }
  x.putImageData(d, 0, 0);
  if (tex) { tex.needsUpdate = true; return tex; }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const mix = (a: RGB | readonly number[], b: RGB | readonly number[], k: number): RGB => [0, 1, 2].map((i) => a[i] * (1 - k) + b[i] * k) as RGB;

/** Textura con un disco radial (sombra, halo) o un aro. */
function radial(stops: [number, string][]): THREE.CanvasTexture {
  const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 }), x = c.getContext('2d')!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [o, col] of stops) g.addColorStop(o, col);
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function ringTex(rgb: RGB): THREE.CanvasTexture {
  const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 }), x = c.getContext('2d')!;
  x.strokeStyle = `rgb(${rgb.join(',')})`; x.lineWidth = 6; x.beginPath(); x.arc(64, 64, 58, 0, Math.PI * 2); x.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const haloTex = (rgb: RGB) => radial([[0, `rgba(${rgb.join(',')},.85)`], [0.45, `rgba(${rgb.join(',')},.35)`], [1, `rgba(${rgb.join(',')},0)`]]);
const shadowTex = (peak: number) => radial([[0, `rgba(0,0,0,${peak})`], [0.55, `rgba(0,0,0,${peak * 0.45})`], [1, 'rgba(0,0,0,0)']]);

function parseColor(css: string): RGB {
  const c = document.createElement('canvas').getContext('2d')!;
  c.fillStyle = '#000'; c.fillStyle = css.trim() || '#27B397';
  const v = c.fillStyle as string;
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as RGB;
  const m = v.match(/[\d.]+/g);
  return m ? [+m[0], +m[1], +m[2]] : [...ACCENT_FALLBACK];
}

export interface SongCard { cover: string | null; title: string; artist: string }

export interface Scene3DHooks {
  /** El interruptor de audio 3D cambio (pestana tintada, mezcla bloqueada). */
  onEnabled(on: boolean): void;
}

export class Scene3D {
  readonly el = h('div', { class: 'd3' });
  private p: Player;
  private hooks: Scene3DHooks;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.05, 60);
  private controls: OrbitControls | null = null;
  private sprites = new Map<string, Sprite>();
  private walls: { mesh: THREE.Mesh; axis: 'x' | 'y' | 'z'; at: number; sign: number }[] = [];
  private traps: { mesh: THREE.Mesh; sx: number; sz: number }[] = [];
  private screen: SongScreen | null = null;
  private card: SongCard;
  private wallTex: THREE.CanvasTexture | null = null;
  private ceilTex: THREE.CanvasTexture | null = null;
  private floorTex: THREE.CanvasTexture | null = null;
  private lamps: THREE.PointLight[] = [];
  private accent: RGB = [...ACCENT_FALLBACK];
  private light = 1;          // 1 = encendidas, LIGHT_OFF = 3D apagado
  private lightAnim: { from: number; to: number; t0: number; ms: number } | null = null;
  private selected: string | null = null;
  private dance = new Dance();
  private randomSwing = false;
  private danceTab: DanceTab = 'speed';
  private swingStem: string | null = null;
  private resetAnim: { from: Map<string, Pose3D>; t0: number } | null = null;
  private dirty = true;
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver | null = null;
  private mo: MutationObserver | null = null;
  private drag: { stem: string; id: number; ox: number; oy: number; x0: number; y0: number; moved: boolean; long: boolean; timer: number } | null = null;
  private lastUp = { t: 0, x: 0, y: 0, stem: '' };
  // chrome
  private canvasBox = h('div', { class: 'd3c' });
  private veil = h('div', { class: 'd3veil' });
  private loading = sceneSpinner(t('web_3d_loading'));
  private sw = h('button', { class: 'switch', attrs: { role: 'switch', 'aria-label': t('audio3d_title') } });
  private dist = slider(MIN_DISTANCE, MAX_DISTANCE, 0.05, 1.5, t('stems_dance_distance'));
  private distTip = h('span', { class: 'd3tip' });
  private tipTimer = 0;
  private resetBtn = h('button', { class: 'd3btn', attrs: { 'aria-label': t('web_3d_reset'), title: t('web_3d_reset') } });
  private danceBtn = h('button', { class: 'd3btn', attrs: { 'aria-label': t('stems_dance_title'), title: t('stems_dance_title') } });
  private panel = h('div', { class: 'd3panel', hidden: true });

  constructor(p: Player, card: SongCard, hooks: Scene3DHooks) {
    this.p = p; this.hooks = hooks; this.card = card;
    this.buildChrome();
    (this.el as HTMLElement & { scene3d?: Scene3D }).scene3d = this; // acceso de las pruebas
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      this.canvasBox.append(h('p', { class: 'soon', textContent: t('web_3d_unavailable') }));
      return;
    }
    const r = this.renderer;
    r.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.canvasBox.prepend(r.domElement);
    this.scene.background = new THREE.Color(0x000000);
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
    this.camera.filmGauge = 35;
    this.camera.setFocalLength(FOCAL_MM);
    this.placeCamera();
    const c = new OrbitControls(this.camera, r.domElement);
    c.target.set(0, HEAD_CENTER_Y, 0);
    c.enablePan = false;          // el objetivo queda en el oyente
    c.rotateSpeed = 0.6; c.zoomSpeed = 0.8;
    c.minDistance = 0.8; c.maxDistance = 14;
    c.addEventListener('change', () => (this.dirty = true));
    c.update();
    this.controls = c;
    this.accent = this.readAccent();
    this.buildRoom();
    this.buildLights();
    this.buildSprites();
    void this.loadHead();
    this.bindPointer(r.domElement);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvasBox);
    this.setLights(p.audio3d, 0);
    this.syncControls();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Para las pruebas: donde se ve un stem (px de cliente) y su pose. */
  probe(stem: string) {
    const sp = this.sprites.get(stem);
    if (!sp || !this.renderer) return null;
    return { ...this.screenOf(sp.main.position, this.renderer.domElement.getBoundingClientRect()), pose: { ...this.p.poses.get(stem)! }, dancing: this.dance.active };
  }

  /** El acento puede cambiar (colores de la cancion, ajustes): sala, aro y halo se rehornean. */
  watchAccent(host: HTMLElement) {
    this.mo?.disconnect();
    this.mo = new MutationObserver(() => this.applyAccent());
    this.mo.observe(host, { attributes: true, attributeFilter: ['style'] });
    this.applyAccent();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    if (this.dance.active) this.stopDance();
    this.ro?.disconnect(); this.mo?.disconnect();
    this.controls?.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mt of mats) { (mt as THREE.MeshStandardMaterial).map?.dispose(); mt.dispose(); }
    });
    this.scene.environment?.dispose();
    this.renderer?.dispose();
  }

  // ---------------- construccion ----------------

  private buildChrome() {
    const info = h('button', { class: 'd3i', textContent: 'i', attrs: { 'aria-label': t('audio3d_info_title') } });
    info.onclick = () => this.infoDialog();
    this.sw.onclick = () => this.setEnabled(!this.p.audio3d);
    const head = h('div', { class: 'd3head' }, h('b', { textContent: t('audio3d_title') }), info, h('span', { class: 'sp' }), this.sw);
    this.dist.classList.add('vsl');
    this.dist.addEventListener('input', () => {
      const s = this.selected;
      if (!s) return;
      const d = clampDistance(+this.dist.value);
      if (this.dance.active && this.dance.ids.has(s)) this.dance.setDistance(d, this.p.poses);
      this.p.setPose(s, { rh: d, placed: true }, false);
      this.place(s);
      this.tip(`${d.toFixed(2)} m`);
    });
    this.dist.addEventListener('change', () => this.p.onChange?.());
    const side = h('div', { class: 'd3side' }, this.distTip, this.dist);
    this.resetBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 12c0-1.1-.9-2-2-2s-2 .9-2 2 .9 2 2 2 2-.9 2-2zM12 3c-4.97 0-9 4.03-9 9H0l4 4 4-4H5c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.51 0-2.91-.49-4.06-1.3l-1.42 1.44C8.04 20.3 9.94 21 12 21c4.97 0 9-4.03 9-9s-4.03-9-9-9z"/></svg>'; // ic_restore_pan
    this.resetBtn.onclick = () => this.reset();
    this.danceBtn.onclick = () => (this.dance.active ? this.stopDance() : this.danceDialog());
    const btns = h('div', { class: 'd3btns' }, this.danceBtn, this.resetBtn);
    const bottom = h('div', { class: 'd3bottom' }, h('span', { class: 'sp' }), this.panel, btns);
    this.el.append(this.canvasBox, this.veil, h('div', { class: 'd3chrome' }, head, side, bottom), this.loading.el);
  }

  private buildRoom() {
    const W = ROOM_HALF_X * 2, D = ROOM_HALF_Z * 2, H = ROOM_CEIL_Y - ROOM_FLOOR_Y;
    const wallM = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    const ceilM = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    const floorM = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0 });
    this.bakeRoom(wallM, ceilM, floorM);
    const plane = (w: number, hh: number, mat: THREE.Material, tile: number) => {
      const g = new THREE.PlaneGeometry(w, hh);
      // Baldosa en metros: escalar UV por el tamano del plano
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / tile, uv.getY(i) * hh / tile);
      return new THREE.Mesh(g, mat);
    };
    const cy = (ROOM_FLOOR_Y + ROOM_CEIL_Y) / 2;
    // Cuatro paredes mirando hacia dentro; cada una sabe en que plano se oculta (dollhouse)
    // Las paredes llevan objetos hacia dentro: se ocultan WALL_FIXTURE_CLEARANCE antes de su plano
    const add = (m: THREE.Mesh, axis: 'x' | 'y' | 'z', at: number, sign: number) => {
      this.scene.add(m);
      this.walls.push({ mesh: m, axis, at: axis === 'y' ? at : at - sign * WALL_FIXTURE_CLEARANCE, sign });
    };
    const front = plane(W, H, wallM, 1.26); front.position.set(0, cy, ROOM_HALF_Z); front.rotation.y = Math.PI; add(front, 'z', ROOM_HALF_Z, 1);
    const back = plane(W, H, wallM, 1.26); back.position.set(0, cy, -ROOM_HALF_Z); add(back, 'z', -ROOM_HALF_Z, -1);
    const left = plane(D, H, wallM, 1.26); left.position.set(ROOM_HALF_X, cy, 0); left.rotation.y = -Math.PI / 2; add(left, 'x', ROOM_HALF_X, 1);
    const right = plane(D, H, wallM, 1.26); right.position.set(-ROOM_HALF_X, cy, 0); right.rotation.y = Math.PI / 2; add(right, 'x', -ROOM_HALF_X, -1);
    const ceil = plane(W, D, ceilM, 1.26); ceil.position.set(0, ROOM_CEIL_Y, 0); ceil.rotation.x = Math.PI / 2; add(ceil, 'y', ROOM_CEIL_Y, 1);
    const floor = plane(W, D, floorM, 1.15); floor.position.set(0, ROOM_FLOOR_SURFACE_Y, 0); floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    // Decoracion: paneles en la pared de la tele y laterales, pilares, tele, ventana y puerta
    const panelTex = bake(cork(), PANEL_COLOR, 0.44), trapTex = bake(cork(), TRAP_COLOR, 0.44);
    addPanels([{ mesh: front, tv: true }, { mesh: left, tv: false }, { mesh: right, tv: false }], panelTex);
    this.traps = addTraps(this.scene, trapTex);
    addStudioWall(back);
    this.screen = new SongScreen(front);
    void this.screen.set(this.card.cover, this.card.title, this.card.artist, this.accent).then(() => (this.dirty = true));
  }

  /** Tinte de la sala: pared = gris + 46 % de acento, techo 16 % mas oscuro, suelo casi negro + 18 %. */
  private bakeRoom(wallM?: THREE.MeshStandardMaterial, ceilM?: THREE.MeshStandardMaterial, floorM?: THREE.MeshStandardMaterial) {
    const wall = mix([43, 45, 51], this.accent, 0.46), ceil = wall.map((v) => v * 0.84) as RGB, floor = mix([15, 15, 17], this.accent, 0.18);
    this.wallTex = bake(felt(), wall, 0.43, this.wallTex ?? undefined);
    this.ceilTex = bake(felt(), ceil, 0.43, this.ceilTex ?? undefined);
    this.floorTex = bake(carpet(), floor, 2.52, this.floorTex ?? undefined);
    this.wallTex.rotation = 132 * Math.PI / 180; this.ceilTex.rotation = this.wallTex.rotation; this.floorTex.rotation = 21 * Math.PI / 180;
    if (wallM) wallM.map = this.wallTex;
    if (ceilM) ceilM.map = this.ceilTex;
    if (floorM) floorM.map = this.floorTex;
  }

  private buildLights() {
    // Cuatro lamparas de techo calidas en las esquinas (configureSceneLighting)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const l = new THREE.PointLight(WARM, LAMP_CD, 0, 2);
      l.position.set(sx * ROOM_HALF_X * 0.72, ROOM_CEIL_Y - 0.3, sz * ROOM_HALF_Z * 0.72);
      this.scene.add(l); this.lamps.push(l);
    }
  }

  private async loadHead() {
    try {
      const gltf = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/head.glb`);
      const head = gltf.scene;
      const box = new THREE.Box3().setFromObject(head), size = box.getSize(new THREE.Vector3());
      const k = HEAD_UNITS / Math.max(size.x, size.y, size.z);
      head.scale.setScalar(k);
      // Sentado sobre el suelo, sin depender del pivote del GLB
      head.position.set(-(box.min.x + size.x / 2) * k, ROOM_FLOOR_SURFACE_Y - box.min.y * k, -(box.min.z + size.z / 2) * k);
      this.scene.add(head);
      // Sombra propia: sin ella el busto flota (no hay shadow mapping)
      const d = (size.x / 2 + size.z / 2) * k * 2;
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(d, d), new THREE.MeshBasicMaterial({ map: shadowTex(140 / 255), transparent: true, depthWrite: false }));
      sh.rotation.x = -Math.PI / 2; sh.position.y = ROOM_FLOOR_SURFACE_Y + 0.01;
      this.scene.add(sh);
    } catch (e) {
      console.warn('head.glb', e);
    }
    this.dirty = true;
    this.loading.finish();
  }

  private buildSprites() {
    const v2 = this.p.hasVocals2, loader = new THREE.TextureLoader();
    const ring = ringTex(this.accent), halo = haloTex(this.accent);
    for (const s of this.p.stems) {
      const map = loader.load(iconOf(s.stem, v2), () => (this.dirty = true));
      map.colorSpace = THREE.SRGBColorSpace;
      const main = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }));
      main.scale.setScalar(SPRITE); main.renderOrder = 3;
      const rg = new THREE.Sprite(new THREE.SpriteMaterial({ map: ring, transparent: true, depthWrite: false }));
      rg.scale.setScalar(RING); rg.renderOrder = 2; rg.visible = false;
      const hl = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo, transparent: true, depthWrite: false }));
      hl.scale.setScalar(OMNI); hl.renderOrder = 1; hl.visible = false;
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex(1), transparent: true, depthWrite: false }));
      sh.rotation.x = -Math.PI / 2;
      main.userData.stem = s.stem;
      this.scene.add(hl, rg, main, sh);
      this.sprites.set(s.stem, { stem: s.stem, main, ring: rg, halo: hl, shadow: sh });
      this.place(s.stem);
    }
  }

  // ---------------- estado -> escena ----------------

  private place(stem: string) {
    const sp = this.sprites.get(stem), pose = this.p.poses.get(stem);
    if (!sp || !pose) return;
    const w = worldPos({ ...pose, h: clampHeight(pose.h) }); // una elevacion de la vista plana puede pasar del techo
    sp.main.position.set(w.x, w.y, w.z);
    sp.ring.position.copy(sp.main.position); sp.halo.position.copy(sp.main.position);
    sp.halo.visible = pose.omni;
    sp.main.material.color.setScalar(pose.muted ? 0.35 : 1);
    sp.ring.visible = this.selected === stem;
    // Sombra: crece y se difumina con la altura (luz de techo)
    const k = Math.min(1, Math.max(0, w.y - ROOM_FLOOR_SURFACE_Y) / 4);
    sp.shadow.position.set(w.x, ROOM_FLOOR_SURFACE_Y + 0.015, w.z);
    sp.shadow.scale.setScalar(SHADOW * (1 + 1.2 * k));
    (sp.shadow.material as THREE.MeshBasicMaterial).opacity = (170 - 125 * k) / 255;
    this.dirty = true;
  }

  private placeAll() { for (const s of this.sprites.keys()) this.place(s); }

  private readAccent(): RGB {
    return parseColor(getComputedStyle(this.el.isConnected ? this.el : document.documentElement).getPropertyValue('--accent'));
  }

  private applyAccent() {
    const a = this.readAccent();
    if (a.every((v, i) => v === this.accent[i])) return;
    this.accent = a;
    this.bakeRoom();
    this.screen?.setFallback(a, !!this.card.cover);
    const ring = ringTex(a), halo = haloTex(a);
    for (const sp of this.sprites.values()) {
      sp.ring.material.map?.dispose(); sp.ring.material.map = ring;
      sp.halo.material.map?.dispose(); sp.halo.material.map = halo;
    }
    this.dirty = true;
  }

  private setEnabled(on: boolean) {
    this.p.set3DEnabled(on);
    this.setLights(on, 260);
    this.syncControls();
    this.hooks.onEnabled(on);
  }

  /** Luces: 1 con 3D, 0.2 sin el (animado). La escena queda inerte con el 3D apagado. */
  private setLights(on: boolean, ms: number) {
    const to = on ? 1 : LIGHT_OFF;
    this.lightAnim = ms ? { from: this.light, to, t0: performance.now(), ms } : null;
    if (!ms) this.applyLight(to);
    this.veil.classList.toggle('on', !on);
    if (this.controls) this.controls.enabled = on;
  }

  private applyLight(v: number) {
    this.light = v;
    for (const l of this.lamps) l.intensity = LAMP_CD * v;
    this.scene.environmentIntensity = AMBIENT * v;
    this.dirty = true;
  }

  private syncControls() {
    const on = this.p.audio3d;
    this.sw.setAttribute('aria-checked', String(on));
    this.dist.disabled = !on || !this.selected;
    this.danceBtn.disabled = !on; this.resetBtn.disabled = !on;
    this.panel.classList.toggle('off', !on);
    this.panel.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach((c) => (c.disabled = !on));
    if (this.selected) setSlider(this.dist, this.p.poses.get(this.selected)!.rh);
    this.danceBtn.innerHTML = this.dance.active
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z" fill="currentColor"/></svg>' // ic_stop
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>'; // ic_play
    this.danceBtn.setAttribute('aria-label', this.dance.active ? t('web_3d_stop_dance') : t('stems_dance_title'));
    // Reset solo si hay algo que devolver al semicirculo
    this.resetBtn.hidden = ![...this.p.poses.values()].some(modified);
  }

  private select(stem: string | null) {
    const prev = this.selected;
    this.selected = stem;
    if (prev) this.place(prev);
    if (stem) {
      this.place(stem);
      if (this.dance.swingIds.has(stem)) { this.swingStem = stem; this.renderPanel(); }
    }
    this.syncControls();
  }

  private tip(text: string) {
    this.distTip.textContent = text;
    this.distTip.classList.add('show');
    clearTimeout(this.tipTimer);
    this.tipTimer = window.setTimeout(() => this.distTip.classList.remove('show'), 700);
  }

  // ---------------- camara y render ----------------

  private placeCamera() {
    const az = DEF_AZ_DEG * Math.PI / 180, pi = DEF_PITCH_DEG * Math.PI / 180, r = DEF_DIST;
    this.camera.position.set(r * Math.cos(pi) * Math.sin(az), HEAD_CENTER_Y + r * Math.sin(pi), r * Math.cos(pi) * Math.cos(az));
    this.camera.lookAt(0, HEAD_CENTER_Y, 0);
  }

  private resize() {
    const r = this.renderer, w = this.canvasBox.clientWidth, hh = this.canvasBox.clientHeight;
    if (!r || !w || !hh) return;
    r.setSize(w, hh, false);
    this.camera.aspect = w / hh;
    // En vertical, la lente de Filament (sensor de 24 mm en alto) = la de Android; en horizontal, 35 mm en el lado largo
    this.camera.filmGauge = w < hh ? 24 : 35;
    this.camera.setFocalLength(FOCAL_MM); // la lente fija el campo con el nuevo aspecto
    this.dirty = true;
  }

  /** Suelo duro a la altura del pecho (conserva distancia y azimut); paredes y techo se ocultan al cruzarlas. */
  private bounds() {
    const c = this.controls;
    if (!c) return;
    const r = this.camera.position.distanceTo(c.target);
    const cosMax = Math.max(-1, Math.min(1, (CHEST_Y - c.target.y) / r));
    c.maxPolarAngle = Math.acos(cosMax);
    const cam = this.camera.position;
    for (const w of this.walls) {
      const v = w.axis === 'x' ? cam.x : w.axis === 'y' ? cam.y : cam.z;
      const out = (v - w.at) * w.sign; // > 0 = la camara esta fuera de esa pared
      if (w.mesh.visible && out > HIDE_EPS) w.mesh.visible = false;
      else if (!w.mesh.visible && out < -SHOW_EPS) w.mesh.visible = true;
    }
    // Un pilar se oculta si cae cualquiera de sus dos paredes (si no, flota en el aire)
    const wallAt = (axis: 'x' | 'z', sign: number) => this.walls.find((w) => w.axis === axis && w.sign === sign)?.mesh.visible ?? true;
    for (const t of this.traps) t.mesh.visible = wallAt('x', t.sx) && wallAt('z', t.sz);
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0;
    this.last = now;
    if (this.lightAnim) {
      const a = this.lightAnim, k = Math.min(1, (now - a.t0) / a.ms);
      this.applyLight(a.from + (a.to - a.from) * k);
      if (k >= 1) this.lightAnim = null;
    }
    if (this.dance.active && dt > 0) {
      const grabbed = this.drag?.moved ? this.drag.stem : null;
      for (const s of this.dance.tick(dt, this.p.poses, grabbed)) { this.p.setPose(s, {}, false); this.place(s); }
    }
    if (this.resetAnim) this.stepReset(now);
    if (!this.renderer || !this.el.isConnected || !this.dirty) return;
    this.dirty = false;
    this.controls?.update();
    this.bounds();
    // Aro y halo un pelo detras del icono (billboards en el mismo plano)
    for (const sp of this.sprites.values()) {
      const dir = sp.main.position.clone().sub(this.camera.position).normalize();
      sp.ring.position.copy(sp.main.position).addScaledVector(dir, 0.02);
      sp.halo.position.copy(sp.main.position).addScaledVector(dir, 0.04);
    }
    this.renderer.render(this.scene, this.camera);
  };

  // ---------------- gestos ----------------

  private screenOf(v: THREE.Vector3, rect: DOMRect) {
    const p = v.clone().project(this.camera);
    return { x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height, behind: p.z > 1 };
  }

  /** Sprite bajo el puntero: el mas cercano dentro de su radio en pantalla (minimo 32 px). */
  private pick(x: number, y: number): string | null {
    const rect = this.renderer!.domElement.getBoundingClientRect();
    let best: string | null = null, bestD = Infinity;
    const tanHalf = Math.tan(this.camera.fov * Math.PI / 360);
    for (const sp of this.sprites.values()) {
      const s = this.screenOf(sp.main.position, rect);
      if (s.behind) continue;
      const d = sp.main.position.distanceTo(this.camera.position);
      const rpx = Math.max(32, SPRITE / 2 / (d * tanHalf) * rect.height / 2 * 1.2);
      const dd = Math.hypot(s.x - x, s.y - y);
      if (dd < rpx && dd < bestD) { best = sp.stem; bestD = dd; }
    }
    return best;
  }

  private bindPointer(cv: HTMLCanvasElement) {
    cv.addEventListener('pointerdown', (e) => {
      if (!this.p.audio3d || e.button !== 0) return;
      const stem = this.pick(e.clientX, e.clientY);
      if (!stem) return;
      e.stopImmediatePropagation(); // el orbit no arranca
      cv.setPointerCapture(e.pointerId);
      const s = this.screenOf(this.sprites.get(stem)!.main.position, cv.getBoundingClientRect());
      this.drag = { stem, id: e.pointerId, ox: e.clientX - s.x, oy: e.clientY - s.y, x0: e.clientX, y0: e.clientY, moved: false, long: false,
        timer: window.setTimeout(() => {
          // Pulsacion larga sin mover = mute 3D (no toca el volumen)
          if (!this.drag || this.drag.moved) return;
          this.drag.long = true;
          const pose = this.p.poses.get(stem)!;
          this.p.setPose(stem, { muted: !pose.muted });
          this.place(stem); this.syncControls();
        }, LONG_PRESS_MS) };
      if (this.controls) this.controls.enabled = false;
    }, { capture: true });
    cv.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) <= SLOP_PX) return;
      if (!d.moved) { d.moved = true; clearTimeout(d.timer); this.select(d.stem); }
      this.dragTo(d.stem, e.clientX - d.ox, e.clientY - d.oy, e.movementX, e.movementY);
    });
    const up = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      clearTimeout(d.timer);
      this.drag = null;
      if (this.controls) this.controls.enabled = this.p.audio3d;
      if (d.moved) { this.p.onChange?.(); this.syncControls(); return; }
      if (d.long) return;
      const now = performance.now(), lu = this.lastUp;
      if (lu.stem === d.stem && now - lu.t < DOUBLE_MS && Math.hypot(e.clientX - lu.x, e.clientY - lu.y) < DOUBLE_PX) {
        // Doble clic = omnipresente
        this.lastUp.stem = '';
        this.p.setPose(d.stem, { omni: !this.p.poses.get(d.stem)!.omni });
        this.place(d.stem); this.syncControls();
        return;
      }
      this.lastUp = { t: now, x: e.clientX, y: e.clientY, stem: d.stem };
      this.select(d.stem);
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }

  /** Arrastre: el rayo del puntero contra el cilindro del radio del stem -> azimut y altura. */
  private dragTo(stem: string, x: number, y: number, mx: number, my: number) {
    const pose = this.p.poses.get(stem)!, rect = this.renderer!.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), this.camera);
    const o = ray.ray.origin, dv = ray.ray.direction, r = pose.rh;
    const a = dv.x * dv.x + dv.z * dv.z, b = 2 * (o.x * dv.x + o.z * dv.z), c = o.x * o.x + o.z * o.z - r * r, disc = b * b - 4 * a * c;
    let az = pose.az, hh = pose.h;
    if (a > 1e-9 && disc >= 0) {
      // De los dos cortes, el mas cercano al sprite actual (continuidad delante/detras)
      const cur = worldPos(pose);
      let best: THREE.Vector3 | null = null, bd = Infinity;
      for (const tt of [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)]) {
        if (tt <= 0) continue;
        const pt = o.clone().addScaledVector(dv, tt), dd = Math.hypot(pt.x - cur.x, pt.z - cur.z);
        if (dd < bd) { bd = dd; best = pt; }
      }
      if (best) { az = azOfWorld(best.x, best.z); hh = best.y - HEAD_CENTER_Y; }
    } else {
      // Fallback: delta de pantalla
      az -= mx * 0.006; hh -= my * 0.003;
    }
    this.p.setPose(stem, { az, h: clampHeight(hh), placed: true, fr: 1 }, false); // la escena guarda x/y unitarios (como Android)
    this.place(stem);
  }

  // ---------------- reset ----------------

  /** Vuelta al semicirculo frontal: cascada de 60 ms, 700 ms por sprite; limpia omni y mute. */
  private reset() {
    if (this.dance.active) this.stopDance();
    const from = new Map<string, Pose3D>();
    for (const [k, v] of this.p.poses) from.set(k, { ...v });
    this.resetAnim = { from, t0: performance.now() };
    this.p.stems.forEach((s) => this.p.setPose(s.stem, { omni: false, muted: false }, false));
  }

  private stepReset(now: number) {
    const a = this.resetAnim!, n = this.p.stems.length;
    let done = true;
    this.p.stems.forEach((s, i) => {
      const k = Math.min(1, Math.max(0, (now - a.t0 - i * 60) / 700)), e = 1 - Math.pow(1 - k, 3);
      if (k < 1) done = false;
      const f = a.from.get(s.stem)!, to = defaultPose(i, n);
      let dAz = to.az - f.az;
      dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz)); // por el camino corto
      this.p.setPose(s.stem, { az: f.az + dAz * e, h: f.h + (to.h - f.h) * e, rh: f.rh + (to.rh - f.rh) * e, fr: f.fr + (to.fr - f.fr) * e, placed: k < 1 }, false);
      this.place(s.stem);
    });
    if (done) { this.resetAnim = null; this.p.onChange?.(); this.syncControls(); }
  }

  // ---------------- baile ----------------

  private danceDialog() {
    danceSetupDialog(this.p, new Set(this.p.stems.map((s) => s.stem)), this.dance.swingIds, this.randomSwing, (ids, swing, random) => {
      this.randomSwing = random;
      this.dance.start(this.p.poses, ids, swing, random);
      this.swingStem = [...this.dance.swingIds][0] ?? null;
      this.danceTab = 'speed';
      this.renderPanel();
      this.syncControls();
    });
  }

  private stopDance() {
    this.dance.stop();
    for (const s of this.p.stems) this.p.setPose(s.stem, {}, false);
    this.p.onChange?.(); // se guarda donde quedo cada stem
    this.renderPanel();
    this.syncControls();
  }

  /** Panel del baile: pestanas Velocidad / Distancia / Swing; slider + valor con unidad. */
  private renderPanel(fromTab: DanceTab | null = null) {
    this.panel.hidden = !this.dance.active;
    if (!this.dance.active) { this.panel.replaceChildren(); return; }
    const hasSwing = this.dance.swingIds.size > 0;
    if (!hasSwing && this.danceTab === 'swing') this.danceTab = 'speed';
    const tabsDef: [DanceTab, string][] = [['speed', t('stems_dance_speed')], ['distance', t('stems_dance_distance')]];
    if (hasSwing) tabsDef.push(['swing', t('dance_tab_swing')]);
    const tabs = danceTabs(tabsDef, this.danceTab, fromTab, (k) => { const from = this.danceTab; this.danceTab = k; this.renderPanel(from); });
    const val = h('span', { class: 'fxv' });
    let row: HTMLElement;
    if (this.danceTab === 'speed') {
      const r = slider(DANCE_SPEED_MIN, DANCE_SPEED_MAX, 0.01, this.dance.speed, t('stems_dance_speed'));
      const sync = () => (val.textContent = t('dance_value_speed', this.dance.speed.toFixed(2)));
      r.addEventListener('input', () => { this.dance.speed = +r.value; sync(); });
      sync(); row = h('div', { class: 'drow' }, r, val);
    } else if (this.danceTab === 'distance') {
      const r = slider(MIN_DISTANCE, MAX_DISTANCE, 0.05, this.dance.distance, t('stems_dance_distance'));
      const sync = () => (val.textContent = `${this.dance.distance.toFixed(2)} m`);
      r.addEventListener('input', () => { this.dance.setDistance(+r.value, this.p.poses); this.placeAll(); if (this.selected) setSlider(this.dist, this.p.poses.get(this.selected)!.rh); sync(); });
      sync(); row = h('div', { class: 'drow' }, r, val);
    } else {
      const ids = [...this.dance.swingIds];
      if (!this.swingStem || !this.dance.swingIds.has(this.swingStem)) this.swingStem = ids[0];
      const stem = this.swingStem!, v2 = this.p.hasVocals2;
      const r = slider(SWING_MIN, SWING_MAX, 0.05, this.dance.hz(stem), t('stems_dance_osc_speed'));
      const sync = () => (val.textContent = `${this.dance.hz(stem).toFixed(2)} Hz`);
      r.addEventListener('input', () => { this.dance.setHz(stem, +r.value); sync(); });
      // Icono del stem del swing: clic = siguiente stem con swing
      const who = h('button', { class: 'dwho', attrs: { 'aria-label': t(titleKey(stem, v2)) || stem, title: t(titleKey(stem, v2)) || stem } }, img(iconOf(stem, v2), 's', ''));
      who.onclick = () => { this.swingStem = ids[(ids.indexOf(stem) + 1) % ids.length]; this.select(this.swingStem); this.renderPanel(); };
      sync(); row = h('div', { class: 'drow' }, who, r, val);
    }
    fillDancePanel(this.panel, tabs, row);
  }

  private infoDialog() { audio3dInfoDialog(true); }
}
