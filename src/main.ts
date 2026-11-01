import './styles/app.css';
import { App } from './app.ts';
import { pickLang, setLang } from './i18n/i18n.ts';
import { ACCENTS, SettingsStore } from './settings.ts';

const settings = new SettingsStore();
setLang(settings.get('lang') || pickLang(navigator.languages ?? [navigator.language]));
const applyAccent = () => document.documentElement.style.setProperty('--accent', ACCENTS[settings.get('accentId')]);
applyAccent();
settings.subscribe((_, k) => {
  if (k === 'accentId') applyAccent();
  // Como AppCompat, cambiar de idioma recrea la interfaz
  if (k === 'lang') location.reload();
});
new App(document.getElementById('app')!, settings).start();

// PWA: service worker solo en el build (en desarrollo chocaria con la recarga de Vite). Sin HTTPS no registra.
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
