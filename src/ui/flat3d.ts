// Vista 3D plana = player_3d_view de Android (ajuste de rendimiento "Escena 2D"): camara detras y encima
// del dummy de malla, las pistas sobre una elipse del suelo (arriba = delante del oyente y detras de la
// cabeza, abajo = detras) y el motor con azimut = atan2(x, -y), distancia = |x, y| (1 = radio del circulo)
// y la elevacion del slider vertical, que tambien sube el icono en pantalla.
// Sin three.js. Mismos gestos que la escena: arrastrar, clic, doble clic (omni), pulsacion larga (mute).
import { t } from '../i18n/i18n.ts';
import type { Player } from '../player/player.ts';
import { titleKey } from '../player/stems.ts';
import {
  DANCE_SPEED_DEFAULT, DANCE_SPEED_MAX, DANCE_SPEED_MIN, FLAT_DANCE_DIST_MAX, FLAT_DANCE_DIST_MIN,
  FLAT_ELEV_MAX, FLAT_ELEV_MIN, FLAT_LIFT, FLAT_SQUASH, FLAT_SWING_AMP, SWING_DEFAULT, SWING_MAX, SWING_MIN,
  defaultPose, flatDepthScale, flatElevDeg, flatFloor, flatLift, flatSwingElev, heightForElev, modified, type Pose3D,
} from '../player/audio3d.ts';
import { danceSetupDialog, danceTabs, fillDancePanel } from './dancePanel.ts';
import { audio3dInfoDialog } from './info3d.ts';
import { iconOf } from './stemIcons.ts';
import { h, img, setSlider, slider } from './dom.ts';
import headUrl from '../assets/head_flat.webp';
import type { Scene3DHooks } from './scene3d.ts';

const LONG_PRESS_MS = 450, DOUBLE_MS = 300, SLOP_PX = 6;
const HEADER_PX = 56, BOTTOM_PX = 92;  // cabecera y fila inferior (solo en las esquinas)
const MOB_BOTTOM_PX = 126, MOB_HEAD_PX = 150, MOB_HEAD_FROM_BOTTOM = 265; // movil: fila de 102 + 16 + 8; cabeza como en Android
const CORNER_PX = 270;                  // ancho de las esquinas ocupadas (titulo, interruptor, panel, play)
const EDGE_PX = 8;                      // margen arriba y abajo en la columna central
const RESET_STAGGER_MS = 60, RESET_MS = 700;

/** Posicion normalizada (x derecha, y abajo; 1 = radio del circulo) de una pose. */
const toXY = (p: Pose3D) => ({ x: Math.sin(p.az) * p.fr, y: -Math.cos(p.az) * p.fr });
/** Y su inversa: azimut del motor (0 delante = arriba) y radio. */
const fromXY = (x: number, y: number) => ({ az: Math.atan2(x, -y), fr: Math.hypot(x, y) });
type DanceTab = 'speed' | 'distance' | 'swing';

