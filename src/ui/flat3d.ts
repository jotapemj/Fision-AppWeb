// Vista 3D plana = player_3d_view de Android (ajuste de rendimiento "Escena 2D"): el dummy de malla
// en el centro, las pistas como iconos alrededor (arriba = delante, abajo = detras) y el motor con
// azimut = atan2(x, -y), distancia = |x, y| (1 = radio del circulo) y la elevacion del slider vertical.
// Sin three.js. Mismos gestos que la escena: arrastrar, clic, doble clic (omni), pulsacion larga (mute).
import { t } from '../i18n/i18n.ts';
import type { Player } from '../player/player.ts';
import { titleKey } from '../player/stems.ts';
import {
  DANCE_SPEED_DEFAULT, DANCE_SPEED_MAX, DANCE_SPEED_MIN, FLAT_DANCE_DIST_MAX, FLAT_DANCE_DIST_MIN,
  FLAT_ELEV_MAX, FLAT_ELEV_MIN, defaultPose, flatDist, flatElevDeg, heightForElev, modified, type Pose3D,
} from '../player/audio3d.ts';
import { iconOf } from './stemIcons.ts';
import { h, img, setSlider, slider } from './dom.ts';
import headUrl from '../assets/head_flat.webp';
import type { Scene3DHooks } from './scene3d.ts';

const LONG_PRESS_MS = 450, DOUBLE_MS = 300, SLOP_PX = 6;
const HEADER_PX = 56, BOTTOM_PX = 92;  // cabecera y fila inferior (solo en las esquinas)
const CORNER_PX = 270;                  // ancho de las esquinas ocupadas (titulo, interruptor, leyenda, play)
const EDGE_PX = 8;                      // margen arriba y abajo en la columna central
const RESET_STAGGER_MS = 60, RESET_MS = 700;

