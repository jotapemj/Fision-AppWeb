import './styles/app.css';
import { App } from './app.ts';
import { getLang, setLang } from './i18n/i18n.ts';

setLang(getLang());
new App(document.getElementById('app')!).start();
