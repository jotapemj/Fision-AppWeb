// Audio 3D en escena (audio3d.md, Audio3DSceneController + PlayerActivity). Sin DOM ni three.js.
// Pose cilindrica: azimut del MOTOR (0 frente, +pi/2 oido derecho), altura h (m) sobre el
// centro de la cabeza y radio horizontal rh. El motor recibe esfericas (elevacion y distancia real).

export const ROOM_HALF_X = 4.5, ROOM_HALF_Z = 4.5, ROOM_FLOOR_Y = -1.4, ROOM_CEIL_Y = 2.4;
export const ROOM_FLOOR_SURFACE_Y = ROOM_FLOOR_Y + 0.06;
export const CHEST_Y = ROOM_FLOOR_SURFACE_Y + 1.2; // la camara no baja de aqui
export const HEAD_CENTER_Y = 0.15; // altura de las orejas: centro de las orbitas y objetivo de la camara
export const H_MIN_M = (ROOM_FLOOR_Y + 0.2) - HEAD_CENTER_Y;
export const H_MAX_M = (ROOM_CEIL_Y - 0.2) - HEAD_CENTER_Y;
export const MIN_DISTANCE = 0.3, MAX_DISTANCE = 3.0, DEFAULT_DISTANCE = 1.5;
export const DANCE_SPEED_MIN = 0.02, DANCE_SPEED_MAX = 0.4, DANCE_SPEED_DEFAULT = 0.15; // vueltas/s
export const SWING_MIN = 0.1, SWING_MAX = 2.0, SWING_DEFAULT = 0.5; // Hz
export const DANCE_SINE_AMP = 0.6;

export interface Pose3D {
  az: number;      // azimut del motor (rad)
  h: number;       // altura (m) respecto a HEAD_CENTER_Y
  rh: number;      // radio horizontal (m)
  omni: boolean;   // omnipresente (doble clic)
  muted: boolean;  // mute 3D (pulsacion larga); no toca el volumen
  placed: boolean; // false = hueco del semicirculo frontal (x/y sin guardar)
}

/** Lo que se guarda por stem (StemSettingsCodec): x/y en convencion motor, e grados, d radio horizontal. */
export interface Saved3D { x?: number; y?: number; e?: number; d?: number; o?: boolean; m?: boolean }

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Hueco i de n en el semicirculo frontal (-pi/2..pi/2). */
export const slotAz = (i: number, n: number) => -Math.PI / 2 + Math.PI * (n > 1 ? i / (n - 1) : 0.5);
export const clampHeight = (h: number) => clamp(h, H_MIN_M, H_MAX_M);
export const clampDistance = (d: number) => clamp(d, MIN_DISTANCE, MAX_DISTANCE);

export const elevRad = (p: Pick<Pose3D, 'h' | 'rh'>) => Math.atan2(p.h, p.rh);
/** Distancia esferica: la atenuacion y la HRTF necesitan el radio 3D real. */
export const sphericalDist = (p: Pick<Pose3D, 'h' | 'rh'>) => p.rh / Math.max(0.05, Math.cos(elevRad(p)));

export function defaultPose(i: number, n: number): Pose3D {
  return { az: slotAz(i, n), h: 0, rh: DEFAULT_DISTANCE, omni: false, muted: false, placed: false };
}

/** Pose guardada -> pose; lo que falte cae al default (sceneEngineAzimuth / sceneHorizontalDistance). */
export function fromSaved(s: Saved3D | undefined, i: number, n: number): Pose3D {
  const p = defaultPose(i, n);
  if (!s) return p;
  if (fin(s.x) && fin(s.y) && (s.x !== 0 || s.y !== 0)) { p.az = Math.atan2(s.x, -s.y); p.placed = true; }
  if (fin(s.d)) p.rh = clampDistance(s.d);
  const e = fin(s.e) ? clamp(s.e, -89, 89) : 0;
  p.h = clampHeight(p.rh * Math.tan(e * Math.PI / 180));
  p.omni = s.o === true; p.muted = s.m === true;
  return p;
}

