// Hoja inferior (BottomSheetDialog + dialogbg): #181818, esquinas de arriba 24, asa gris; sube desde abajo.
// Se cierra con el fondo, Escape, o arrastrando el asa hacia abajo mas de un tercio de su alto.
import { h } from './dom.ts';

const ANIM_MS = 220;

/** `theme`: elemento del que copiar el acento (colores de portada del reproductor; la hoja vive en body). */
export function openSheet(label: string, build: (body: HTMLElement, close: () => void) => void, onClose?: () => void, theme?: HTMLElement): () => void {
  const body = h('div', { class: 'shbody' });
  const grip = h('div', { class: 'shgrip', attrs: { 'aria-hidden': 'true' } }, h('i'));
  const dlg = h('dialog', { class: 'sheet', attrs: { 'aria-label': label } }, grip, body);
  if (theme) { const cs = getComputedStyle(theme); for (const v of ['--accent', '--accent-2', '--accent-12', '--on-accent']) dlg.style.setProperty(v, cs.getPropertyValue(v)); }
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    dlg.classList.remove('in');
    setTimeout(() => dlg.close(), ANIM_MS);
  };
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); }); // Escape con animacion
  // Fuera de la hoja (el ::backdrop cuenta como el propio dialogo)
  dlg.addEventListener('pointerdown', (e) => { if (e.target === dlg) close(); });
  // Arrastrar el asa hacia abajo
  let y0 = 0, id = -1;
  grip.onpointerdown = (e) => { id = e.pointerId; y0 = e.clientY; grip.setPointerCapture(id); dlg.style.transition = 'none'; };
  grip.onpointermove = (e) => { if (e.pointerId === id) dlg.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)`; };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = -1;
    dlg.style.transition = ''; dlg.style.transform = '';
    if (e.clientY - y0 > dlg.offsetHeight / 3) close();
  };
  grip.onpointerup = up; grip.onpointercancel = up;
  build(body, close);
  document.body.append(dlg);
  dlg.showModal();
  requestAnimationFrame(() => dlg.classList.add('in'));
  return close;
}
