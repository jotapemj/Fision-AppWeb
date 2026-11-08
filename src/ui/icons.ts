// Iconos (currentColor) en lugar de caracteres de texto: mismo grosor en todas las fuentes e idiomas
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const PATHS = {
  close: `<path ${STROKE} d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
  back: `<path ${STROKE} d="M19 12H5.5M11 6l-6 6 6 6"/>`,
  chev: `<path ${STROKE} d="M6.5 9.5 12 15l5.5-5.5"/>`,
  plus: `<path ${STROKE} d="M12 5.5v13M5.5 12h13"/>`,
  minus: `<path ${STROKE} d="M5.5 12h13"/>`,
  check: `<path ${STROKE} d="M5.5 12.5l4.2 4.2L18.5 7.5"/>`,
  more: '<g fill="currentColor"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></g>',
  // Material rellenos de Android (res/drawable): dialogos, ajustes y GPU
  del: '<path fill="currentColor" d="M6,19c0,1.1 0.9,2 2,2h8c1.1,0 2,-0.9 2,-2L18,7L6,7v12zM8.46,11.88l1.41,-1.41L12,12.59l2.12,-2.12 1.41,1.41L13.41,14l2.12,2.12 -1.41,1.41L12,15.41l-2.12,2.12 -1.41,-1.41L10.59,14l-2.13,-2.12zM15.5,4l-1,-1h-5l-1,1L5,4v2h14L19,4z"/>',
  warning: '<path fill="currentColor" fill-rule="evenodd" d="M12,2.5 L22.5,20.5 L1.5,20.5 Z M11.1,10.5 L12.9,10.5 L12.9,15.6 L11.1,15.6 Z M12,17.0 m-1.1,0 a1.1,1.1 0 1,0 2.2,0 a1.1,1.1 0 1,0 -2.2,0 Z"/>',
  logout: '<path fill="currentColor" d="M17,7l-1.41,1.41L18.17,11H8v2h10.17l-2.58,2.58L17,17l5,-5zM4,5h8V3H4c-1.1,0 -2,0.9 -2,2v14c0,1.1 0.9,2 2,2h8v-2H4V5z"/>',
  settings: '<path fill="currentColor" d="M19.14,12.94c0.04,-0.3 0.06,-0.61 0.06,-0.94c0,-0.32 -0.02,-0.64 -0.07,-0.94l2.03,-1.58c0.18,-0.14 0.23,-0.41 0.12,-0.61l-1.92,-3.32c-0.12,-0.22 -0.37,-0.29 -0.59,-0.22l-2.39,0.96c-0.5,-0.38 -1.03,-0.7 -1.62,-0.94L14.4,2.81c-0.04,-0.24 -0.24,-0.41 -0.48,-0.41h-3.84c-0.24,0 -0.43,0.17 -0.47,0.41L9.25,5.35C8.66,5.59 8.12,5.92 7.63,6.29L5.24,5.33c-0.22,-0.08 -0.47,0 -0.59,0.22L2.74,8.87C2.62,9.08 2.66,9.34 2.86,9.48l2.03,1.58C4.84,11.36 4.8,11.69 4.8,12s0.02,0.64 0.07,0.94l-2.03,1.58c-0.18,0.14 -0.23,0.41 -0.12,0.61l1.92,3.32c0.12,0.22 0.37,0.29 0.59,0.22l2.39,-0.96c0.5,0.38 1.03,0.7 1.62,0.94l0.36,2.54c0.05,0.24 0.24,0.41 0.48,0.41h3.84c0.24,0 0.44,-0.17 0.47,-0.41l0.36,-2.54c0.59,-0.24 1.13,-0.56 1.62,-0.94l2.39,0.96c0.22,0.08 0.47,0 0.59,-0.22l1.92,-3.32c0.12,-0.22 0.07,-0.47 -0.12,-0.61L19.14,12.94zM12,15.6c-1.98,0 -3.6,-1.62 -3.6,-3.6s1.62,-3.6 3.6,-3.6s3.6,1.62 3.6,3.6S13.98,15.6 12,15.6z"/>',
  gpu: '<path fill="currentColor" d="M15,9H9v6h6V9zM13,13h-2v-2h2V13zM21,11V9h-2V7c0,-1.1 -0.9,-2 -2,-2h-2V3h-2v2h-2V3H9v2H7C5.9,5 5,5.9 5,7v2H3v2h2v2H3v2h2v2c0,1.1 0.9,2 2,2h2v2h2v-2h2v2h2v-2h2c1.1,0 2,-0.9 2,-2v-2h2v-2h-2v-2H21zM17,17H7V7h10V17z"/>',
  checkThin: '<path fill="currentColor" d="M9,16.17L4.83,12l-1.42,1.41L9,19 21,7l-1.41,-1.41L9,16.17z"/>',
  crossThin: '<path fill="currentColor" d="M19,6.41L17.59,5 12,10.59 6.41,5 5,6.41 10.59,12 5,17.59 6.41,19 12,13.41 17.59,19 19,17.59 13.41,12z"/>',
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
