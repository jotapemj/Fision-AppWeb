// Licencias = LicensesActivity / LicenseDetailActivity + LicenseCatalog de Android, con lo que lleva la web.
// Anadir aqui cada componente de terceros nuevo que vaya en el build.
import { t } from '../i18n/i18n.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';

export interface LicenseEntry { name: string; author: string; license: string; url: string; text: string }

// Textos de licencia (los mismos que LicenseCatalog)
const LIC_MIT = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const LIC_LGPL_2_1 = `GNU LESSER GENERAL PUBLIC LICENSE
Version 2.1, February 1999

Copyright (C) 1991, 1999 Free Software Foundation, Inc.
Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.

This version of the GNU Lesser General Public License incorporates the
terms and conditions of version 3 of the GNU General Public License,
supplemented by the additional permissions listed below.

The Lesser General Public License is intended to guarantee your freedom
to share and change all versions of a program — to make sure it remains
free software for all its users. This license, the Lesser General Public
License, applies to some specially designated software packages —
typically libraries — of the Free Software Foundation and other authors
who decide to use it.

For the full text visit https://www.gnu.org/licenses/lgpl-2.1.html`;

const LIC_PUBLIC_DOMAIN = `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute
this software, either in source code form or as a compiled binary, for any
purpose, commercial or non-commercial, and by any means.

In jurisdictions that recognize copyright laws, the author or authors of
this software dedicate any and all copyright interest in the software to
the public domain. We make this dedication for the benefit of the public
at large and to the detriment of our heirs and successors.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED. IN NO EVENT SHALL THE AUTHORS BE HELD LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org>`;

const LIC_KEMAR = `KEMAR HRTF Measurements
Bill Gardner and Keith Martin, MIT Media Lab, 1995

This data is Copyright 1994 by the MIT Media Laboratory. It is
provided free with no restrictions on use, provided the authors are
cited when the data is used in any research or commercial
application:

Gardner, W. G., and Martin, K. D. (1995). "HRTF measurements of a
KEMAR." Journal of the Acoustical Society of America, 97(6),
3907-3908.

Original dataset available at:
https://sound.media.mit.edu/resources/KEMAR.html`;

const LIC_OFL = `This Font Software is licensed under the SIL Open Font License,
Version 1.1. The font may be used, studied, modified and
redistributed freely, embedded in software, as long as it is not
sold by itself and the copyright notice and license are kept.

Full text and FAQ: https://openfontlicense.org`;