export function toSaved(p: Pose3D): Saved3D {
  const s: Saved3D = {};
  if (p.placed) { s.x = Math.sin(p.az); s.y = -Math.cos(p.az); s.d = p.rh; }
  else if (p.rh !== DEFAULT_DISTANCE) s.d = p.rh;
  const e = elevRad(p) * 180 / Math.PI;
  if (Math.abs(e) > 0.001) s.e = e;
  if (p.omni) s.o = true;
  if (p.muted) s.m = true;
  return s;
}

/** Hay algo que resetear (has3DModifications). */
export const modified = (p: Pose3D) => p.placed || p.h !== 0 || p.rh !== DEFAULT_DISTANCE || p.omni || p.muted;

/** Posicion en el mundo. El oyente mira a +Z; la camara empieza detras (en -Z) y su derecha es -X,
 *  asi que el oido derecho (+pi/2) cae en -X: lo que se ve a la derecha suena a la derecha. */
export function worldPos(p: Pick<Pose3D, 'az' | 'h' | 'rh'>) {
  return { x: -p.rh * Math.sin(p.az), y: HEAD_CENTER_Y + p.h, z: p.rh * Math.cos(p.az) };
}

/** Inversa: azimut del motor de un punto del mundo. */
export const azOfWorld = (x: number, z: number) => Math.atan2(-x, z);

/** Baile (Audio3DSceneController.startDance / tickDance): orbita a velocidad propia, no al tempo. */
export class Dance {
  active = false;
  speed = DANCE_SPEED_DEFAULT;
  distance = DEFAULT_DISTANCE;
  readonly ids = new Set<string>();
  readonly swingIds = new Set<string>();
  readonly swingHz = new Map<string, number>(); // por stem; sobrevive entre bailes
  private factor = new Map<string, number>();
  private phase = new Map<string, number>();

  /** rnd: [0,1). Cada stem gira a 0.7..1.3 x la velocidad para no moverse en bloque. */
  start(poses: Map<string, Pose3D>, ids: Iterable<string>, swing: Iterable<string>, randomSwing: boolean, rnd: () => number = Math.random) {
    this.ids.clear(); this.swingIds.clear(); this.factor.clear(); this.phase.clear();
    for (const id of swing) this.swingIds.add(id);
    for (const id of ids) {
      const p = poses.get(id);
      if (!p) continue;
      this.ids.add(id);
      this.factor.set(id, 0.7 + rnd() * 0.6);
      p.rh = this.distance; p.placed = true;
      // Fase 0: la onda arranca en la linea media; aleatoria: desfasadas
      this.phase.set(id, randomSwing ? rnd() * 2 * Math.PI : 0);
    }
    this.active = this.ids.size > 0;
  }

  stop() { this.active = false; this.ids.clear(); this.swingIds.clear(); this.phase.clear(); }

  setDistance(d: number, poses: Map<string, Pose3D>) {
    this.distance = clampDistance(d);
    if (this.active) for (const id of this.ids) { const p = poses.get(id); if (p) p.rh = this.distance; }
  }

  hz(id: string) { return this.swingHz.get(id) ?? SWING_DEFAULT; }
  setHz(id: string, hz: number) { this.swingHz.set(id, clamp(hz, 0.05, 3)); }

  /** Avanza dt segundos. El stem agarrado no se mueve. Devuelve los que se movieron. */
  tick(dt: number, poses: Map<string, Pose3D>, grabbed: string | null = null): string[] {
    if (!this.active) return [];
    const moved: string[] = [], two = 2 * Math.PI;
    for (const id of this.ids) {
      const p = poses.get(id);
      if (!p || id === grabbed) continue;
      // En la escena el azimut crece (sceneAz); en el motor es el contrario
      p.az = (p.az - this.speed * (this.factor.get(id) ?? 1) * two * dt) % two;
      if (this.swingIds.has(id)) {
        const ph = (this.phase.get(id) ?? 0) + two * this.hz(id) * dt;
        this.phase.set(id, ph);
        p.h = clampHeight(DANCE_SINE_AMP * Math.sin(ph));
      }
      moved.push(id);
    }
    return moved;
  }
}
