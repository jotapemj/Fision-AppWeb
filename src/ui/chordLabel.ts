// Texto de una casilla de acorde. Un acorde largo (A#maj7/G#) reduce su letra para caber:
// --w = ancho del texto en em; el CSS (.chl) calcula el tamano con el ancho de la casilla.
import { h } from './dom.ts';

const widths = new Map<string, number>();
let ctx: CanvasRenderingContext2D | null = null;
let font: Promise<unknown> | null = null;

function emWidth(text: string): number {
  let w = widths.get(text);
  if (w === undefined) {
    ctx ??= document.createElement('canvas').getContext('2d')!;
    ctx.font = '100px MusGlyphs, serif';
    w = ctx.measureText(text).width / 100;
    widths.set(text, w);
  }
  return w;
}

export function chordLabel(text: string): HTMLElement {
  const el = h('span', { class: 'chl', textContent: text });
  if (!text) return el;
  el.style.setProperty('--w', String(text.length * 0.6)); // estimacion hasta tener la fuente
  font ??= document.fonts.load('100px MusGlyphs');
  void font.then(() => el.style.setProperty('--w', String(emWidth(text))));
  return el;
}
