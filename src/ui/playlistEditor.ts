// Editor de playlist (PlaylistEditActivity + playlist_song_picker_dialog): titulo, portada cuadrada,
// canciones con arrastrar (o Alt+flechas) y quitar, y anadir solo de las que estan en la nube.
import { ApiError, type Api, type Playlist } from '../api/client.ts';
import { t } from '../i18n/i18n.ts';
import { fold, type Row } from '../library/library.ts';
import { errorKey, move, pickable, TITLE_MAX, validate } from '../library/playlists.ts';
import { h, img } from './dom.ts';
import { icon } from './icons.ts';

const COVER_PX = 512;

export interface EditorCtx {
  api: Api;
  rows: Row[];
  cover(hash: string): Promise<string | null>;
  /** Portada actual de la playlist (null = mosaico). */
  playlistCover: string | null;
  onSaved(id: string): void;
}

/** Recorte cuadrado centrado a 512 px (CropAvatarActivity con EXTRA_SQUARE_COVER). */
export async function squareCover(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height), c = document.createElement('canvas');
  c.width = c.height = Math.min(COVER_PX, side);
  const x = c.getContext('2d')!;
  x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, c.width, c.height);
  bmp.close();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.9));
}

export function openPlaylistEditor(pl: Playlist | null, ctx: EditorCtx): HTMLDialogElement {
  let songs = pl ? pl.songs.filter((s) => ctx.rows.some((r) => r.entry.hash === s)) : [];
  let picked: Blob | null = null, removeCover = false, busy = false;
  const byHash = new Map(ctx.rows.map((r) => [r.entry.hash, r]));

  const title = h('input', { class: 'field', value: pl?.title ?? '', maxLength: TITLE_MAX, placeholder: t('playlist_title_hint'), attrs: { 'aria-label': t('playlist_title_hint') } });
  const err = h('p', { class: 'plerr', attrs: { role: 'alert' } });
  const coverBox = h('span', { class: 'pcv big' });
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true });
  const change = h('button', { class: 'btn ghost', textContent: t('playlist_change_cover') });
  const drop = h('button', { class: 'btn ghost', textContent: t('playlist_remove_cover') });
  const list = h('ol', { class: 'plsongs' });
  const pickQ = h('input', { type: 'search', class: 'field', placeholder: t('playlist_search_hint'), attrs: { 'aria-label': t('playlist_search_hint') } });
  const pickList = h('div', { class: 'plpick', attrs: { role: 'list' } });
  const picker = h('div', { class: 'plpicker', hidden: true }, pickQ, pickList);
  const add = h('button', { class: 'btn ghost', textContent: t('playlist_add_songs'), attrs: { 'aria-expanded': 'false' } });
  const save = h('button', { class: 'btn', textContent: t('playlist_save') });
  const cancel = h('button', { class: 'btn ghost', textContent: t('playlist_cancel') });
  const close = h('button', { class: 'xbtn', attrs: { 'aria-label': t('web_close') } }, icon('close'));

  const paintCover = async () => {
    // Portada elegida > la del server (si no se quita) > mosaico de las primeras canciones
    let urls: string[] = [];
    if (picked) urls = [URL.createObjectURL(picked)];
    else if (ctx.playlistCover && !removeCover) urls = [ctx.playlistCover];
    else {
      const hs = songs.length >= 4 ? songs.slice(0, 4) : songs.slice(0, 1);
      urls = (await Promise.all(hs.map((s) => ctx.cover(s)))).filter((u): u is string => !!u);
    }
    coverBox.classList.toggle('mosaic', urls.length > 1);
    coverBox.replaceChildren(...urls.map((u) => img(u, '', '')));
    drop.hidden = !(picked || (ctx.playlistCover && !removeCover));
  };

  const renderSongs = () => {
    list.replaceChildren(...songs.map((hsh, i) => {
      const r = byHash.get(hsh)!, cv = h('span', { class: 'cv' });
      void ctx.cover(hsh).then((u) => { if (u) cv.append(img(u, '', '')); });
      const rm = h('button', { class: 'ib plrm', attrs: { 'aria-label': `${t('playlist_remove_song')}: ${r.entry.title || r.entry.filename}` } }, icon('close', 16));
      rm.onclick = () => { songs = songs.filter((x) => x !== hsh); renderSongs(); renderPick(); void paintCover(); };
      const li = h('li', { class: 'plsong', draggable: true, tabIndex: 0, attrs: { 'aria-label': `${r.entry.title || r.entry.filename}. ${t('playlist_reorder')}: Alt + ↑ ↓` } },
        h('span', { class: 'grip' }, icon('grip', 16)), cv,
        h('span', { class: 'tx' }, h('b', { textContent: r.entry.title || r.entry.filename }), h('span', { textContent: r.entry.artist })), rm);
      li.dataset.i = String(i);
      li.ondragstart = (e) => { e.dataTransfer?.setData('text/plain', String(i)); li.classList.add('drag'); };
      li.ondragend = () => li.classList.remove('drag');
      li.ondragover = (e) => { e.preventDefault(); li.classList.add('over'); };
      li.ondragleave = () => li.classList.remove('over');
      li.ondrop = (e) => { e.preventDefault(); const from = +(e.dataTransfer?.getData('text/plain') ?? -1); songs = move(songs, from, i); renderSongs(); void paintCover(); };
      li.onkeydown = (e) => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const to = i + (e.key === 'ArrowUp' ? -1 : 1);
        if (to < 0 || to >= songs.length) return;
        songs = move(songs, i, to); renderSongs(); void paintCover();
        (list.children[to] as HTMLElement).focus();
      };
      return li;
    }));
    if (!songs.length) list.append(h('li', { class: 'empty', textContent: t('playlist_empty_songs') }));
  };

  const renderPick = () => {
    const q = fold(pickQ.value.trim()), have = new Set(songs);
    const avail = pickable(ctx.rows).filter((r) => !have.has(r.entry.hash) && (!q || fold(`${r.entry.title} ${r.entry.artist} ${r.entry.filename}`).includes(q)));
    if (!pickable(ctx.rows).length) { pickList.replaceChildren(h('p', { class: 'empty', textContent: t('playlist_no_songs_in_cloud') })); return; }
    pickList.replaceChildren(...avail.map((r) => {
      const b = h('button', { class: 'plpk', attrs: { role: 'listitem' } }, h('span', { class: 'plus' }, icon('plus', 16)),
        h('span', { class: 'tx' }, h('b', { textContent: r.entry.title || r.entry.filename }), h('span', { textContent: r.entry.artist })));
      b.onclick = () => { songs = [...songs, r.entry.hash]; renderSongs(); renderPick(); void paintCover(); };
      return b;
    }));
  };

  const showErr = (key: [string, ...(string | number)[]]) => { err.textContent = t(...key); };

  change.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    try { picked = await squareCover(f); removeCover = false; err.textContent = ''; } catch { showErr(['playlist_err_cover_format']); }
    void paintCover();
  };
  drop.onclick = () => { picked = null; removeCover = true; void paintCover(); };
  add.onclick = () => { picker.hidden = !picker.hidden; add.setAttribute('aria-expanded', String(!picker.hidden)); if (!picker.hidden) { renderPick(); pickQ.focus(); } };
  pickQ.oninput = renderPick;

  save.onclick = async () => {
    if (busy) return;
    const bad = validate(title.value, songs);
    if (bad) { showErr(errorKey(400, bad)); return; }
    busy = true; save.disabled = true; err.textContent = '';
    let id = pl?.id ?? null;
    try {
      // Guardar = POST/PUT completo; la portada va despues, con el id
      const res = id ? await ctx.api.updatePlaylist(id, title.value.trim(), songs) : await ctx.api.createPlaylist(title.value.trim(), songs);
      id = res.id;
      try {
        if (picked) await ctx.api.putPlaylistCover(id, picked);
        else if (removeCover && ctx.playlistCover) await ctx.api.deletePlaylistCover(id);
      } catch (e) {
        // Playlist guardada, portada no: sigue como edicion (PlaylistError.savedId)
        pl = { ...res }; ctx.onSaved(id);
        if (e instanceof ApiError) showErr(errorKey(e.status, e.code, true));
        return;
      }
      dlg.close();
      ctx.onSaved(id);
    } catch (e) {
      if (e instanceof ApiError) showErr(errorKey(e.status, e.code));
      else showErr(['playlist_err_network']);
    } finally { busy = false; save.disabled = false; }
  };
  cancel.onclick = close.onclick = () => dlg.close();

  const dlg = h('dialog', { class: 'settings pled', attrs: { 'aria-label': pl ? t('playlist_edit_title') : t('playlist_new') } },
    h('div', { class: 'shd' }, h('h2', { textContent: pl ? t('playlist_edit_title') : t('playlist_new') }), close),
    h('div', { class: 'plhero' }, coverBox, h('div', { class: 'plcov' }, change, drop, file)),
    title,
    h('div', { class: 'plsh' }, h('h3', { textContent: t('playlist_song_count', songs.length) }), add),
    picker, list, err,
    h('div', { class: 'plfoot' }, cancel, save));
  const head = dlg.querySelector('.plsh h3')!;
  const obs = new MutationObserver(() => (head.textContent = t('playlist_song_count', songs.length)));
  obs.observe(list, { childList: true });
  dlg.addEventListener('close', () => { obs.disconnect(); dlg.remove(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  renderSongs(); void paintCover();
  document.body.append(dlg);
  dlg.showModal();
  title.focus();
  return dlg;
}
