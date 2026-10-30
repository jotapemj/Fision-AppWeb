// Ayudas DOM minimas (sin framework).

type Props = Record<string, unknown> & { class?: string; attrs?: Record<string, string> };

/** h('button', { class: 'act', onclick }, hijos...). `attrs` va por setAttribute (aria-*, role...). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, attrs, ...rest } = props;
  if (cls) el.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  Object.assign(el, rest);
  for (const k of kids) if (k !== null && k !== false) el.append(k);
  return el;
}

export const img = (src: string, cls = 'ic', alt = '') => h('img', { src, alt, class: cls, draggable: false });

/** Slider de la casa: actualiza --p (relleno) con el valor. */
export function slider(min: number, max: number, step: number, value: number, label: string): HTMLInputElement {
  const r = h('input', { type: 'range', class: 'sl', min: String(min), max: String(max), step: String(step), value: String(value), attrs: { 'aria-label': label } });
  const paint = () => r.style.setProperty('--p', `${((+r.value - min) / (max - min)) * 100}%`);
  r.addEventListener('input', paint);
  paint();
  (r as HTMLInputElement & { paint: () => void }).paint = paint;
  return r;
}
export function setSlider(r: HTMLInputElement, v: number) { r.value = String(v); (r as HTMLInputElement & { paint?: () => void }).paint?.(); }

export const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Cierra al hacer clic fuera o pulsar Escape. Devuelve la funcion de cierre. */
export function dismissable(el: HTMLElement, onClose: () => void, ignore: HTMLElement[] = []): () => void {
  const click = (e: MouseEvent) => { if (!el.contains(e.target as Node) && !ignore.some((i) => i.contains(e.target as Node))) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const close = () => { document.removeEventListener('pointerdown', click, true); document.removeEventListener('keydown', key); el.remove(); onClose(); };
  setTimeout(() => { document.addEventListener('pointerdown', click, true); document.addEventListener('keydown', key); });
  return close;
}

/** Aviso breve abajo (Snackbar): uno a la vez, se va solo. */
export function toast(text: string, ms = 3200) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', textContent: text, attrs: { role: 'status' } });
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}