export class Flat3D {
  readonly el = h('div', { class: 'd3 f3' });
  private p: Player;
  private hooks: Scene3DHooks;
  private stage = h('div', { class: 'f3stage' });
  private head = img(headUrl, 'f3head', t('cd_listener_head'));
  private veil = h('div', { class: 'f3veil' });
  private icons = new Map<string, HTMLButtonElement>();
  private selected: string | null = null;
  private sw = h('button', { class: 'switch', attrs: { role: 'switch', 'aria-label': t('audio3d_title') } });
  private elev = slider(FLAT_ELEV_MIN, FLAT_ELEV_MAX, 1, 0, t('web_3d_elevation'));
  private elevTip = h('span', { class: 'd3tip' });
  private tipTimer = 0;
  private resetBtn = h('button', { class: 'd3btn', attrs: { 'aria-label': t('web_3d_reset'), title: t('web_3d_reset') } });
  private danceBtn = h('button', { class: 'd3btn', attrs: { 'aria-label': t('stems_dance_title'), title: t('stems_dance_title') } });
  private panel = h('div', { class: 'd3panel f3dance', hidden: true });
  // Geometria en px (se recalcula al cambiar de tamano)
  private g = { cx: 0, cy: 0, r: 1, w: 0, h: 0, mob: false };
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private last = 0;
  private drag: { stem: string; id: number; ox: number; oy: number; x0: number; y0: number; moved: boolean; long: boolean; timer: number } | null = null;
  private lastUp = { t: 0, stem: '' };
  // Baile plano (startDance / tickDance): angulo en pantalla, factor de radio y de velocidad por stem
  private dance = { active: false, speed: DANCE_SPEED_DEFAULT, dist: 1, ids: [] as string[], ang: new Map<string, number>(), rf: new Map<string, number>(), sf: new Map<string, number>(),
    swing: new Set<string>(), phase: new Map<string, number>(), hz: new Map<string, number>(), lift: new Map<string, number>(), random: false };
  private danceTab: DanceTab = 'speed';
  private swingStem: string | null = null;
  private resetAnim: { from: Map<string, Pose3D>; t0: number } | null = null;