export const LICENSES: LicenseEntry[] = [
  { name: 'SoundTouch', author: 'Olli Parviainen', license: 'LGPL 2.1', url: 'https://www.surina.net/soundtouch/', text: LIC_LGPL_2_1 },
  { name: 'dr_flac', author: 'David Reid (mackron)', license: 'MIT / Public Domain', url: 'https://github.com/mackron/dr_libs',
    text: `${LIC_MIT}\n\n---\n\n${LIC_PUBLIC_DOMAIN}` },
  { name: 'Emscripten', author: 'Emscripten authors', license: 'MIT / UIUC', url: 'https://emscripten.org',
    text: `Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.\n\n${LIC_MIT}\n\n---\n\n`
      + 'The compiled audio engine includes the Emscripten runtime, musl libc (MIT) and\n'
      + 'LLVM libc++ (Apache 2.0 with LLVM Exceptions): https://llvm.org/LICENSE.txt' },
  { name: 'three.js', author: 'three.js authors', license: 'MIT', url: 'https://threejs.org',
    text: `Copyright © 2010-2026 three.js authors\n\n${LIC_MIT}` },
  { name: 'mp4-muxer', author: 'Vanilagy', license: 'MIT', url: 'https://github.com/Vanilagy/mp4-muxer',
    text: `Copyright (c) 2023 Vanilagy\n\n${LIC_MIT}` },
  { name: 'chords-db', author: 'David Rubert', license: 'MIT', url: 'https://github.com/tombatossals/chords-db',
    text: `Copyright (c) 2016 David Rubert\n\n${LIC_MIT}` },
  { name: 'KEMAR HRTF dataset', author: 'Bill Gardner, Keith Martin — MIT Media Lab', license: 'Free use with attribution',
    url: 'https://sound.media.mit.edu/resources/KEMAR.html', text: LIC_KEMAR },
  { name: '3D head model (Audio 3D)', author: 'Meshy', license: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/',
    text: 'The listener head model used in the 3D audio scene was generated\n'
      + 'with Meshy (https://www.meshy.ai) and is licensed under the Creative\n'
      + 'Commons Attribution 4.0 International License (CC BY 4.0).' },
  { name: 'Airplane Mode (demo song)', author: 'Josh Woodward', license: 'CC BY 4.0', url: 'https://www.joshwoodward.com',
    text: '"Airplane Mode" by Josh Woodward, from the album "The Beautiful\n'
      + 'Machine", with its cover. FisionServer adds it to every new account\n'
      + 'as a demo song; it can be deleted like any other song.\n\n'
      + 'Licensed under the Creative Commons Attribution 4.0 International\n'
      + 'License (CC BY 4.0): https://creativecommons.org/licenses/by/4.0/\n\n'
      + 'The stems, chords, beats and lyrics are derived from the original\n'
      + 'recording by FisionServer.' },
  { name: 'Downbeat click sounds', author: 'Ludwig Peter Müller', license: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    text: 'Metronome sounds recorded by Ludwig Peter Müller in December 2020.\nFree to use under the license Creative Commons CC0 1.0 Universal.' },
  { name: 'Noto Sans', author: 'The Noto Project Authors', license: 'SIL OFL 1.1', url: 'https://github.com/notofonts/latin-greek-cyrillic',
    text: `Copyright 2022 The Noto Project Authors\n\n${LIC_OFL}` },
  { name: 'MusGlyphs', author: 'Dan Kreider', license: 'SIL OFL 1.1', url: 'https://www.notationcentral.com/product/musglyphs/',
    text: `Copyright (c) Dan Kreider, 2021\n\n${LIC_OFL}` },
];

/** Dialogo de licencias: lista (nombre, autor · licencia) y detalle con el texto y el enlace. */
export function openLicenses() {
  const close = h('button', { class: 'xbtn', attrs: { 'aria-label': t('web_close') } }, icon('close'));
  const titleEl = h('h2', { textContent: t('licenses_title') });
  const content = h('div');
  const dlg = h('dialog', { class: 'settings licenses', attrs: { 'aria-label': t('licenses_title') } },
    h('div', { class: 'shd' }, titleEl, close), content);

  const list = () => {
    titleEl.textContent = t('licenses_title');
    content.replaceChildren(h('p', { class: 'muted', textContent: t('licenses_intro') }),
      h('div', { class: 'lic-list', attrs: { role: 'list' } }, ...LICENSES.map((e) => {
        const b = h('button', { class: 'lic-row', attrs: { role: 'listitem' } },
          h('b', { textContent: e.name }), h('small', { textContent: t('license_meta_fmt', e.author, e.license) }));
        b.onclick = () => detail(e);
        return b;
      })));
    dlg.scrollTop = 0;
  };
  const detail = (e: LicenseEntry) => {
    titleEl.textContent = e.name;
    const back = h('button', { class: 'btn ghost lic-back' }, icon('back', 16), t('web_licenses_back'));
    back.onclick = list;
    content.replaceChildren(back,
      h('p', { class: 'lic-meta', textContent: t('license_meta_fmt', e.author, e.license) }),
      h('pre', { class: 'lic-text', textContent: e.text }),
      h('a', { class: 'lic-visit', href: e.url, target: '_blank', rel: 'noopener noreferrer', textContent: t('license_detail_visit') }));
    dlg.scrollTop = 0;
    back.focus();
  };

  list();
  close.onclick = () => dlg.close();
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