/** Posicion normalizada (x derecha, y abajo; 1 = radio del circulo) de una pose. */
const toXY = (p: Pose3D) => ({ x: Math.sin(p.az) * p.fr, y: -Math.cos(p.az) * p.fr });
/** Y su inversa: azimut del motor (0 delante = arriba) y radio. */
const fromXY = (x: number, y: number) => ({ az: Math.atan2(x, -y), fr: Math.hypot(x, y) });
/** Cerca = grande, lejos = pequeno (applyIconVisualForDistance). */
export const iconScale = (fr: number) => Math.max(0.55, Math.min(1.35, 1 / Math.max(0.5, flatDist({ fr }))));

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
  private g = { cx: 0, cy: 0, r: 1, w: 0, h: 0, hw: 0, hh: 0 };
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private last = 0;
  private drag: { stem: string; id: number; ox: number; oy: number; x0: number; y0: number; moved: boolean; long: boolean; timer: number } | null = null;
  private lastUp = { t: 0, stem: '' };
  // Baile plano (startDance / tickDance): angulo en pantalla, factor de radio y de velocidad por stem
  private dance = { active: false, speed: DANCE_SPEED_DEFAULT, dist: 1, ids: [] as string[], ang: new Map<string, number>(), rf: new Map<string, number>(), sf: new Map<string, number>() };
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
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, pose: { ...this.p.poses.get(stem)! }, dancing: this.dance.active, scale: iconScale(this.p.poses.get(stem)!.fr) };
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
      this.tip(`${deg}°`);
    });
    this.elev.addEventListener('change', () => this.p.onChange?.());
    const side = h('div', { class: 'd3side' }, this.elevTip, this.elev);
    const legend = h('ul', { class: 'd3legend' }, ...['drag', 'click', 'double', 'long'].map((k) => h('li', { textContent: t(`web_3d_legend_${k}`) })));
    this.resetBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 12c0-1.1-.9-2-2-2s-2 .9-2 2 .9 2 2 2 2-.9 2-2zM12 3c-4.97 0-9 4.03-9 9H0l4 4 4-4H5c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.51 0-2.91-.49-4.06-1.3l-1.42 1.44C8.04 20.3 9.94 21 12 21c4.97 0 9-4.03 9-9s-4.03-9-9-9z"/></svg>'; // ic_restore_pan
    this.resetBtn.onclick = () => this.reset();
    this.danceBtn.onclick = () => (this.dance.active ? this.stopDance() : this.danceDialog());
    const btns = h('div', { class: 'd3btns' }, this.danceBtn, this.resetBtn);
    const bottom = h('div', { class: 'd3bottom' }, legend, h('span', { class: 'sp' }), this.panel, btns);
    this.stage.append(this.head);
    this.el.append(this.stage, this.veil, h('div', { class: 'd3chrome' }, head, side, bottom));
  }

  // ---------------- geometria ----------------

  /** Cabeza en el centro (Android: abajo; aqui circulo entero para poder ir detras, decision JP);
   *  radio = 0.35 del ancho, acotado al alto (cabecera y leyenda van en las esquinas). */
  private layout() {
    const w = this.el.clientWidth, hh = this.el.clientHeight;
    if (!w || !hh) return;
    const size = Math.round(Math.max(100, Math.min(170, hh * 0.22)));
    const cy = hh / 2, cx = w / 2;
    const r = Math.max(60, Math.min(w * 0.35, cy - EDGE_PX - 40));
    this.g = { cx, cy, r, w, h: hh, hw: size, hh: size };
    Object.assign(this.head.style, { width: `${size}px`, height: `${size}px`, left: `${cx - size / 2}px`, top: `${cy - size / 2}px` });
    this.placeAll();
  }

  /** Limites del icono (bordes; cabecera y fila inferior solo en las esquinas) y la elipse de la cabeza. */
  private constrain(px: number, py: number) {
    const g = this.g, half = 28;
    px = Math.max(half, Math.min(g.w - half, px));
    const corner = px < CORNER_PX || px > g.w - CORNER_PX;
    py = Math.max((corner ? HEADER_PX : EDGE_PX) + half, Math.min(g.h - (corner ? BOTTOM_PX - 8 : EDGE_PX) - half, py));
    const rx = g.hw * 0.6, ry = g.hh * 0.55;
    let dx = px - g.cx, dy = py - g.cy;
    if (Math.abs(dx) + Math.abs(dy) < 1) dy = -1; // justo en el centro: sale por delante
    const inside = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
    if (inside < 1) { const k = 1 / Math.sqrt(inside + 1e-6); dx *= k; dy *= k; px = g.cx + dx; py = g.cy + dy; }
    return { px, py };
  }

  private place(stem: string) {
    const b = this.icons.get(stem), pose = this.p.poses.get(stem);
    if (!b || !pose || !this.g.w) return;
    const { x, y } = toXY(pose);
    const { px, py } = this.constrain(this.g.cx + x * this.g.r, this.g.cy + y * this.g.r);
    b.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%) scale(${iconScale(pose.fr)})`;
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
    this.elev.disabled = !on || !sel || sel.omni;
    if (sel) setSlider(this.elev, Math.round(flatElevDeg(sel)));
    this.danceBtn.disabled = !on; this.resetBtn.disabled = !on;
    this.panel.querySelectorAll<HTMLInputElement>('input').forEach((c) => (c.disabled = !on));
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
      const { az, fr } = fromXY((px - this.g.cx) / this.g.r, (py - this.g.cy) / this.g.r);
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

  /** Radio maximo en unidades del circulo: no salir de la vista ni pisar cabecera o fila inferior. */
  private maxRadius() {
    const g = this.g;
    const rx = Math.min(g.cx, g.w - g.cx) - 30, ry = Math.min(g.cy, g.h - g.cy) - EDGE_PX - 30;
    return Math.max(50, Math.min(rx, ry)) / g.r;
  }

  private tickDance(dt: number) {
    const two = 2 * Math.PI, grabbed = this.drag?.moved ? this.drag.stem : null, rMax = this.maxRadius();
    for (const stem of this.dance.ids) {
      if (stem === grabbed) continue;
      // En pantalla el angulo crece en sentido horario (y hacia abajo)
      const ang = ((this.dance.ang.get(stem) ?? 0) + two * this.dance.speed * (this.dance.sf.get(stem) ?? 1) * dt) % two;
      this.dance.ang.set(stem, ang);
      const r = Math.min(rMax, (this.dance.rf.get(stem) ?? 1) * this.dance.dist);
      const { az, fr } = fromXY(Math.cos(ang) * r, Math.sin(ang) * r);
      this.p.setPose(stem, { az, fr, placed: true }, false);
      this.place(stem);
    }
  }

  /** startDance: cada stem parte de donde esta (factor de radio actual) a 0.7..1.3 x la velocidad. */
  private startDance(ids: string[]) {
    const d = this.dance;
    d.ids = ids; d.ang.clear(); d.rf.clear(); d.sf.clear();
    for (const stem of ids) {
      const { x, y } = toXY(this.p.poses.get(stem)!);
      d.ang.set(stem, Math.atan2(y, x));
      const cur = Math.hypot(x, y);
      d.rf.set(stem, cur < 0.3 ? 1 : cur);
      d.sf.set(stem, 0.7 + Math.random() * 0.6);
    }
    d.active = ids.length > 0;
    this.renderPanel();
    this.syncControls();
  }

  /** Soltar un stem que baila: sigue desde su angulo y radio nuevos. */
  private regrab(stem: string) {
    const { x, y } = toXY(this.p.poses.get(stem)!);
    this.dance.ang.set(stem, Math.atan2(y, x));
    this.dance.rf.set(stem, Math.max(0.3, Math.hypot(x, y) / Math.max(0.01, this.dance.dist)));
  }

  /** Para y deja cada stem donde quedo (se guarda). */
  private stopDance() {
    this.dance.active = false;
    this.dance.ids = [];
    this.p.onChange?.();
    this.renderPanel();
    this.syncControls();
  }

  /** Velocidad (vueltas/s) y distancia (multiplicador 0.4..1.2), solo mientras baila. */
  private renderPanel() {
    this.panel.hidden = !this.dance.active;
    if (!this.dance.active) { this.panel.replaceChildren(); return; }
    const sp = slider(DANCE_SPEED_MIN, DANCE_SPEED_MAX, 0.01, this.dance.speed, t('stems_dance_speed'));
    const di = slider(FLAT_DANCE_DIST_MIN, FLAT_DANCE_DIST_MAX, 0.05, this.dance.dist, t('stems_dance_distance'));
    const spV = h('span', { class: 'fxv' }), diV = h('span', { class: 'fxv' });
    const sync = () => { spV.textContent = t('dance_value_speed', this.dance.speed.toFixed(2)); diV.textContent = `${this.dance.dist.toFixed(2)}×`; };
    sp.addEventListener('input', () => { this.dance.speed = +sp.value; sync(); });
    di.addEventListener('input', () => { this.dance.dist = +di.value; sync(); });
    sync();
    this.panel.replaceChildren(
      h('div', { class: 'drow' }, h('span', { class: 'dlab', textContent: t('stems_dance_speed') }), sp, spV),
      h('div', { class: 'drow' }, h('span', { class: 'dlab', textContent: t('stems_dance_distance') }), di, diV));
  }

  private danceDialog() {
    const v2 = this.p.hasVocals2, chosen = new Set(this.dance.ids.length ? this.dance.ids : this.p.stems.map((s) => s.stem));
    const start = h('button', { class: 'btn', textContent: t('stems_dance_start') });
    // Sin swing en la vista plana (no hay eje vertical)
    const grid = h('div', { class: 'dgrid' });
    for (const s of this.p.stems) {
      const name = t(titleKey(s.stem, v2)) || s.stem;
      const pick = h('button', { class: 'dtile', attrs: { 'aria-pressed': String(chosen.has(s.stem)), 'aria-label': name, title: name } }, img(iconOf(s.stem, v2), 's', ''));
      pick.onclick = () => { chosen.has(s.stem) ? chosen.delete(s.stem) : chosen.add(s.stem); pick.setAttribute('aria-pressed', String(chosen.has(s.stem))); start.disabled = !chosen.size; };
      grid.append(h('div', { class: 'dcell' }, pick));
    }
    const close = h('button', { class: 'xbtn', textContent: '✕', attrs: { 'aria-label': t('web_close') } });
    const dlg = h('dialog', { class: 'settings dance', attrs: { 'aria-label': t('stems_dance_title') } },
      h('div', { class: 'shd' }, h('h2', { textContent: t('stems_dance_title') }), close), grid, start);
    close.onclick = () => dlg.close();
    start.onclick = () => { this.startDance(this.p.stems.map((s) => s.stem).filter((s) => chosen.has(s))); dlg.close(); };
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
    dlg.showModal();
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

  private infoDialog() {
    const close = h('button', { class: 'xbtn', textContent: '✕', attrs: { 'aria-label': t('web_close') } });
    const dlg = h('dialog', { class: 'settings', attrs: { 'aria-label': t('audio3d_info_title') } },
      h('div', { class: 'shd' }, h('h2', { textContent: t('audio3d_info_title') }), close),
      h('p', { class: 'muted', textContent: t('audio3d_info_body') }));
    close.onclick = () => dlg.close();
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
    dlg.showModal();
  }
}
