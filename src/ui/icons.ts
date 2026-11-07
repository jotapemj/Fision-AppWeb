// Iconos de linea (currentColor) en lugar de caracteres de texto: mismo grosor en todas las fuentes e idiomas
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const PATHS = {
  close: `<path ${STROKE} d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
  back: `<path ${STROKE} d="M19 12H5.5M11 6l-6 6 6 6"/>`,
  chev: `<path ${STROKE} d="M6.5 9.5 12 15l5.5-5.5"/>`,
  plus: `<path ${STROKE} d="M12 5.5v13M5.5 12h13"/>`,
  minus: `<path ${STROKE} d="M5.5 12h13"/>`,
  check: `<path ${STROKE} d="M5.5 12.5l4.2 4.2L18.5 7.5"/>`,
  more: '<g fill="currentColor"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></g>',
  grip: '<g fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></g>',
};
export type IconName = keyof typeof PATHS;

/** Icono decorativo (aria-hidden): el nombre lo lleva el boton. */
export function icon(name: IconName, px = 18): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = `ico ico-${name}`;
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${px}" height="${px}">${PATHS[name]}</svg>`;
  return s;
}
