// Tour guiado = CoachMarkOverlay + Onboarding de Android: un elemento cada vez, visto por un hueco en
// una copia desenfocada y oscurecida de la pantalla, con una tarjeta que lo explica. El hueco se
// desliza entre pasos. Acabar u Omitir lo da por hecho; salir a medias (Escape) lo repite otra vez.
import { t } from '../i18n/i18n.ts';
import { h } from './dom.ts';

export type TourId = 'library' | 'player';

const PREF = 'fision.onboarding'; // prefs_onboarding: done_<tour>
const MOVE_MS = 320;
const FADE_MS = 200;
const PAD = 8;      // hueco alrededor del objetivo
const EDGE = 3;     // el hueco y su aro no salen de la ventana
const GAP = 18, MARGIN = 16;

const loadDone = (): Record<string, boolean> => {
  try { return JSON.parse(localStorage.getItem(PREF) ?? '{}') ?? {}; } catch { return {}; }
};
export const tourDone = (id: TourId) => !!loadDone()[id];
export function markTourDone(id: TourId) {
  const s = loadDone(); s[id] = true;
  try { localStorage.setItem(PREF, JSON.stringify(s)); } catch { /* sin storage */ }
}
/** "Ver tour": todos se vuelven a mostrar en su siguiente ocasion. */
export function resetTours() { try { localStorage.removeItem(PREF); } catch { /* sin storage */ } }

type Box = { x: number; y: number; w: number; h: number };
export type Target = () => Box | null;
export interface LegendRow { icon: Node; label: string }
export interface Step { target: Target; title: string; body?: string; corner?: number; legend?: LegendRow[] }

/** Union de los elementos visibles (null si ninguno se ve). */
export function views(...els: (Element | null | undefined)[]): Target {
  return () => {
    let out: Box | null = null;
    for (const el of els) {
      if (!el?.isConnected || !el.checkVisibility()) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (!out) { out = { x: r.left, y: r.top, w: r.width, h: r.height }; continue; }
      const x = Math.min(out.x, r.left), y = Math.min(out.y, r.top);
      out = { x, y, w: Math.max(out.x + out.w, r.right) - x, h: Math.max(out.y + out.h, r.bottom) - y };
    }
    return out;
  };
}

/** Algo modal abierto: el tour nunca va encima de un dialogo o un menu. */
export const busy = () => !!document.querySelector('dialog[open], .pop, .menu, .coach');

/** Arranca [id] si no esta hecho. Los pasos sin objetivo en pantalla se quitan; sin ninguno, nada. */
export function startTour(id: TourId, steps: Step[]): boolean {
  if (tourDone(id) || busy()) return false;
  const shown = steps.filter((s) => s.target());
  if (!shown.length) return false;
  new CoachMark(id, shown);
  return true;
}

const ease = (f: number) => { // cubic-bezier(.4,0,.2,1) aproximada (FastOutSlowIn)
  let a = 0, b = 1;
  for (let i = 0; i < 20; i++) { const m = (a + b) / 2; const x = 3 * (1 - m) ** 2 * m * 0.4 + 3 * (1 - m) * m * m * 0.2 + m ** 3; if (x < f) a = m; else b = m; }
  const m = (a + b) / 2;
  return 3 * (1 - m) * m * m + m ** 3;
};
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

class CoachMark {
  private el = h('div', { class: 'coach', attrs: { role: 'dialog', 'aria-modal': 'true' } });
  private veil = h('div', { class: 'coach-veil' });
  private ring = h('div', { class: 'coach-ring' });
  private card = h('div', { class: 'coach-card' });
  private counter = h('small', { class: 'coach-n' });
  private title = h('b', { class: 'coach-t' });
  private body = h('p', { class: 'coach-b' });
  private legend = h('div', { class: 'coach-lg' });
  private next = h('button', { class: 'coach-next' });
  private hole: Box = { x: 0, y: 0, w: 0, h: 0 };
  private radius = 0;
  private index = -1;
  private finishing = false;
  private raf = 0;
  private reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  private id: TourId;
  private steps: Step[];

