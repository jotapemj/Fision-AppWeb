// Diagramas de acordes (ChordDiagramController + ChordStageView + FrettedChordView + PianoChordView):
// instrumento y zona (globales), actual grande y siguiente pequeno, vocabulario de la cancion.
import { t } from '../i18n/i18n.ts';
import type { BeatCell } from '../player/chords.ts';
import {
  assignVoicings, changeAt, chordChanges, ChordShapes, noteName, parseSymbol, pianoKeys, STRINGS,
  type Change, type Instrument, type Position,
} from '../player/chordShapes.ts';
import { h } from './dom.ts';

const INSTR_PREF = 'fision.chordInstrument', ZONE_PREF = 'fision.chordZone';
const INSTRUMENTS: Instrument[] = ['piano', 'guitar', 'ukulele'];
const FRETS = 5, STEP_MS = 380;

const load = <T>(k: string, ok: (v: string) => T | null, def: T): T => { try { const v = localStorage.getItem(k); return (v !== null ? ok(v) : null) ?? def; } catch { return def; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin storage */ } };

// Una carga por instrumento (como ChordShapes.load)
const cache = new Map<string, Promise<ChordShapes | null>>();
function shapesFor(i: 'guitar' | 'ukulele'): Promise<ChordShapes | null> {
  let p = cache.get(i);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}chords/${i}.json`).then((r) => (r.ok ? r.json() : null)).then((d) => (d ? new ChordShapes(d) : null)).catch(() => null);
    cache.set(i, p);
  }
  return p;
}

export interface DiagramOpts {
  /** Transporte de los acordes (trasponer con el tono), cifrado latino y bemoles. */
  notation(): { shift: number; latin: boolean; flat: boolean };
  format(raw: string | null): string;
  seekBeat(beat: number): void;
}

interface Card { name: string; bass: string | null; position: Position | null; keys: number[]; names: string[] }

export class ChordDiagrams {
  readonly el = h('div', { class: 'cdg' });
  private o: DiagramOpts;
  private changes: Change[] = [];
  private instrument: Instrument = load(INSTR_PREF, (v) => (INSTRUMENTS.includes(v as Instrument) ? (v as Instrument) : null), 'guitar');
  private zone = load(ZONE_PREF, (v) => (/^[0-3]$/.test(v) ? +v : null), 0);
  private shapes: ChordShapes | null = null;
  private shown = Number.MIN_SAFE_INTEGER; // indice del cambio mostrado como actual
  private beat = -1;
  private stage = h('div', { class: 'cdstage' });
  private vocab = h('div', { class: 'cdvocab' });
  private vocabHead = h('p', { class: 'cdvh' });
  private zoneSeg: HTMLElement;
  private instSeg: HTMLElement;
  private ro: ResizeObserver;

  constructor(cells: BeatCell[], o: DiagramOpts) {
    this.o = o;
    this.instSeg = this.seg([t('chord_diagram_piano'), t('chord_diagram_guitar'), t('chord_diagram_ukulele')], INSTRUMENTS.indexOf(this.instrument), (i) => {
      this.instrument = INSTRUMENTS[i]; save(INSTR_PREF, this.instrument); void this.applyInstrument();
    }, t('chord_diagram_guitar'));
    this.zoneSeg = this.seg([t('chord_diagram_zone_open'), '3–7', '7–12', t('chord_diagram_zone_auto')], this.zone, (i) => {
      this.zone = i; save(ZONE_PREF, String(i)); this.recompute(); this.refresh();
    }, t('chord_diagram_zone_open'));
    this.el.append(h('div', { class: 'cdmain' }, h('div', { class: 'cdsel' }, this.instSeg, this.zoneSeg), this.stage), h('aside', { class: 'cdside' }, this.vocabHead, this.vocab));
    this.bindSwipe();
    this.ro = new ResizeObserver(() => this.redraw());
    this.ro.observe(this.stage);
    this.setCells(cells);
    void this.applyInstrument();
  }

  destroy() { this.ro.disconnect(); }

  setCells(cells: BeatCell[]) {
    this.changes = chordChanges(cells);
    this.recompute();
    this.shown = Number.MIN_SAFE_INTEGER;
    this.refresh();
  }

  /** Beat que resalta la tira: +1 cambio anima hacia delante, -1 hacia atras, otro salto sin animacion. */
  setBeat(beat: number) {
    this.beat = beat;
    const idx = changeAt(this.changes, beat);
    if (idx === this.shown) return;
    const known = this.shown !== Number.MIN_SAFE_INTEGER, dir = known && idx === this.shown + 1 ? 1 : known && idx === this.shown - 1 ? -1 : 0;
    this.shown = idx;
    this.render(dir);
  }

  /** Cambio de cifrado, bemoles o transporte. */
  refresh() {
    this.recompute();
    this.shown = changeAt(this.changes, Math.max(0, this.beat));
    this.render(0);
  }

  // ---------------- estado ----------------

  private async applyInstrument() {
    const fretted = this.instrument !== 'piano';
    this.zoneSeg.classList.toggle('hide', !fretted);
    this.shapes = null;
    this.refresh();
    if (!fretted) return;
    const inst = this.instrument as 'guitar' | 'ukulele';
    const s = await shapesFor(inst);
    if (this.instrument !== inst) return;
    this.shapes = s;
    this.refresh();
  }

  private recompute() { assignVoicings(this.changes, this.shapes, this.zone, this.o.notation().shift); }

  private card(idx: number): Card | null {
    if (idx < 0 || idx >= this.changes.length) return idx < 0 && this.changes.length ? { name: '—', bass: null, position: null, keys: [], names: [] } : null;
    const c = this.changes[idx], n = this.o.notation(), sym = parseSymbol(c.raw, n.shift);
    let bass: string | null = null;
    // Sin la inversion en los datos: la tarjeta dice el bajo
    if (this.instrument !== 'piano' && sym && sym.bass >= 0 && this.shapes) {
      const shape = this.shapes.find(sym);
      if (shape && !shape.bassShown) bass = t('chord_diagram_bass', noteName(sym.bass, n.latin, n.flat));
    }
    const keys = pianoKeys(sym);
    return { name: sym ? this.o.format(c.raw) : '—', bass, position: this.instrument === 'piano' ? null : c.position, keys, names: keys.map((k) => noteName(k, n.latin, n.flat)) };
  }

  // ---------------- pintado ----------------

  private render(dir: number) {
    const piano = this.instrument === 'piano';
    this.stage.classList.toggle('piano', piano);
    this.el.classList.toggle('piano', piano);
    const cur = this.cardEl(this.card(this.shown), 'cur'), nxt = this.cardEl(this.card(this.shown + 1), 'nxt');
    nxt.onclick = () => this.step(1);
    this.stage.replaceChildren(cur, nxt);
    this.redraw();
    // ChordStageView: el siguiente pasa a actual desde su sitio; al retroceder, al reves
    if (dir && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const ax = piano ? 'Y' : 'X', ease = 'cubic-bezier(0,0,.2,1)';
      cur.animate([{ transform: `translate${ax}(${dir > 0 ? 60 : -60}%) scale(${dir > 0 ? 0.62 : 1})`, opacity: dir > 0 ? 0.42 : 0 }, { transform: 'none', opacity: 1 }], { duration: STEP_MS, easing: ease });
      nxt.animate([{ transform: `translate${ax}(${dir > 0 ? 40 : -60}%)`, opacity: 0 }, { transform: 'none', opacity: 0.42 }], { duration: STEP_MS, easing: ease });
    }
    this.renderVocab();
  }

  private cardEl(c: Card | null, cls: string): HTMLElement {
    const el = h('div', { class: `cdcard ${cls}` });
    if (!c) return el;
    const latin = this.o.notation().latin;
    el.append(h('div', { class: 'cdname' }, h('b', { class: latin ? 'lat' : '', textContent: c.name }), c.bass ? h('span', { class: 'cdbass', textContent: c.bass }) : ''),
      h('canvas', { class: 'cddia', attrs: { role: 'img', 'aria-label': c.name } }));
    (el as HTMLElement & { card?: Card }).card = c;
    return el;
  }

  private redraw() {
    for (const el of this.el.querySelectorAll<HTMLElement & { card?: Card }>('.cdcard, .cdmini')) {
      const cv = el.querySelector('canvas');
      if (cv && el.card) this.paint(cv, el.card);
    }
  }

  private paint(cv: HTMLCanvasElement, c: Card) {
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight;
    if (!w || !hh) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
    const x = cv.getContext('2d')!;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, hh);
    if (this.instrument === 'piano') drawPiano(x, w, hh, c.keys, c.names);
    else drawFretted(x, w, hh, STRINGS[this.instrument], c.position);
  }

  /** Vocabulario: acordes distintos en orden de aparicion; el que suena, marcado. Clic = su proxima vez. */
  private renderVocab() {
    const seen = new Map<string, number>();
    this.changes.forEach((c, i) => { if (!seen.has(c.raw)) seen.set(c.raw, i); });
    this.vocabHead.textContent = t('web_chords_vocab', seen.size);
    const curRaw = this.changes[this.shown]?.raw;
    const minis = [...seen.entries()].map(([raw, i]) => {
      const c = this.card(i)!, b = h('button', { class: `cdmini${raw === curRaw ? ' on' : ''}`, attrs: { 'aria-label': c.name } },
        h('b', { class: this.o.notation().latin ? 'lat' : '', textContent: c.name }), h('canvas', { attrs: { 'aria-hidden': 'true' } }));
      (b as HTMLElement & { card?: Card }).card = c;
      b.onclick = () => {
        const next = this.changes.findIndex((x) => x.raw === raw && x.beat > this.beat);
        this.o.seekBeat(this.changes[next >= 0 ? next : i].beat);
      };
      return b;
    });
    this.vocab.replaceChildren(...minis);
    requestAnimationFrame(() => this.redraw());
  }

  /** Deslizar: al siguiente (izquierda; arriba en piano) o al anterior. */
  private step(d: number) {
    if (!this.changes.length) return;
    const cur = this.shown === Number.MIN_SAFE_INTEGER ? changeAt(this.changes, Math.max(0, this.beat)) : this.shown;
    const to = Math.max(0, Math.min(this.changes.length - 1, cur + d));
    if (to === cur && cur >= 0) return;
    this.o.seekBeat(this.changes[to].beat);
  }

  private bindSwipe() {
    let x0 = 0, y0 = 0, id = -1;
    this.stage.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; id = e.pointerId; });
    this.stage.addEventListener('pointerup', (e) => {
      if (e.pointerId !== id) return;
      id = -1;
      const piano = this.instrument === 'piano', along = piano ? y0 - e.clientY : x0 - e.clientX, cross = piano ? e.clientX - x0 : e.clientY - y0;
      if (Math.abs(along) >= 40 && Math.abs(along) > Math.abs(cross)) this.step(along > 0 ? 1 : -1);
    });
  }

  private seg(labels: string[], cur: number, on: (i: number) => void, label: string): HTMLElement {
    const g = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': label } });
    labels.forEach((l, i) => {
      const b = h('button', { textContent: l, attrs: { role: 'radio', 'aria-checked': String(i === cur) } });
      b.onclick = () => { g.querySelectorAll('button').forEach((x, k) => x.setAttribute('aria-checked', String(k === i))); on(i); };
      g.append(b);
    });
    return g;
  }
}

/** FrettedChordView: cuerdas, 5 trastes, cejuela o "Nfr", al aire / muda, dedos numerados y cejillas. */
export function drawFretted(x: CanvasRenderingContext2D, W: number, H: number, n: number, p: Position | null) {
  const wU = (n - 1) + 1.5 + 0.6, hU = 0.95 + FRETS * 1.32 + 0.2;
  const sp = Math.min(W / wU, H / hU);
  if (sp <= 0) return;
  const fh = sp * 1.32, gw = sp * (n - 1), gh = fh * FRETS;
  const x0 = (W - gw) / 2 + sp * 0.45, y0 = (H - sp * hU) / 2 + sp * 0.95, lw = Math.max(1.5, sp * 0.06);
  const a = p ? 1 : 70 / 255, white = (k: number) => `rgba(255,255,255,${k})`;
  x.lineCap = 'round';
  if (!p || p.baseFret <= 1) { x.fillStyle = white(a); x.fillRect(x0 - lw / 2, y0 - sp * 0.16, gw + lw, sp * 0.16); }
  else { x.fillStyle = '#fff'; x.font = `${sp * 0.55}px "Noto Sans", sans-serif`; x.textAlign = 'right'; x.textBaseline = 'alphabetic'; x.fillText(`${p.baseFret}fr`, x0 - sp * 0.45, y0 + fh * 0.5 + sp * 0.2); }
  x.lineWidth = lw;
  x.strokeStyle = white(a * 0.55);
  for (let i = 0; i <= FRETS; i++) { x.beginPath(); x.moveTo(x0, y0 + i * fh); x.lineTo(x0 + gw, y0 + i * fh); x.stroke(); }
  x.strokeStyle = white(a * 0.85);
  for (let s = 0; s < n; s++) { x.beginPath(); x.moveTo(x0 + s * sp, y0); x.lineTo(x0 + s * sp, y0 + gh); x.stroke(); }
  if (!p) return;
  const mr = sp * 0.24, my = y0 - sp * 0.55;
  x.strokeStyle = '#fff';
  for (let s = 0; s < n && s < p.frets.length; s++) {
    const cx = x0 + s * sp;
    x.beginPath();
    if (p.frets[s] < 0) { const k = mr * 0.9; x.moveTo(cx - k, my - k); x.lineTo(cx + k, my + k); x.moveTo(cx - k, my + k); x.lineTo(cx + k, my - k); }
    else if (p.frets[s] === 0) x.arc(cx, my, mr, 0, Math.PI * 2);
    x.stroke();
  }
  const dr = sp * 0.42;
  const finger = (s: number) => (p.fingers && s < p.fingers.length ? p.fingers[s] : 0);
  const num = (f: number, cx: number, cy: number) => {
    if (f <= 0) return;
    x.fillStyle = '#000'; x.font = `bold ${dr * 1.15}px "Noto Sans", sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(String(f), cx, cy + dr * 0.05);
  };
  const barreSpan = (b: number) => { let first = -1, last = -1; for (let s = 0; s < n && s < p.frets.length; s++) if (p.frets[s] === b) { if (first < 0) first = s; last = s; } return [first, last]; };
  for (const b of p.barres) {
    const [first, last] = barreSpan(b);
    if (first < 0 || last === first) continue;
    const cy = y0 + (b - 0.5) * fh;
    x.fillStyle = '#fff'; x.beginPath(); x.roundRect(x0 + first * sp - dr * 0.8, cy - dr, (last - first) * sp + dr * 1.6, dr * 2, dr); x.fill();
    num(finger(first), x0 + first * sp, cy);
  }
  for (let s = 0; s < n && s < p.frets.length; s++) {
    const fr = p.frets[s];
    if (fr <= 0) continue;
    if (p.barres.some((b) => { const [f, l] = barreSpan(b); return b === fr && f >= 0 && l > f && s >= f && s <= l; })) continue;
    const cx = x0 + s * sp, cy = y0 + (fr - 0.5) * fh;
    x.fillStyle = '#fff'; x.beginPath(); x.arc(cx, cy, dr, 0, Math.PI * 2); x.fill();
    num(finger(s), cx, cy);
  }
}