  constructor(p: Player, hooks: Scene3DHooks) {
    this.p = p; this.hooks = hooks;
    (this.el as HTMLElement & { flat3d?: Flat3D }).flat3d = this; // acceso de las pruebas
    this.buildChrome();
    const v2 = p.hasVocals2;
    for (const s of p.stems) {
      const name = t(titleKey(s.stem, v2)) || s.stem;
      const b = h('button', { class: 'f3ic', attrs: { 'aria-label': name, title: name } }, img(iconOf(s.stem, v2), '', '')) as HTMLButtonElement;
      b.dataset.stem = s.stem;
      this.bindIcon(b, s.stem);
      this.icons.set(s.stem, b);
      this.stage.append(b);
    }
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.el);
    this.setLights(p.audio3d, false);
    this.syncControls();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Para las pruebas: centro del icono (px de cliente) y su pose. */
  probe(stem: string) {
    const b = this.icons.get(stem);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, pose: { ...this.p.poses.get(stem)! }, dancing: this.dance.active, scale: flatDepthScale(toXY(this.p.poses.get(stem)!).y) };
  }

  watchAccent(_host: HTMLElement) { /* todo va por CSS (--accent) */ }

  destroy() {
    cancelAnimationFrame(this.raf);
    if (this.dance.active) this.stopDance();
    this.ro?.disconnect();
  }

  // ---------------- construccion ----------------

  private buildChrome() {
    const info = h('button', { class: 'd3i', textContent: 'i', attrs: { 'aria-label': t('audio3d_info_title') } });
    info.onclick = () => this.infoDialog();
    this.sw.onclick = () => this.setEnabled(!this.p.audio3d);
    const head = h('div', { class: 'd3head' }, h('b', { textContent: t('audio3d_title') }), info, h('span', { class: 'sp' }), this.sw);
    this.elev.classList.add('vsl');
    this.elev.addEventListener('input', () => {
      const s = this.selected;
      if (!s) return;
      const deg = +this.elev.value, pose = this.p.poses.get(s)!;
      this.p.setPose(s, { h: heightForElev(pose, deg) }, false);
      this.place(s);
      this.tip(`${deg}°`);
    });
    this.elev.addEventListener('change', () => this.p.onChange?.());
    const side = h('div', { class: 'd3side' }, this.elevTip, this.elev);
    this.resetBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 12c0-1.1-.9-2-2-2s-2 .9-2 2 .9 2 2 2 2-.9 2-2zM12 3c-4.97 0-9 4.03-9 9H0l4 4 4-4H5c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.51 0-2.91-.49-4.06-1.3l-1.42 1.44C8.04 20.3 9.94 21 12 21c4.97 0 9-4.03 9-9s-4.03-9-9-9z"/></svg>'; // ic_restore_pan
    this.resetBtn.onclick = () => this.reset();
    this.danceBtn.onclick = () => (this.dance.active ? this.stopDance() : this.danceDialog());
    const btns = h('div', { class: 'd3btns' }, this.danceBtn, this.resetBtn);
    const bottom = h('div', { class: 'd3bottom' }, h('span', { class: 'sp' }), this.panel, btns);
    this.stage.append(this.head);
    this.el.append(this.stage, this.veil, h('div', { class: 'd3chrome' }, head, side, bottom));
  }

  // ---------------- geometria ----------------

  /** Escritorio: cabeza en el centro (decision JP). Movil: abajo como Android. Radio = 0.35 del ancho, sin salirse en vertical por la elipse. */
  private layout() {
    const w = this.el.clientWidth, hh = this.el.clientHeight;
    if (!w || !hh) return;
    const mob = !!this.el.closest('.app.mob');
    const size = mob ? MOB_HEAD_PX : Math.round(Math.max(100, Math.min(170, hh * 0.22)));
    const cy = mob ? Math.max(hh * 0.45, hh - MOB_HEAD_FROM_BOTTOM) : hh / 2, cx = w / 2;
    const r = Math.max(60, Math.min(w * 0.35, (cy - EDGE_PX - 40) / FLAT_SQUASH));
    this.g = { cx, cy, r, w, h: hh, mob };
    Object.assign(this.head.style, { width: `${size}px`, height: `${size}px`, left: `${cx - size / 2}px`, top: `${cy - size / 2}px` });
    this.placeAll();
  }

  /** Limites en pantalla del centro del icono: bordes, y cabecera y fila inferior (en escritorio solo en las esquinas). */
  private constrain(px: number, py: number) {
    const g = this.g, half = g.mob ? 22 : 28;
    px = Math.max(half, Math.min(g.w - half, px));
    const corner = g.mob || px < CORNER_PX || px > g.w - CORNER_PX;
    const bottom = g.mob ? MOB_BOTTOM_PX : BOTTOM_PX - 8;
    py = Math.max((corner ? HEADER_PX : EDGE_PX) + half, Math.min(g.h - (corner ? bottom : EDGE_PX) - half, py));
    return { px, py };
  }

  /** Altura en pantalla: la de su elevacion, o la de la onda si esta en swing. */
  private liftOf(stem: string, pose: Pose3D) { return this.dance.lift.get(stem) ?? flatLift(flatElevDeg(pose), this.g.r); }

  private place(stem: string) {
    const b = this.icons.get(stem), pose = this.p.poses.get(stem);
    if (!b || !pose || !this.g.w) return;
    const { x, y } = toXY(pose);
    const { px, py } = this.constrain(this.g.cx + x * this.g.r, this.g.cy + y * this.g.r * FLAT_SQUASH - this.liftOf(stem, pose));
    b.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%) scale(${flatDepthScale(y)})`;
    b.style.zIndex = String(Math.round(y * 1000)); // la cabeza va en 0: delante del oyente pasa por detras de ella
    b.classList.toggle('sel', this.selected === stem);
    b.classList.toggle('omni', pose.omni);
    b.classList.toggle('muted', pose.muted);
  }

  private placeAll() { for (const s of this.icons.keys()) this.place(s); }

  // ---------------- estado ----------------

  private setEnabled(on: boolean) {
    this.p.set3DEnabled(on);
    this.setLights(on, true);
    this.syncControls();
    this.hooks.onEnabled(on);
  }

  /** Luces apagadas: velo negro al .72 (animate3DLightsOverlay) y los iconos no responden. */
  private setLights(on: boolean, animate: boolean) {
    this.el.classList.toggle('anim', animate);
    this.veil.classList.toggle('on', !on);
    this.stage.classList.toggle('inert', !on);
  }

  private syncControls() {
    const on = this.p.audio3d, sel = this.selected ? this.p.poses.get(this.selected)! : null;
    this.sw.setAttribute('aria-checked', String(on));
    // Omnipresente: el motor fuerza 0/0/1 y la elevacion no aplica
    // El swing tambien manda sobre la elevacion (elevationLocked)
    this.elev.disabled = !on || !sel || sel.omni || (this.dance.active && this.dance.swing.has(this.selected!));
    if (sel) setSlider(this.elev, Math.round(flatElevDeg(sel)));
    this.danceBtn.disabled = !on; this.resetBtn.disabled = !on;
    this.panel.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach((c) => (c.disabled = !on));
    this.danceBtn.innerHTML = this.dance.active
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
    this.danceBtn.setAttribute('aria-label', this.dance.active ? t('web_3d_stop_dance') : t('stems_dance_title'));
    this.resetBtn.hidden = ![...this.p.poses.values()].some(modified);
  }

  private select(stem: string | null) {
    const prev = this.selected;
    this.selected = stem;
    if (prev) this.place(prev);
    if (stem) this.place(stem);
    // Un stem con swing tocado pasa a ser el que edita la pestana Swing
    if (stem && this.dance.active && this.dance.swing.has(stem) && this.swingStem !== stem) { this.swingStem = stem; this.renderPanel(); }
    this.syncControls();
  }

  private tip(text: string) {
    this.elevTip.textContent = text;
    this.elevTip.classList.add('show');
    clearTimeout(this.tipTimer);
    this.tipTimer = window.setTimeout(() => this.elevTip.classList.remove('show'), 700);
  }

  // ---------------- gestos ----------------

  private bindIcon(b: HTMLButtonElement, stem: string) {
    b.addEventListener('pointerdown', (e) => {
      if (!this.p.audio3d || e.button !== 0) return;
      b.setPointerCapture(e.pointerId);
      const r = b.getBoundingClientRect();
      this.drag = { stem, id: e.pointerId, ox: e.clientX - (r.left + r.width / 2), oy: e.clientY - (r.top + r.height / 2), x0: e.clientX, y0: e.clientY, moved: false, long: false,
        timer: window.setTimeout(() => {
          // Pulsacion larga sin mover = mute 3D (no toca el volumen)
          if (!this.drag || this.drag.moved) return;
          this.drag.long = true;
          this.p.setPose(stem, { muted: !this.p.poses.get(stem)!.muted });
          this.place(stem); this.syncControls();
        }, LONG_PRESS_MS) };
    });
    b.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) <= SLOP_PX) return;
      if (!d.moved) { d.moved = true; clearTimeout(d.timer); this.select(stem); }
      const box = this.el.getBoundingClientRect();
      const { px, py } = this.constrain(e.clientX - d.ox - box.left, e.clientY - d.oy - box.top);
      this.dance.lift.delete(stem); // agarrado: sin onda
      const f = flatFloor(px - this.g.cx, py - this.g.cy, this.liftOf(stem, this.p.poses.get(stem)!), this.g.r);
      const { az, fr } = fromXY(f.x, f.y);
      this.p.setPose(stem, { az, fr, placed: true }, false);
      this.place(stem);
    });
    const up = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      clearTimeout(d.timer);
      this.drag = null;
      if (d.moved) {
        // Bailando: se reengancha con el radio nuevo (onDanceRelease)
        if (this.dance.active && this.dance.ids.includes(stem)) this.regrab(stem);
        else this.p.onChange?.();
        this.syncControls();
        return;
      }
      if (d.long) return;
      const now = performance.now();
      if (this.lastUp.stem === stem && now - this.lastUp.t < DOUBLE_MS) {
        this.lastUp.stem = '';
        this.p.setPose(stem, { omni: !this.p.poses.get(stem)!.omni });
        this.place(stem); this.syncControls();
        return;
      }
      this.lastUp = { t: now, stem };
      this.select(stem);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }

  // ---------------- animacion: baile y reset ----------------

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0;
    this.last = now;
    if (this.dance.active && dt > 0) this.tickDance(dt);
    if (this.resetAnim) this.stepReset(now);
  };

  /** Radio maximo en unidades del circulo: no salir de la vista ni pisar cabecera o fila inferior (en vertical cuenta la elipse). */
  private maxRadius() {
    const g = this.g, top = g.mob ? HEADER_PX : EDGE_PX, bottom = g.mob ? MOB_BOTTOM_PX : EDGE_PX;
    const rx = Math.min(g.cx, g.w - g.cx) - 30, ry = (Math.min(g.cy - top, g.h - bottom - g.cy) - 30) / FLAT_SQUASH;
    return Math.max(50, Math.min(rx, ry)) / g.r;
  }

  private tickDance(dt: number) {
    const d = this.dance, two = 2 * Math.PI, grabbed = this.drag?.moved ? this.drag.stem : null, rMax = this.maxRadius();
    for (const stem of d.ids) {
      if (stem === grabbed) continue;
      // En pantalla el angulo crece en sentido horario (y hacia abajo)
      const ang = ((d.ang.get(stem) ?? 0) + two * d.speed * (d.sf.get(stem) ?? 1) * dt) % two;
      d.ang.set(stem, ang);
      const r = Math.min(rMax, (d.rf.get(stem) ?? 1) * d.dist);
      const { az, fr } = fromXY(Math.cos(ang) * r, Math.sin(ang) * r);
      const patch: Partial<Pose3D> = { az, fr, placed: true };
      if (d.swing.has(stem)) {
        // Onda alrededor de la linea de la cabeza, con fase propia: entera en pantalla a cualquier radio
        const ph = ((d.phase.get(stem) ?? 0) + two * (d.hz.get(stem) ?? SWING_DEFAULT) * dt) % two;
        d.phase.set(stem, ph);
        const wave = Math.sin(ph), deg = flatSwingElev(wave, r);
        d.lift.set(stem, FLAT_SWING_AMP * wave * this.g.r * FLAT_LIFT);
        patch.h = heightForElev(this.p.poses.get(stem)!, deg);
        if (stem === this.selected) setSlider(this.elev, Math.round(deg));
      }
      this.p.setPose(stem, patch, false);
      this.place(stem);
    }
  }

  /** startDance: cada stem parte de donde esta (factor de radio actual) a 0.7..1.3 x la velocidad. */
  private startDance(ids: string[], swing: string[], random: boolean) {
    const d = this.dance;
    d.ids = ids; d.ang.clear(); d.rf.clear(); d.sf.clear(); d.phase.clear(); d.lift.clear();
    d.swing = new Set(swing); d.random = random;
    for (const stem of ids) {
      const { x, y } = toXY(this.p.poses.get(stem)!);
      d.ang.set(stem, Math.atan2(y, x));
      const cur = Math.hypot(x, y);
      d.rf.set(stem, cur < 0.3 ? 1 : cur);
      d.sf.set(stem, 0.7 + Math.random() * 0.6);
      if (d.swing.has(stem)) d.phase.set(stem, random ? Math.random() * 2 * Math.PI : 0);
    }
    d.active = ids.length > 0;
    this.swingStem = swing[0] ?? null;
    this.danceTab = 'speed';
    this.renderPanel();
    this.syncControls();
  }

  /** Soltar un stem que baila: sigue desde su angulo y radio nuevos. */
  private regrab(stem: string) {
    const { x, y } = toXY(this.p.poses.get(stem)!);
    this.dance.ang.set(stem, Math.atan2(y, x));
    this.dance.rf.set(stem, Math.max(0.3, Math.hypot(x, y) / Math.max(0.01, this.dance.dist)));
  }

  /** Para y deja cada stem donde quedo (se guarda); el que hacia swing, en la elevacion alcanzada. */
  private stopDance() {
    this.dance.active = false;
    this.dance.ids = [];
    this.dance.lift.clear();
    this.placeAll();
    this.p.onChange?.();
    this.renderPanel();
    this.syncControls();
  }

  /** Pestanas Velocidad / Distancia (multiplicador) / Swing; un slider y su valor (= panel de la escena). */
  private renderPanel(fromTab: DanceTab | null = null) {
    this.panel.hidden = !this.dance.active;
    if (!this.dance.active) { this.panel.replaceChildren(); return; }
    const d = this.dance, ids = d.ids.filter((s) => d.swing.has(s));
    if (!ids.length && this.danceTab === 'swing') this.danceTab = 'speed';
    const defs: [DanceTab, string][] = [['speed', t('stems_dance_speed')], ['distance', t('stems_dance_distance')]];
    if (ids.length) defs.push(['swing', t('dance_tab_swing')]);
    const tabs = danceTabs(defs, this.danceTab, fromTab, (k) => { const from = this.danceTab; this.danceTab = k; this.renderPanel(from); });
    const val = h('span', { class: 'fxv' });
    let row: HTMLElement;
    if (this.danceTab === 'speed') {
      const r = slider(DANCE_SPEED_MIN, DANCE_SPEED_MAX, 0.01, d.speed, t('stems_dance_speed'));
      const sync = () => (val.textContent = t('dance_value_speed', d.speed.toFixed(2)));
      r.addEventListener('input', () => { d.speed = +r.value; sync(); });
      sync(); row = h('div', { class: 'drow' }, r, val);
    } else if (this.danceTab === 'distance') {
      const r = slider(FLAT_DANCE_DIST_MIN, FLAT_DANCE_DIST_MAX, 0.05, d.dist, t('stems_dance_distance'));
      const sync = () => (val.textContent = `${d.dist.toFixed(2)}x`);
      r.addEventListener('input', () => { d.dist = +r.value; sync(); });
      sync(); row = h('div', { class: 'drow' }, r, val);
    } else {
      if (!this.swingStem || !d.swing.has(this.swingStem)) this.swingStem = ids[0];
      const stem = this.swingStem!, name = t(titleKey(stem, this.p.hasVocals2)) || stem;
      const r = slider(SWING_MIN, SWING_MAX, 0.05, d.hz.get(stem) ?? SWING_DEFAULT, t('stems_dance_osc_speed'));
      const sync = () => (val.textContent = `${(d.hz.get(stem) ?? SWING_DEFAULT).toFixed(2)} Hz`);
      r.addEventListener('input', () => { d.hz.set(stem, +r.value); sync(); });
      // Icono del stem del swing: clic = siguiente stem con swing
      const who = h('button', { class: 'dwho', attrs: { 'aria-label': name, title: name } }, img(iconOf(stem, this.p.hasVocals2), 's', ''));
      who.onclick = () => { this.select(ids[(ids.indexOf(stem) + 1) % ids.length]); };
      sync(); row = h('div', { class: 'drow' }, who, r, val);
    }
    fillDancePanel(this.panel, tabs, row);
    this.syncControls();
  }

  private danceDialog() {
    danceSetupDialog(this.p, new Set(this.dance.ids.length ? this.dance.ids : this.p.stems.map((s) => s.stem)), this.dance.swing, this.dance.random,
      (ids, swing, random) => this.startDance(ids, swing, random));
  }

  /** Vuelta al semicirculo frontal en cascada (60 ms, 700 ms por icono); limpia omni, mute y elevacion. */
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
      const k = Math.min(1, Math.max(0, (now - a.t0 - i * RESET_STAGGER_MS) / RESET_MS)), e = 1 - Math.pow(1 - k, 3);
      if (k < 1) done = false;
      const f = a.from.get(s.stem)!, to = defaultPose(i, n);
      let dAz = to.az - f.az;
      dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz));
      this.p.setPose(s.stem, { az: f.az + dAz * e, fr: f.fr + (to.fr - f.fr) * e, h: f.h + (to.h - f.h) * e, rh: f.rh + (to.rh - f.rh) * e, placed: k < 1 }, false);
      this.place(s.stem);
    });
    if (done) { this.resetAnim = null; this.p.onChange?.(); this.syncControls(); }
  }

  private infoDialog() { audio3dInfoDialog(false); }
}