  constructor(id: TourId, steps: Step[]) {
    this.id = id; this.steps = steps;
    const skip = h('button', { class: 'coach-skip', textContent: t('coach_skip') });
    this.card.append(this.counter, this.title, this.body, this.legend, h('div', { class: 'coach-row' }, skip, this.next));
    this.el.append(this.veil, this.ring, this.card);
    this.next.onclick = () => this.advance();
    skip.onclick = () => this.finish(true);
    // La pantalla de debajo no se toca; un clic en el elemento resaltado avanza
    this.el.addEventListener('click', (e) => {
      if (this.card.contains(e.target as Node)) return;
      const { x, y, w, h: hh } = this.hole;
      if (e.clientX >= x && e.clientX <= x + w && e.clientY >= y && e.clientY <= y + hh) this.advance();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.finish(false); } // = atras: se repite la proxima vez
      if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === this.next ? skip : this.next).focus(); }
    });
    addEventListener('resize', this.onResize);
    document.body.append(this.el);
    requestAnimationFrame(() => { this.el.classList.add('in'); this.show(0); });
  }

  private onResize = () => {
    const r = this.holeFor(this.steps[this.index]);
    if (!r) return;
    cancelAnimationFrame(this.raf);
    this.hole = r; this.radius = this.radiusFor(this.steps[this.index], r);
    this.paint(); this.placeCard();
  };

  private advance() {
    if (this.finishing) return;
    if (this.index + 1 >= this.steps.length) this.finish(true);
    else this.show(this.index + 1);
  }

  private show(i: number) {
    const target = this.holeFor(this.steps[i]);
    if (!target) { // se fue de la pantalla entretanto
      if (i + 1 < this.steps.length) this.show(i + 1); else this.finish(true);
      return;
    }
    const first = this.index < 0;
    this.index = i;
    const r1 = this.radiusFor(this.steps[i], target);
    if (first || this.reduce) {
      this.hole = target; this.radius = r1;
      this.paint(); this.bind(); this.pulse();
      return;
    }
    const from = { ...this.hole }, r0 = this.radius, t0 = performance.now();
    cancelAnimationFrame(this.raf);
    const step = (now: number) => {
      const f = ease(Math.min(1, (now - t0) / MOVE_MS));
      this.hole = { x: lerp(from.x, target.x, f), y: lerp(from.y, target.y, f), w: lerp(from.w, target.w, f), h: lerp(from.h, target.h, f) };
      this.radius = lerp(r0, r1, f);
      this.paint();
      if (f < 1) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
    // Tarjeta: se apaga, cambia y vuelve al llegar el hueco
    this.card.classList.add('out');
    setTimeout(() => {
      this.bind();
      setTimeout(() => { this.card.classList.remove('out'); this.pulse(); }, MOVE_MS - 120);
    }, 120);
  }

  private holeFor(s: Step): Box | null {
    const r = s.target();
    if (!r) return null;
    const x = Math.max(EDGE, r.x - PAD), y = Math.max(EDGE, r.y - PAD);
    const right = Math.min(innerWidth - EDGE, r.x + r.w + PAD), bottom = Math.min(innerHeight - EDGE, r.y + r.h + PAD);
    return { x, y, w: right - x, h: bottom - y };
  }

  private radiusFor(s: Step, r: Box) { return s.corner ?? Math.min(r.w, r.h) / 2; }

  private paint() {
    const { x, y, w, h: hh } = this.hole, rr = Math.min(this.radius, w / 2, hh / 2);
    // Velo con hueco: rectangulo de la ventana menos el rectangulo redondeado (evenodd)
    const W = innerWidth, H = innerHeight;
    const hole = `M${x + rr},${y} H${x + w - rr} A${rr},${rr} 0 0 1 ${x + w},${y + rr} V${y + hh - rr} A${rr},${rr} 0 0 1 ${x + w - rr},${y + hh}`
      + ` H${x + rr} A${rr},${rr} 0 0 1 ${x},${y + hh - rr} V${y + rr} A${rr},${rr} 0 0 1 ${x + rr},${y} Z`;
    this.veil.style.clipPath = `path(evenodd, 'M0,0 H${W} V${H} H0 Z ${hole}')`;
    Object.assign(this.ring.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px`, borderRadius: `${rr}px` });
  }

  private pulse() { // aro que crece y se apaga al llegar
    this.ring.classList.remove('pulse'); void this.ring.offsetWidth; this.ring.classList.add('pulse');
  }

  private bind() {
    const s = this.steps[this.index], last = this.index + 1 === this.steps.length;
    this.counter.textContent = t('coach_counter', this.index + 1, this.steps.length);
    this.title.textContent = s.title;
    this.body.hidden = !s.body;
    this.body.textContent = s.body ?? '';
    this.legend.hidden = !s.legend?.length;
    this.legend.replaceChildren(...(s.legend ?? []).map((l) => h('div', {}, l.icon, h('span', { textContent: l.label }))));
    this.next.textContent = t(last ? 'coach_done' : 'coach_next');
    this.el.setAttribute('aria-label', s.title);
    this.placeCard();
    this.next.focus({ preventScroll: true });
  }

  /** Tarjeta debajo del hueco si cabe; si no, encima; siempre en pantalla. */
  private placeCard() {
    const target = this.holeFor(this.steps[this.index]) ?? this.hole;
    const W = innerWidth, H = innerHeight, cw = this.card.offsetWidth, ch = this.card.offsetHeight;
    const below = target.y + target.h + GAP, above = target.y - GAP - ch;
    let y = below + ch <= H - MARGIN ? below : above >= MARGIN ? above : (H - (target.y + target.h) > target.y ? below : above);
    y = Math.max(MARGIN, Math.min(y, H - ch - MARGIN));
    const x = Math.max(MARGIN, Math.min(target.x + target.w / 2 - cw / 2, W - cw - MARGIN));
    this.card.style.transform = `translate(${x}px, ${y}px)`;
  }

  private finish(done: boolean) {
    if (this.finishing) return;
    this.finishing = true;
    if (done) markTourDone(this.id);
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.onResize);
    this.el.classList.remove('in');
    setTimeout(() => this.el.remove(), FADE_MS);
  }
}