const WHITES = 14, WHITE_PC = [0, 2, 4, 5, 7, 9, 11], BLACKS = [[1, 0], [3, 1], [6, 3], [8, 4], [10, 5]];

/** PianoChordView: dos octavas en trazo blanco; las teclas del acorde con punto y nombre debajo
 *  (las negras en una segunda fila para que semitonos contiguos no se pisen). */
export function drawPiano(x: CanvasRenderingContext2D, W: number, H: number, keys: number[], names: string[]) {
  const kw = Math.min(W / WHITES, H / 5.6);
  if (kw <= 0) return;
  const kh = kw * 4.2, x0 = (W - kw * WHITES) / 2, y0 = (H - kw * 5.6) / 2, lw = Math.max(1.5, kw * 0.045), rad = kw * 0.08, dr = kw * 0.22;
  const labelY = y0 + kh + kw * 0.62;
  x.lineWidth = lw; x.strokeStyle = 'rgba(255,255,255,.71)';
  x.font = `bold ${kw * 0.42}px "Noto Sans", sans-serif`; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
  const dot = (cx: number, cy: number) => { x.fillStyle = '#fff'; x.beginPath(); x.arc(cx, cy, dr, 0, Math.PI * 2); x.fill(); };
  for (let i = 0; i < WHITES; i++) {
    const kx = x0 + i * kw;
    x.beginPath(); x.roundRect(kx, y0, kw, kh, rad); x.stroke();
    const at = keys.indexOf(WHITE_PC[i % 7] + 12 * Math.floor(i / 7));
    if (at >= 0) { dot(kx + kw / 2, y0 + kh - kw * 0.5); if (names[at]) x.fillText(names[at], kx + kw / 2, labelY); }
  }
  const bw = kw * 0.6, bh = kh * 0.6;
  for (let o = 0; o < 2; o++) for (const [pc, left] of BLACKS) {
    const bx = x0 + (left + 1 + o * 7) * kw - bw / 2;
    x.beginPath(); x.roundRect(bx, y0, bw, bh, rad); x.fillStyle = 'rgb(82,82,82)'; x.fill(); x.stroke();
    const at = keys.indexOf(pc + 12 * o);
    if (at >= 0) { dot(bx + bw / 2, y0 + bh - kw * 0.42); x.fillStyle = '#fff'; if (names[at]) x.fillText(names[at], bx + bw / 2, labelY + kw * 0.5); }
  }
}

