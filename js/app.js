import * as store from './store.js';
import * as audius from './audius.js';
import { Player, REPEAT } from './player.js';
import { readTags, guessFromFilename, probeDuration } from './id3.js';
import * as artwork from './artwork.js';
import * as india from './india.js';

/* ==========================================================================
   Helpers
   ========================================================================== */
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = '') => `<svg class="i ${cls}"><use href="#i-${name}"/></svg>`;

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return h ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function fmtCount(n) {
  if (!n) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function totalDuration(tracks) {
  const s = tracks.reduce((a, t) => a + (t.duration || 0), 0);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} hr ${m} min` : `${m} min`;
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function gradient(seed) {
  const h = hash(String(seed)) % 360;
  return `background-image:linear-gradient(135deg,hsl(${h} 70% 45%),hsl(${(h + 60) % 360} 70% 30%))`;
}

function artHTML(t, cls = '') {
  const img = t.artwork ? `<img src="${esc(t.artwork)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="art ${cls}" style="${gradient(t.id || t.title)}">${icon('music', 'art-fallback')}${img}</div>`;
}

// Group covers build themselves from the pictures of the songs inside; emoji + colour until there are any.
function groupCover(g, cls = '') {
  const bg = `background:linear-gradient(135deg, ${esc(g.color)}, color-mix(in srgb, ${esc(g.color)} 35%, #000))`;
  const attr = g.id ? `data-group-cover="${esc(g.id)}"` : '';
  const arts = [...new Set((g.tracks || []).map((t) => t.artwork).filter(Boolean))];
  if (!arts.length) return `<div class="art group-cover ${cls}" ${attr} style="${bg}"><span>${esc(g.emoji || '🎵')}</span></div>`;
  const pics = arts.length >= 4
    ? `<div class="collage">${arts.slice(0, 4).map((a) => `<img src="${esc(a)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`).join('')}</div>`
    : `<img src="${esc(arts[0])}" alt="" loading="lazy" onerror="this.remove()">`;
  const badge = /\b(xs|sm)\b/.test(cls) ? '' : `<b class="cover-badge">${esc(g.emoji || '🎵')}</b>`;
  return `<div class="art group-cover has-pics ${cls}" ${attr} style="${bg}">${pics}${badge}</div>`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function download(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ==========================================================================
   State
   ========================================================================== */
const audio = $('#audio');
const player = new Player(audio, $('#ytDock .yt-frame'));
player.findVideo = (t) => india.findVideo(t);
const view = $('#view');
const lists = new Map();        // list key -> tracks, used by delegated click handlers
let addTarget = null;           // group id when the user is picking songs for a group
let renderToken = 0;

function registerList(key, tracks) {
  lists.set(key, tracks);
  return key;
}

/* ==========================================================================
   Theme
   ========================================================================== */
const ACCENTS = ['#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#f59e0b', '#22c55e', '#14b8a6', '#0ea5e9', '#3b82f6', '#a3e635'];
const EMOJIS = ['🎵', '🔥', '💜', '🌙', '☀️', '🎧', '🚗', '🏋️', '💔', '😌', '🎉', '🌧️', '🧘', '📚', '☕', '🎸', '🎹', '🎤', '💃', '🌊', '🌴', '❄️', '👑', '🙏'];
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const s = store.get('settings');
  const theme = s.theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : s.theme;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.setProperty('--accent', s.accent);
  const [r, g, b] = hexToRgb(s.accent);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  root.style.setProperty('--on-accent', lum > 0.6 ? '#111' : '#fff');
  $('meta[name="theme-color"]').content = theme === 'dark' ? '#0d0d12' : '#f6f5fb';
}

function hexToRgb(hex) {
  const m = hex.replace('#', '').match(/.{2}/g) || ['8b', '5c', 'f6'];
  return m.map((x) => parseInt(x, 16));
}

darkQuery.addEventListener?.('change', applyTheme);

/* ==========================================================================
   Shared fragments
   ========================================================================== */
function rowSub(t) {
  const preview = t.source === 'itunes' && !india.hasKey() ? '<span class="badge">30s preview</span>' : '';
  return [preview + esc(t.artist), t.album ? `🎬 ${esc(t.album)}` : '', t.plays ? `${fmtCount(t.plays)} plays` : '',
    t.source === 'local' ? 'On device' : t.source === 'url' ? 'Link' : t.source === 'youtube' ? 'YouTube' : '']
    .filter(Boolean).join(' · ');
}

function trackRow(t, i, listKey, { numbered = false, groupId = null } = {}) {
  const current = player.current?.id === t.id;
  const liked = store.isLiked(t.id);
  const sub = rowSub(t);
  return `
    <div class="row ${current ? 'is-current' : ''}" data-id="${esc(t.id)}" data-list="${esc(listKey)}" data-index="${i}" ${groupId ? `data-group="${esc(groupId)}"` : ''} data-action="play-row">
      ${numbered ? `<div class="row-num">${i + 1}</div>` : ''}
      ${artHTML(t, 'sm')}
      <div class="row-meta">
        <div class="row-title">${current ? '<span class="eq"><i></i><i></i><i></i></span>' : ''}${esc(t.title)}</div>
        <div class="row-sub">${sub}</div>
      </div>
      <span class="row-dur">${t.duration ? fmtTime(t.duration) : ''}</span>
      ${addTarget ? `<button class="icon-btn add-btn" data-action="quick-add" title="Add to group">${icon('plus')}</button>` : ''}
      <button class="icon-btn like-btn ${liked ? 'is-liked' : ''}" data-action="like" title="Like">${icon(liked ? 'heart-fill' : 'heart')}</button>
      <button class="icon-btn" data-action="track-menu" title="More">${icon('more')}</button>
    </div>`;
}

function trackList(tracks, listKey, opts) {
  registerList(listKey, tracks);
  if (!tracks.length) return `<div class="empty">${opts?.empty || 'No songs here yet.'}</div>`;
  return `<div class="track-list">${tracks.map((t, i) => trackRow(t, i, listKey, opts)).join('')}</div>`;
}

function trackCard(t, i, listKey) {
  return `
    <div class="card" data-action="play-row" data-list="${esc(listKey)}" data-index="${i}" data-id="${esc(t.id)}">
      <div class="card-art">${artHTML(t)}<button class="card-play" data-action="play-row" title="Play">${icon('play')}</button></div>
      <div class="card-title">${esc(t.title)}</div>
      <div class="card-sub">${esc(t.artist)}</div>
    </div>`;
}

function trackShelf(tracks, listKey) {
  registerList(listKey, tracks);
  return `<div class="shelf">${tracks.map((t, i) => trackCard(t, i, listKey)).join('')}</div>`;
}

function playlistCard(p) {
  return `
    <a class="card" href="#/playlist/${encodeURIComponent(p.id)}">
      <div class="card-art">${artHTML(p)}</div>
      <div class="card-title">${esc(p.title)}</div>
      <div class="card-sub">${esc(p.artist)}${p.count ? ` · ${p.count} songs` : ''}</div>
    </a>`;
}

function groupCard(g) {
  return `
    <a class="card" href="#/group/${encodeURIComponent(g.id)}">
      <div class="card-art">${groupCover(g)}</div>
      <div class="card-title">${esc(g.name)}</div>
      <div class="card-sub">${g.tracks.length} song${g.tracks.length === 1 ? '' : 's'}</div>
    </a>`;
}

function sectionHead(title, link) {
  return `<div class="section-head"><h2>${title}</h2>${link ? `<a href="${link.href}" class="see-all">${link.label}</a>` : ''}</div>`;
}

function skeletonRows(n = 6) {
  return `<div class="track-list">${Array.from({ length: n }, () => '<div class="row skeleton"><div class="art sm"></div><div class="row-meta"><div class="sk-line"></div><div class="sk-line short"></div></div></div>').join('')}</div>`;
}

function errorBox(msg, retryAction = 'retry') {
  return `<div class="error-box"><p>${esc(msg)}</p><p class="muted">Check your connection — you can still play songs saved on your device from the Library.</p><button class="btn" data-action="${retryAction}">Try again</button></div>`;
}

function addBanner() {
  const g = addTarget && store.getGroup(addTarget);
  if (!g) return '';
  return `<div class="add-banner">${groupCover(g, 'xs')}<span>Adding songs to <b>${esc(g.name)}</b> — tap ${icon('plus')} on any song</span><button class="btn sm" data-action="done-adding">Done</button></div>`;
}

/* ==========================================================================
   Views
   ========================================================================== */
const routes = {
  home: renderHome,
  search: renderSearch,
  trending: renderTrending,
  india: renderIndia,
  library: renderLibrary,
  liked: renderLiked,
  device: renderDevice,
  recent: renderRecent,
  group: renderGroup,
  playlist: renderPlaylist,
  settings: renderSettings,
};

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const [path, query = ''] = raw.split('?');
  const [name, ...rest] = path.split('/');
  return { name: routes[name] ? name : 'home', param: decodeURIComponent(rest.join('/')), query: new URLSearchParams(query) };
}

async function render() {
  const route = parseRoute();
  const token = ++renderToken;
  lists.clear();
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === route.name || (route.name === 'group' && a.dataset.nav === 'library')));
  await routes[route.name](route, token);
  if (token === renderToken) renderSideGroups();
}

function isStale(token) { return token !== renderToken; }

function greeting() {
  const h = new Date().getHours();
  const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const name = store.get('settings').name;
  return name ? `${part}, ${esc(name)}` : part;
}

async function renderHome(route, token) {
  const groups = store.get('groups');
  const recents = store.get('recents');
  const liked = store.get('liked');
  view.innerHTML = `
    <div class="page">
      <header class="page-head home-head">
        <h1>${greeting()}</h1>
        <a href="#/settings" class="icon-btn show-mobile" title="Settings">${icon('settings')}</a>
      </header>
      <div class="quick-grid">
        <a class="quick" href="#/liked"><div class="art liked-cover">${icon('heart-fill')}</div><span>Liked songs</span><em>${liked.length}</em></a>
        ${groups.slice(0, 5).map((g) => `<a class="quick" href="#/group/${encodeURIComponent(g.id)}">${groupCover(g)}<span>${esc(g.name)}</span><em>${g.tracks.length}</em></a>`).join('')}
        ${ensureGroupArt(groups.slice(0, 5))}
        ${groups.length < 5 ? `<button class="quick quick-new" data-action="new-group"><div class="art">${icon('plus')}</div><span>New group</span></button>` : ''}
      </div>
      ${recents.length ? `<section>${sectionHead('Recently played', { href: '#/recent', label: 'See all' })}${trackShelf(recents.slice(0, 12), 'recents')}</section>` : ''}
      <section>${sectionHead(`${icon('fire', 'accent')} Trending now`, { href: '#/trending', label: 'See all' })}<div id="homeTrending">${shelfSkeleton()}</div></section>
      <section>${sectionHead(`${icon('movie', 'accent')} Latest ${esc(india.LANGS[indianLang()].label)}`, { href: `#/india/${indianLang()}`, label: 'See all' })}
        <div class="chips scroll-x lang-chips">${langChips(indianLang(), (l) => `#/india/${l}`)}</div>
        <div id="homeIndia">${shelfSkeleton()}</div>
      </section>
      <section>${sectionHead('Trending playlists')}<div id="homePlaylists">${shelfSkeleton()}</div></section>
      <section>${sectionHead('Browse by genre')}
        <div class="genre-grid">${audius.GENRES.map((g) => `<a class="genre" href="#/trending?genre=${encodeURIComponent(g)}" style="${gradient(g)}">${esc(g)}</a>`).join('')}</div>
      </section>
    </div>`;

  const time = store.get('settings').trendingTime;
  audius.trending({ time, limit: 20 }).then((tracks) => {
    if (isStale(token)) return;
    $('#homeTrending').innerHTML = tracks.length ? trackShelf(tracks, 'home-trending') : '<div class="empty">Nothing trending right now.</div>';
  }).catch(() => { if (!isStale(token)) $('#homeTrending').innerHTML = errorBox('Couldn’t load trending music.'); });

  const lang = indianLang();
  (india.hasKey() ? india.trending(lang).catch(() => india.latest(lang)) : india.latest(lang)).then((tracks) => {
    if (isStale(token)) return;
    $('#homeIndia').innerHTML = tracks.length ? trackShelf(tracks.slice(0, 20), 'home-india') : '<div class="empty">Nothing found right now.</div>';
  }).catch(() => { if (!isStale(token)) $('#homeIndia').innerHTML = errorBox('Couldn’t load Indian songs.'); });

  audius.trendingPlaylists(time, 12).then((pls) => {
    if (isStale(token)) return;
    $('#homePlaylists').innerHTML = `<div class="shelf">${pls.map(playlistCard).join('')}</div>`;
  }).catch(() => { if (!isStale(token)) $('#homePlaylists').innerHTML = ''; });
}

function shelfSkeleton() {
  return `<div class="shelf">${Array.from({ length: 6 }, () => '<div class="card skeleton"><div class="card-art"><div class="art"></div></div><div class="sk-line"></div><div class="sk-line short"></div></div>').join('')}</div>`;
}

async function renderTrending(route, token) {
  const genre = route.query.get('genre') || '';
  const time = route.query.get('time') || store.get('settings').trendingTime;
  const link = (params) => {
    const q = new URLSearchParams({ ...(genre ? { genre } : {}), time, ...params });
    for (const [k, v] of [...q]) if (!v) q.delete(k);
    return `#/trending?${q}`;
  };
  view.innerHTML = `
    <div class="page">
      ${addBanner()}
      <header class="page-head"><h1>${icon('fire', 'accent')} Trending${genre ? ` · ${esc(genre)}` : ''}</h1></header>
      <div class="tabs">
        ${[['week', 'This week'], ['month', 'This month'], ['allTime', 'All time']].map(([v, l]) => `<a class="tab ${time === v ? 'active' : ''}" href="${link({ time: v })}">${l}</a>`).join('')}
      </div>
      <div class="chips scroll-x">
        <a class="chip ${!genre ? 'active' : ''}" href="${link({ genre: '' })}">All genres</a>
        ${audius.GENRES.map((g) => `<a class="chip ${genre === g ? 'active' : ''}" href="${link({ genre: g })}">${esc(g)}</a>`).join('')}
      </div>
      <div class="list-actions" id="trendActions"></div>
      <div id="trendList">${skeletonRows(10)}</div>
    </div>`;
  try {
    const tracks = await audius.trending({ genre, time, limit: 50 });
    if (isStale(token)) return;
    $('#trendList').innerHTML = trackList(tracks, 'trending', { numbered: true, empty: 'Nothing trending in this genre yet.' });
    if (tracks.length) $('#trendActions').innerHTML = playButtons('trending', `Save as group`);
  } catch {
    if (!isStale(token)) $('#trendList').innerHTML = errorBox('Couldn’t load trending music.');
  }
}

/* ---------- Indian music ---------- */
function indianLang() {
  const l = store.get('settings').indianLang;
  return india.LANGS[l] ? l : 'telugu';
}

function langChips(active, href) {
  return Object.entries(india.LANGS).map(([k, v]) => `<a class="chip ${k === active ? 'active' : ''}" href="${href(k)}">${esc(v.label)}</a>`).join('');
}

async function renderIndia(route, token) {
  const lang = india.LANGS[route.param] ? route.param : indianLang();
  if (lang !== store.get('settings').indianLang) store.setting('indianLang', lang);
  const L = india.LANGS[lang];
  const key = india.hasKey();
  const section = (id, title, sub) => `<section id="${id}">${sectionHead(title)}${sub ? `<p class="muted small sub">${sub}</p>` : ''}<div class="list-actions" id="${id}Actions"></div><div id="${id}List">${skeletonRows(6)}</div></section>`;
  view.innerHTML = `
    <div class="page">
      ${addBanner()}
      <header class="page-head"><h1>${icon('movie', 'accent')} ${esc(L.label)} music</h1></header>
      <div class="chips scroll-x">${langChips(lang, (l) => `#/india/${l}`)}</div>
      ${key ? '' : `
        <div class="info-card">
          <div><b>Want full songs?</b> Right now these play Apple’s official 30-second previews. Add a free YouTube key (5 minutes, no payment) and every song plays in full from the labels’ official YouTube uploads.</div>
          <a class="btn sm" href="#/settings">Set up full songs</a>
        </div>`}
      ${key ? section('inTrend', `${icon('fire', 'accent')} Trending this month`, 'Most-watched new songs on YouTube in the last 30 days') : ''}
      ${key ? section('inLabels', 'Fresh from the labels', `Newest uploads from ${L.handles.map((h) => h.slice(1)).slice(0, 3).join(', ')} and more`) : ''}
      ${section('inLatest', 'Latest releases', 'Newest songs in Apple Music India, by release date')}
      ${section('inTop', 'Top charts', 'Apple Music India top songs')}
    </div>`;
  const fill = (id, listKey, promise, opts = {}) => promise.then((tracks) => {
    if (isStale(token)) return;
    if (!tracks.length && opts.hideEmpty) { $(`#${id}`)?.remove(); return; }
    $(`#${id}List`).innerHTML = trackList(tracks, listKey, { numbered: opts.numbered, empty: 'Nothing here right now.' });
    if (tracks.length) $(`#${id}Actions`).innerHTML = playButtons(listKey, 'Save as group');
  }).catch((e) => {
    if (isStale(token)) return;
    if (opts.hideEmpty) { $(`#${id}`)?.remove(); return; }
    $(`#${id}List`).innerHTML = `<div class="empty">${esc(e.message || 'Couldn’t load this list.')}</div>`;
  });
  if (key) {
    fill('inTrend', 'india-trend', india.trending(lang), { numbered: true });
    fill('inLabels', 'india-labels', india.fromLabels(lang));
  }
  fill('inLatest', 'india-latest', india.latest(lang));
  fill('inTop', 'india-top', india.topChart(lang), { numbered: true, hideEmpty: true });
}

function playButtons(listKey, saveLabel) {
  return `
    <button class="play-btn lg" data-action="play-list" data-list="${listKey}" title="Play">${icon('play')}</button>
    <button class="icon-btn" data-action="shuffle-list" data-list="${listKey}" title="Shuffle">${icon('shuffle')}</button>
    ${saveLabel ? `<button class="btn ghost sm" data-action="save-list-as-group" data-list="${listKey}">${icon('plus')} ${saveLabel}</button>` : ''}`;
}

let searchSeq = 0;
async function renderSearch(route) {
  const q = route.query.get('q') || '';
  view.innerHTML = `
    <div class="page">
      ${addBanner()}
      <header class="page-head"><h1>Search</h1></header>
      <div class="search-box">
        ${icon('search')}
        <input id="searchInput" type="search" placeholder="Songs, artists, playlists…" value="${esc(q)}" autocomplete="off" enterkeyhint="search" />
        <button class="icon-btn sm ${q ? '' : 'hidden'}" data-action="clear-search" title="Clear">${icon('close')}</button>
      </div>
      <div id="searchResults"></div>
    </div>`;
  const input = $('#searchInput');
  const run = debounce((value) => {
    const url = `#/search${value ? `?q=${encodeURIComponent(value)}` : ''}`;
    history.replaceState(history.state, '', url);
    $('[data-action="clear-search"]').classList.toggle('hidden', !value);
    searchResults(value);
  }, 350);
  input.addEventListener('input', () => run(input.value.trim()));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { store.pushSearch(input.value); input.blur(); } });
  if (!q && matchMedia('(min-width: 800px)').matches) input.focus();
  searchResults(q);
}

async function searchResults(q) {
  const box = $('#searchResults');
  if (!box) return;
  const seq = ++searchSeq;
  if (!q) {
    const recent = store.get('searches');
    box.innerHTML = `
      ${recent.length ? `<section>${sectionHead('Recent searches')}<div class="chips">${recent.map((s) => `<a class="chip" href="#/search?q=${encodeURIComponent(s)}">${esc(s)}</a>`).join('')}</div></section>` : ''}
      <section>${sectionHead('Browse by genre')}
        <div class="genre-grid">${audius.GENRES.map((g) => `<a class="genre" href="#/trending?genre=${encodeURIComponent(g)}" style="${gradient(g)}">${esc(g)}</a>`).join('')}</div>
      </section>`;
    return;
  }
  const needle = q.toLowerCase();
  const mine = dedupe([...store.get('localTracks'), ...store.get('liked'), ...store.get('groups').flatMap((g) => g.tracks)])
    .filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(needle)).slice(0, 10);
  const myGroups = store.get('groups').filter((g) => g.name.toLowerCase().includes(needle));
  box.innerHTML = `
    ${myGroups.length ? `<section>${sectionHead('Your groups')}<div class="shelf">${myGroups.map(groupCard).join('')}</div></section>` : ''}
    ${mine.length ? `<section>${sectionHead('In your library')}${trackList(mine, 'search-mine')}</section>` : ''}
    ${india.hasKey() ? `<section>${sectionHead(`${icon('movie', 'accent')} Full songs (YouTube)`)}<div id="searchYT">${skeletonRows(4)}</div></section>` : ''}
    <section>${sectionHead(`${icon('movie', 'accent')} Indian & film songs`)}<div id="searchIndia">${skeletonRows(4)}</div></section>
    <section>${sectionHead('Songs')}<div id="searchSongs">${skeletonRows(8)}</div></section>
    <section id="searchPlaylists"></section>`;
  india.searchSongs(q).then((tracks) => {
    if (seq !== searchSeq) return;
    $('#searchIndia').innerHTML = trackList(tracks.slice(0, 10), 'search-india', { empty: 'No Indian catalogue matches.' });
  }).catch(() => { if (seq === searchSeq) $('#searchIndia').innerHTML = '<div class="empty">Indian catalogue unavailable right now.</div>'; });
  if (india.hasKey()) {
    india.searchYouTube(q).then((tracks) => {
      if (seq !== searchSeq) return;
      $('#searchYT').innerHTML = trackList(tracks.filter((t) => !/#shorts/i.test(t.title)).slice(0, 10), 'search-yt', { empty: 'No YouTube matches.' });
    }).catch((e) => { if (seq === searchSeq) $('#searchYT').innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  }
  try {
    const [tracks, pls] = await Promise.all([audius.searchTracks(q), audius.searchPlaylists(q).catch(() => [])]);
    if (seq !== searchSeq) return;
    store.pushSearch(q);
    $('#searchSongs').innerHTML = trackList(tracks, 'search', { empty: `No songs found for “${esc(q)}”.` });
    if (pls.length) $('#searchPlaylists').innerHTML = `${sectionHead('Playlists')}<div class="shelf">${pls.map(playlistCard).join('')}</div>`;
  } catch {
    if (seq === searchSeq) $('#searchSongs').innerHTML = errorBox('Search is unavailable right now.', 'retry-search');
  }
}

function dedupe(tracks) {
  const seen = new Set();
  return tracks.filter((t) => !seen.has(t.id) && seen.add(t.id));
}

function renderLibrary() {
  const groups = store.get('groups');
  const local = store.get('localTracks');
  const liked = store.get('liked');
  view.innerHTML = `
    <div class="page">
      <header class="page-head"><h1>Your library</h1></header>
      <div class="lib-tiles">
        <a class="lib-tile" href="#/liked"><div class="art liked-cover">${icon('heart-fill')}</div><div><b>Liked songs</b><span>${liked.length} songs</span></div></a>
        <a class="lib-tile" href="#/device"><div class="art device-cover">${icon('library')}</div><div><b>On this device</b><span>${local.length} songs & links</span></div></a>
        <a class="lib-tile" href="#/recent"><div class="art recent-cover">${icon('timer')}</div><div><b>Recently played</b><span>${store.get('recents').length} songs</span></div></a>
      </div>
      <section>
        <div class="section-head"><h2>${icon('group', 'accent')} Your groups</h2>
          <div class="row-actions">
            <button class="btn ghost sm" data-action="import-file">${icon('download')} Import</button>
            <button class="btn sm" data-action="new-group">${icon('plus')} New group</button>
          </div>
        </div>
        ${groups.length ? `<div class="grid">${groups.map(groupCard).join('')}</div>${ensureGroupArt(groups)}` : `
          <div class="empty-hero">
            <div class="emoji">🎧</div>
            <h3>Make your first group</h3>
            <p>Groups are your own collections — moods, workouts, road trips, anything. Add trending songs, search results, or your own files.</p>
            <button class="btn" data-action="new-group">${icon('plus')} Create a group</button>
          </div>`}
      </section>
      <section>
        <div class="section-head"><h2>Add your own music</h2></div>
        <div class="add-grid">
          <button class="add-tile" data-action="upload">${icon('upload')}<b>Upload files</b><span>MP3, M4A, FLAC, WAV… stored privately on this device</span></button>
          <button class="add-tile" data-action="add-link">${icon('link')}<b>Add a link</b><span>Any direct audio or radio stream URL</span></button>
        </div>
      </section>
    </div>`;
}

function collectionPage({ title, subtitle, cover, listKey, tracks, actions = '', empty, opts = {} }) {
  view.innerHTML = `
    <div class="page">
      ${addBanner()}
      <header class="collection-head">
        ${cover}
        <div class="collection-info">
          <div class="eyebrow">${subtitle.eyebrow}</div>
          <h1>${esc(title)}</h1>
          ${subtitle.desc ? `<p class="muted">${esc(subtitle.desc)}</p>` : ''}
          <div class="muted small">${tracks.length} song${tracks.length === 1 ? '' : 's'}${totalDuration(tracks) ? ` · ${totalDuration(tracks)}` : ''}</div>
        </div>
      </header>
      <div class="list-actions">${tracks.length ? playButtons(listKey) : ''}${actions}</div>
      ${trackList(tracks, listKey, { empty, ...opts })}
    </div>`;
  artwork.ensure(tracks.filter((t) => t.source !== 'audius'));
}

function renderLiked() {
  collectionPage({
    title: 'Liked songs', subtitle: { eyebrow: 'Collection' },
    cover: `<div class="art xl liked-cover">${icon('heart-fill')}</div>`,
    listKey: 'liked', tracks: store.get('liked'),
    actions: store.get('liked').length ? `<button class="btn ghost sm" data-action="save-list-as-group" data-list="liked">${icon('plus')} Copy to group</button>` : '',
    empty: `Tap ${icon('heart')} on any song to save it here.`,
  });
}

function renderRecent() {
  collectionPage({
    title: 'Recently played', subtitle: { eyebrow: 'History' },
    cover: `<div class="art xl recent-cover">${icon('timer')}</div>`,
    listKey: 'recents', tracks: store.get('recents'),
    actions: store.get('recents').length ? `<button class="btn ghost sm" data-action="clear-recents">${icon('trash')} Clear</button>` : '',
    empty: 'Songs you play will show up here.',
  });
}

function renderDevice() {
  collectionPage({
    title: 'On this device', subtitle: { eyebrow: 'Your files & links', desc: 'Stored privately in this browser. Nothing is uploaded anywhere.' },
    cover: `<div class="art xl device-cover">${icon('library')}</div>`,
    listKey: 'device', tracks: store.get('localTracks'),
    actions: `<button class="btn sm" data-action="upload">${icon('upload')} Upload</button><button class="btn ghost sm" data-action="add-link">${icon('link')} Add link</button>`,
    empty: 'Upload songs from your phone or computer, or add a stream link.',
  });
}

function renderGroup(route) {
  const g = store.getGroup(route.param);
  if (!g) {
    view.innerHTML = `<div class="page"><div class="empty-hero"><div class="emoji">🤔</div><h3>Group not found</h3><a class="btn" href="#/library">Back to library</a></div></div>`;
    return;
  }
  collectionPage({
    title: g.name, subtitle: { eyebrow: `${esc(g.emoji)} Group`, desc: g.description },
    cover: groupCover(g, 'xl'),
    listKey: `group:${g.id}`, tracks: g.tracks,
    opts: { groupId: g.id },
    actions: `
      <button class="btn sm" data-action="add-songs" data-group="${esc(g.id)}">${icon('plus')} Add songs</button>
      <button class="icon-btn" data-action="group-menu" data-group="${esc(g.id)}" title="Group options">${icon('more')}</button>`,
    empty: 'This group is empty. Tap “Add songs” to fill it with anything you like.',
  });
}

async function renderPlaylist(route, token) {
  view.innerHTML = `<div class="page"><div class="collection-head"><div class="art xl skeleton"></div><div class="collection-info"><div class="sk-line"></div><div class="sk-line short"></div></div></div>${skeletonRows(8)}</div>`;
  try {
    const p = await audius.playlist(route.param);
    if (isStale(token)) return;
    collectionPage({
      title: p.title, subtitle: { eyebrow: `Playlist · ${esc(p.artist)}` },
      cover: artHTML(p, 'xl'),
      listKey: 'playlist', tracks: p.tracks,
      actions: p.tracks.length ? `<button class="btn ghost sm" data-action="save-list-as-group" data-list="playlist" data-name="${esc(p.title)}">${icon('plus')} Save as group</button>` : '',
    });
  } catch {
    if (!isStale(token)) view.innerHTML = `<div class="page">${errorBox('Couldn’t load this playlist.')}</div>`;
  }
}

function renderSettings() {
  const s = store.get('settings');
  view.innerHTML = `
    <div class="page narrow">
      <header class="page-head"><h1>Settings</h1></header>
      <section class="panel">
        <h3>Profile</h3>
        <label class="field"><span>Your name</span><input type="text" id="setName" value="${esc(s.name)}" placeholder="Used for the greeting" maxlength="30" /></label>
      </section>
      <section class="panel">
        <h3>Look & feel</h3>
        <div class="field"><span>Theme</span>
          <div class="seg">${['dark', 'light', 'auto'].map((t) => `<button class="${s.theme === t ? 'active' : ''}" data-action="set-theme" data-value="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
        </div>
        <div class="field"><span>Accent colour</span>
          <div class="swatches">
            ${ACCENTS.map((c) => `<button class="swatch ${s.accent === c ? 'active' : ''}" style="background:${c}" data-action="set-accent" data-value="${c}" title="${c}"></button>`).join('')}
            <label class="swatch custom" title="Custom colour" style="background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red)"><input type="color" id="customAccent" value="${esc(s.accent)}" /></label>
          </div>
        </div>
      </section>
      <section class="panel">
        <h3>Playback</h3>
        <div class="field"><span>Trending period</span>
          <div class="seg">${[['week', 'Week'], ['month', 'Month'], ['allTime', 'All time']].map(([v, l]) => `<button class="${s.trendingTime === v ? 'active' : ''}" data-action="set-trending-time" data-value="${v}">${l}</button>`).join('')}</div>
        </div>
        <div class="field"><span>Playback speed</span>
          <div class="seg">${[0.75, 1, 1.25, 1.5, 2].map((v) => `<button class="${s.speed === v ? 'active' : ''}" data-action="set-speed" data-value="${v}">${v}×</button>`).join('')}</div>
        </div>
      </section>
      <section class="panel" id="ytPanel">
        <h3>${icon('movie', 'accent')} Full Indian & film songs (YouTube)</h3>
        <p class="muted small">Telugu, Tamil, Hindi and other film songs play in full from the music labels’ official YouTube uploads. It needs a free YouTube key — no payment, about 5 minutes. YouTube may show its own ads before some songs.</p>
        <label class="field"><span>YouTube API key ${s.ytKey ? '<em class="ok">✓ connected</em>' : ''}</span>
          <input type="text" id="ytKey" value="${esc(s.ytKey)}" placeholder="Paste your key (starts with AIza…)" autocomplete="off" spellcheck="false" />
        </label>
        <div class="btn-row">
          <button class="btn sm" data-action="save-yt-key">Save & test</button>
          ${s.ytKey ? '<button class="btn ghost sm" data-action="remove-yt-key">Remove key</button>' : ''}
        </div>
        <details class="howto">
          <summary>How to get a free key (step by step)</summary>
          <ol>
            <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud Console</a> and sign in with your Google account. Create a project named <b>Echo</b>.</li>
            <li>Open <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">YouTube Data API v3</a> and press <b>Enable</b>.</li>
            <li>Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Credentials</a> → <b>Create credentials</b> → <b>API key</b>, and copy it.</li>
            <li>Recommended: click the key → <b>Application restrictions: Websites</b> → add <code>${esc(location.origin)}/*</code>, and under <b>API restrictions</b> pick <b>YouTube Data API v3</b>. Save.</li>
            <li>Paste the key above and press <b>Save & test</b>.</li>
          </ol>
          <p class="muted small">Free daily allowance: about 100 song searches a day. Songs Echo has already found are remembered and cost nothing to replay. No billing account is needed.</p>
        </details>
        <div class="field"><span>Home screen language</span>
          <div class="seg">${Object.entries(india.LANGS).map(([k, v]) => `<button class="${indianLang() === k ? 'active' : ''}" data-action="set-indian-lang" data-value="${k}">${esc(v.label)}</button>`).join('')}</div>
        </div>
      </section>
      <section class="panel">
        <h3>Your data</h3>
        <p class="muted small">Everything lives on this device. Back it up to move your groups and likes to another phone or browser.</p>
        <div class="btn-row">
          <button class="btn sm" data-action="export-all">${icon('upload')} Export backup</button>
          <button class="btn ghost sm" data-action="import-file">${icon('download')} Import backup / group</button>
          <button class="btn danger sm" data-action="reset-all">${icon('trash')} Erase everything</button>
        </div>
      </section>
      <section class="panel">
        <h3>Install Echo</h3>
        <p class="muted small">On Android/Chrome use <b>Install app</b> below or the browser menu → “Add to Home screen”. On iPhone tap Share → “Add to Home Screen”. It then opens full-screen like a native app, with lock-screen controls.</p>
        <button class="btn sm ${deferredInstall ? '' : 'hidden'}" id="installBtn" data-action="install">${icon('download')} Install app</button>
      </section>
      <section class="panel">
        <h3>Keyboard shortcuts</h3>
        <div class="shortcuts">
          <kbd>Space</kbd><span>Play / pause</span><kbd>←</kbd><kbd>→</kbd><span>Seek 10s</span>
          <kbd>N</kbd><span>Next</span><kbd>P</kbd><span>Previous</span>
          <kbd>S</kbd><span>Shuffle</span><kbd>R</kbd><span>Repeat</span>
          <kbd>L</kbd><span>Like</span><kbd>M</kbd><span>Mute</span>
          <kbd>/</kbd><span>Search</span><kbd>Q</kbd><span>Queue</span>
        </div>
      </section>
      <p class="muted small center">Echo · ad-free, no account, no tracking. Streaming catalogue by <a href="https://audius.co" target="_blank" rel="noopener">Audius</a>.</p>
    </div>`;
  $('#setName').addEventListener('change', (e) => { store.setting('name', e.target.value.trim()); toast('Saved'); });
  $('#customAccent').addEventListener('input', (e) => { store.setting('accent', e.target.value); applyTheme(); });
  $('#customAccent').addEventListener('change', () => renderSettings());
}

function ensureGroupArt(groups) {
  artwork.ensure(groups.flatMap((g) => g.tracks.slice(0, 8)).filter((t) => t.source !== 'audius'));
  return '';
}

function renderSideGroups() {
  const groups = store.get('groups');
  const active = parseRoute();
  $('#sideGroups').innerHTML = `
    <a class="side-group ${active.name === 'liked' ? 'active' : ''}" href="#/liked"><div class="art xs liked-cover">${icon('heart-fill')}</div><span>Liked songs</span></a>
    ${groups.map((g) => `<a class="side-group ${active.name === 'group' && active.param === g.id ? 'active' : ''}" href="#/group/${encodeURIComponent(g.id)}">${groupCover(g, 'xs')}<span>${esc(g.name)}</span></a>`).join('')}`;
}

/* ==========================================================================
   Sheets (bottom sheets on mobile, dialogs on desktop)
   ========================================================================== */
const sheetRoot = $('#sheetRoot');
const sheet = $('.sheet', sheetRoot);
let sheetOnClose = null;
let sheetKind = null;

function openSheet(html, { kind = null, onClose = null } = {}) {
  const wasOpen = sheetRoot.classList.contains('open');
  sheet.innerHTML = `<div class="sheet-grip"></div>${html}`;
  sheetKind = kind;
  sheetOnClose = onClose;
  sheetRoot.classList.add('open');
  sheetRoot.setAttribute('aria-hidden', 'false');
  if (!wasOpen) pushOverlay('sheet');
  const first = $('input:not([type=color]), textarea', sheet);
  if (first && matchMedia('(min-width: 800px)').matches) setTimeout(() => first.focus(), 50);
}

function closeSheet({ fromHistory = false } = {}) {
  if (!sheetRoot.classList.contains('open')) return;
  sheetRoot.classList.remove('open');
  sheetRoot.setAttribute('aria-hidden', 'true');
  sheetKind = null;
  const cb = sheetOnClose;
  sheetOnClose = null;
  cb?.();
  if (!fromHistory) popOverlay('sheet');
}

function menuItem(action, ic, label, data = {}) {
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  return `<button class="menu-item" data-action="${action}" ${attrs}>${icon(ic)}<span>${label}</span></button>`;
}

function sheetTrackHead(t) {
  return `<div class="sheet-track">${artHTML(t, 'md')}<div class="row-meta"><div class="row-title">${esc(t.title)}</div><div class="row-sub">${esc(t.artist)}</div></div></div>`;
}

// The track a sheet is acting on; menus reference it rather than serialising tracks into the DOM.
let sheetTrack = null;
let sheetContext = {};

function openTrackMenu(track, context = {}) {
  sheetTrack = track;
  sheetContext = context;
  const liked = store.isLiked(track.id);
  const items = [
    menuItem('menu-play-next', 'play-next', 'Play next'),
    menuItem('menu-add-queue', 'add-queue', 'Add to queue'),
    menuItem('menu-add-group', 'group', 'Add to group…'),
    menuItem('menu-like', liked ? 'heart-fill' : 'heart', liked ? 'Remove from Liked' : 'Add to Liked'),
  ];
  if (context.groupId) {
    items.push(menuItem('menu-move', 'up', 'Move up', { dir: -1 }), menuItem('menu-move', 'down', 'Move down', { dir: 1 }));
    items.push(menuItem('menu-remove-group', 'close', 'Remove from this group'));
  }
  if (context.queuePos !== undefined) items.push(menuItem('menu-remove-queue', 'close', 'Remove from queue'));
  if (track.source === 'local' || track.source === 'url') items.push(menuItem('menu-rename', 'edit', 'Edit title & artist'));
  if (track.link) items.push(menuItem('menu-share', 'share', 'Share'));
  if (track.source === 'local' || track.source === 'url') items.push(menuItem('menu-delete-local', 'trash', 'Delete from this device'));
  openSheet(`${sheetTrackHead(track)}<div class="menu">${items.join('')}</div>`);
}

function openAddToGroup(tracks) {
  const groups = store.get('groups');
  sheetTrack = tracks;
  openSheet(`
    <h3 class="sheet-title">Add ${tracks.length > 1 ? `${tracks.length} songs` : 'to group'}</h3>
    <div class="menu">
      <button class="menu-item" data-action="new-group-with-tracks">${icon('plus')}<span>New group</span></button>
      ${groups.map((g) => `<button class="menu-item" data-action="pick-group" data-group="${esc(g.id)}">${groupCover(g, 'xs')}<span>${esc(g.name)}</span><em>${g.tracks.length}</em></button>`).join('')}
    </div>`);
}

function openGroupEditor(group, tracks = []) {
  const g = group || { name: '', emoji: '🎵', color: ACCENTS[hash(String(Date.now())) % ACCENTS.length], description: '' };
  openSheet(`
    <h3 class="sheet-title">${group ? 'Edit group' : 'New group'}</h3>
    <form class="form" id="groupForm">
      <div class="group-preview" id="groupPreview">${groupCover(g, 'lg')}</div>
      <label class="field"><span>Name</span><input name="name" required maxlength="60" placeholder="e.g. Late night drives" value="${esc(g.name)}" /></label>
      <label class="field"><span>Description <em>(optional)</em></span><input name="description" maxlength="140" placeholder="What’s the vibe?" value="${esc(g.description)}" /></label>
      <div class="field"><span>Emoji</span><div class="emoji-grid">${EMOJIS.map((e) => `<button type="button" class="emoji-opt ${g.emoji === e ? 'active' : ''}" data-emoji="${e}">${e}</button>`).join('')}</div></div>
      <div class="field"><span>Colour</span><div class="swatches">${ACCENTS.map((c) => `<button type="button" class="swatch ${g.color === c ? 'active' : ''}" style="background:${c}" data-color="${c}"></button>`).join('')}</div></div>
      <div class="btn-row end">
        <button type="button" class="btn ghost" data-action="close-sheet">Cancel</button>
        <button type="submit" class="btn">${group ? 'Save' : 'Create'}</button>
      </div>
    </form>`);
  const form = $('#groupForm');
  const draft = { emoji: g.emoji, color: g.color };
  const refresh = () => { $('#groupPreview').innerHTML = groupCover({ ...draft }, 'lg'); };
  form.addEventListener('click', (e) => {
    const emo = e.target.closest('[data-emoji]');
    const col = e.target.closest('[data-color]');
    if (emo) { draft.emoji = emo.dataset.emoji; $$('.emoji-opt', form).forEach((b) => b.classList.toggle('active', b === emo)); refresh(); }
    if (col) { draft.color = col.dataset.color; $$('.swatch', form).forEach((b) => b.classList.toggle('active', b === col)); refresh(); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = { name: form.name.value.trim(), description: form.description.value.trim(), ...draft };
    if (!data.name) return;
    if (group) {
      store.updateGroup(group.id, data);
      updateContextUI();
      closeSheet();
      toast('Group updated');
      render();
    } else {
      const created = store.createGroup({ ...data, tracks });
      closeSheet();
      toast(tracks.length ? `Created “${created.name}” with ${tracks.length} song${tracks.length === 1 ? '' : 's'}` : `Created “${created.name}”`);
      if (!tracks.length) navigate(`#/group/${encodeURIComponent(created.id)}`);
      else render();
    }
  });
}

function openGroupMenu(id) {
  const g = store.getGroup(id);
  if (!g) return;
  openSheet(`
    <div class="sheet-track">${groupCover(g, 'md')}<div class="row-meta"><div class="row-title">${esc(g.name)}</div><div class="row-sub">${g.tracks.length} songs</div></div></div>
    <div class="menu">
      ${menuItem('edit-group', 'edit', 'Edit name, emoji & colour', { group: id })}
      ${menuItem('queue-group', 'add-queue', 'Add all to queue', { group: id })}
      ${menuItem('share-group', 'share', 'Share / export group', { group: id })}
      ${menuItem('duplicate-group', 'plus', 'Duplicate', { group: id })}
      ${menuItem('delete-group', 'trash', 'Delete group', { group: id })}
    </div>`);
}

function openQueue() {
  const render = () => {
    const cur = player.current;
    const up = player.upcoming;
    registerList('queue-up', up);
    return `
      <div class="sheet-head"><h3 class="sheet-title">Queue</h3>${up.length ? `<button class="btn ghost sm" data-action="clear-queue">Clear</button>` : ''}</div>
      <div class="queue">
        ${cur ? `<div class="eyebrow">Now playing</div>${sheetTrackHead(cur)}` : '<div class="empty">Nothing is playing.</div>'}
        ${up.length ? `<div class="eyebrow">Up next · ${up.length}</div>` : ''}
        ${up.map((t, i) => `
          <div class="row q-row" data-action="queue-jump" data-qpos="${player.pos + 1 + i}" data-id="${esc(t.id)}">
            ${artHTML(t, 'sm')}
            <div class="row-meta"><div class="row-title">${esc(t.title)}</div><div class="row-sub">${esc(t.artist)}</div></div>
            <button class="icon-btn sm" data-action="queue-move" data-dir="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
            <button class="icon-btn sm" data-action="queue-move" data-dir="1" title="Move down" ${i === up.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
            <button class="icon-btn sm" data-action="queue-remove" title="Remove">${icon('close')}</button>
          </div>`).join('')}
      </div>`;
  };
  openSheet(render(), { kind: 'queue' });
  queueRenderer = render;
}
let queueRenderer = null;

function refreshQueueSheet() {
  if (sheetKind === 'queue' && queueRenderer) {
    const scroll = sheet.scrollTop;
    sheet.innerHTML = `<div class="sheet-grip"></div>${queueRenderer()}`;
    sheet.scrollTop = scroll;
  }
}

function openSleepTimer() {
  const opts = [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], ['end', 'End of this song']];
  openSheet(`
    <h3 class="sheet-title">Sleep timer</h3>
    <div class="menu">
      ${opts.map(([v, l]) => menuItem('set-sleep', 'timer', l, { value: v })).join('')}
      ${player.sleep ? menuItem('set-sleep', 'close', 'Turn off timer', { value: 0 }) : ''}
    </div>`);
}

function openSpeed() {
  const cur = store.get('settings').speed;
  openSheet(`
    <h3 class="sheet-title">Playback speed</h3>
    <div class="menu">${[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((v) => `<button class="menu-item ${cur === v ? 'active' : ''}" data-action="set-speed" data-value="${v}">${icon('speed')}<span>${v}×${v === 1 ? ' (normal)' : ''}</span></button>`).join('')}</div>`);
}

function openAddLink() {
  openSheet(`
    <h3 class="sheet-title">Add a link</h3>
    <form class="form" id="linkForm">
      <label class="field"><span>Audio URL</span><input name="url" type="url" required placeholder="https://example.com/song.mp3 or radio stream" /></label>
      <label class="field"><span>Title <em>(optional)</em></span><input name="title" maxlength="100" /></label>
      <label class="field"><span>Artist <em>(optional)</em></span><input name="artist" maxlength="100" /></label>
      <p class="muted small">Works with direct links to audio files (MP3, AAC, OGG…) and internet radio streams.</p>
      <div class="btn-row end"><button type="button" class="btn ghost" data-action="close-sheet">Cancel</button><button class="btn" type="submit">Add</button></div>
    </form>`);
  $('#linkForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const track = store.addUrlTrack({ url: f.url.value.trim(), title: f.title.value.trim(), artist: f.artist.value.trim() });
    closeSheet();
    if (addTarget) store.addToGroup(addTarget, [track]);
    toast('Link added');
    render();
  });
}

function openRename(track) {
  openSheet(`
    <h3 class="sheet-title">Edit details</h3>
    <form class="form" id="renameForm">
      <label class="field"><span>Title</span><input name="title" required maxlength="100" value="${esc(track.title)}" /></label>
      <label class="field"><span>Artist</span><input name="artist" maxlength="100" value="${esc(track.artist)}" /></label>
      <div class="btn-row end"><button type="button" class="btn ghost" data-action="close-sheet">Cancel</button><button class="btn" type="submit">Save</button></div>
    </form>`);
  $('#renameForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const patch = { title: e.target.title.value.trim() || track.title, artist: e.target.artist.value.trim() || 'Unknown artist' };
    store.updateTrackMeta(track.id, patch);
    player.queue.forEach((t) => { if (t.id === track.id) Object.assign(t, patch); });
    closeSheet();
    updatePlayerUI();
    render();
  });
}

function confirmSheet(message, confirmLabel, onConfirm) {
  openSheet(`
    <h3 class="sheet-title">${message}</h3>
    <div class="btn-row end"><button class="btn ghost" data-action="close-sheet">Cancel</button><button class="btn danger" data-action="confirm-yes">${confirmLabel}</button></div>`);
  confirmHandler = onConfirm;
}
let confirmHandler = null;

/* ==========================================================================
   Now playing overlay + history integration for the back button
   ========================================================================== */
const np = $('#nowPlaying');
const overlays = [];

function pushOverlay(name) {
  overlays.push(name);
  history.pushState({ overlay: name, depth: overlays.length }, '', location.href);
}

let backPending = false;
let navAfterBack = null;

function popOverlay(name) {
  const i = overlays.lastIndexOf(name);
  if (i === -1) return;
  overlays.splice(i, 1);
  if (history.state?.overlay === name) { backPending = true; history.back(); }
}

// Change route; waits for any in-flight history.back() from closing an overlay so the two don't race.
function navigate(hash) {
  if (backPending) navAfterBack = hash;
  else location.hash = hash;
}

window.addEventListener('popstate', () => {
  if (backPending) {
    backPending = false;
    if (navAfterBack) { const h = navAfterBack; navAfterBack = null; location.hash = h; }
    return;
  }
  // Back button: close the top-most overlay instead of leaving the page.
  const depth = history.state?.depth || 0;
  while (overlays.length > depth) {
    const top = overlays.pop();
    if (top === 'sheet') closeSheet({ fromHistory: true });
    if (top === 'np') closeNowPlaying({ fromHistory: true });
  }
});

// YouTube's video must stay visible: full size over the artwork on the Now Playing screen,
// otherwise a small floating window above the player bar.
const dock = $('#ytDock');
function updateDock() {
  const show = player.onYouTube && !!player.current;
  dock.classList.toggle('show', show);
  document.body.classList.toggle('on-youtube', show);
  if (!show) return;
  const npOpen = np.classList.contains('open');
  dock.classList.toggle('in-np', npOpen);
  if (npOpen) {
    const r = $('.np-art').getBoundingClientRect();
    Object.assign(dock.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, right: '', bottom: '' });
  } else {
    dock.removeAttribute('style');
  }
}
addEventListener('resize', () => updateDock());

function openNowPlaying() {
  if (!player.current || np.classList.contains('open')) return;
  np.classList.add('open');
  np.setAttribute('aria-hidden', 'false');
  pushOverlay('np');
  setTimeout(updateDock, 380); // after the slide-up animation
}

function closeNowPlaying({ fromHistory = false } = {}) {
  if (!np.classList.contains('open')) return;
  np.classList.remove('open');
  np.setAttribute('aria-hidden', 'true');
  updateDock();
  if (!fromHistory) popOverlay('np');
}

/* ==========================================================================
   Player UI
   ========================================================================== */
const playerBar = $('#playerBar');
let seeking = false;

function updatePlayerUI() {
  const t = player.current;
  playerBar.classList.toggle('is-empty', !t);
  document.body.classList.toggle('has-player', !!t);
  const title = t ? t.title : 'Nothing playing';
  const artist = t ? t.artist : 'Pick a song to start';
  $('.pb-title').textContent = title;
  $('.pb-artist').textContent = artist;
  $('.np-title').textContent = title;
  $('.np-artist').textContent = t ? t.artist : '';
  updateContextUI();
  if (playerBar.dataset.track !== (t?.id || '')) {
    playerBar.dataset.track = t?.id || '';
    $('.pb-art').outerHTML = t ? artHTML(t, 'pb-art') : '<div class="pb-art art"></div>';
    $('.np-art').outerHTML = t ? artHTML(t, 'np-art') : '<div class="np-art art"></div>';
    $('.np-bg').style.backgroundImage = t?.artwork ? `url("${t.artwork.replace(/"/g, '%22')}")` : '';
    document.title = t ? `${t.title} · ${t.artist} — Echo` : 'Echo — Music Player';
  }
  updateLikeUI();
  updateStateUI();
  updateModeUI();
  markCurrentRows();
}

function updateContextUI() {
  const ctx = player.context;
  const g = ctx?.groupId && store.getGroup(ctx.groupId);
  const label = g ? g.name : ctx?.label;
  $('.np-context').innerHTML = label
    ? `<small>Playing from</small><span>${g ? `${esc(g.emoji)} ` : ''}${esc(label)}</span>`
    : 'Now playing';
  $('.np-context').classList.toggle('linked', !!ctx?.href);
  $('.pb-meta').title = label ? `Playing from ${label}` : '';
}

function updateStateUI() {
  const playing = player.playing;
  $$('[data-action="toggle"] use').forEach((u) => u.setAttribute('href', playing ? '#i-pause' : '#i-play'));
  document.body.classList.toggle('is-playing', playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = player.current ? (playing ? 'playing' : 'paused') : 'none';
}

function updateModeUI() {
  $$('[data-action="shuffle"]').forEach((b) => b.classList.toggle('on', player.shuffle));
  $$('[data-action="repeat"]').forEach((b) => {
    b.classList.toggle('on', player.repeat !== REPEAT.OFF);
    $('use', b).setAttribute('href', player.repeat === REPEAT.ONE ? '#i-repeat-one' : '#i-repeat');
  });
}

function updateLikeUI() {
  const liked = player.current && store.isLiked(player.current.id);
  $$('[data-action="like-current"]').forEach((b) => {
    b.classList.toggle('is-liked', !!liked);
    $('use', b).setAttribute('href', liked ? '#i-heart-fill' : '#i-heart');
  });
}

function updateTimeUI() {
  const a = player.media;
  const dur = isFinite(a.duration) ? a.duration : (player.current?.duration || 0);
  const cur = a.currentTime || 0;
  const pct = dur ? cur / dur : 0;
  if (!seeking) $$('.seek').forEach((s) => { s.value = Math.round(pct * 1000); s.style.setProperty('--p', `${pct * 100}%`); });
  if (!seeking) $$('.time.cur').forEach((el) => { el.textContent = fmtTime(cur); });
  $$('.time.dur').forEach((el) => { el.textContent = isFinite(a.duration) || dur ? fmtTime(dur) : 'LIVE'; });
  $('.mini-progress div').style.width = `${pct * 100}%`;
}

function updateVolumeUI() {
  const v = player.muted ? 0 : player.volume;
  const range = $('.volume');
  range.value = Math.round(v * 100);
  range.style.setProperty('--p', `${v * 100}%`);
  $('.vol-icon use').setAttribute('href', v === 0 ? '#i-volume-off' : '#i-volume');
}

function setArt(el, url) {
  const img = $('img', el);
  if (img) img.src = url;
  else el.insertAdjacentHTML('beforeend', `<img src="${esc(url)}" alt="" onerror="this.remove()">`);
}

const refreshGroupCovers = debounce(() => {
  $$('[data-group-cover]').forEach((el) => {
    const g = store.getGroup(el.dataset.groupCover);
    if (!g) return;
    const cls = [...el.classList].filter((c) => ['xs', 'sm', 'md', 'lg', 'xl'].includes(c)).join(' ');
    el.outerHTML = groupCover(g, cls);
  });
}, 400);

artwork.onArtwork((id, patch) => {
  let track = null;
  const fix = (t) => { if (t.id === id) { Object.assign(t, patch); track = t; } };
  player.queue.forEach(fix);
  lists.forEach((list) => list.forEach(fix));
  $$(`[data-id="${CSS.escape(id)}"]`).forEach((el) => {
    const art = $('.art', el);
    if (art) setArt(art, patch.artwork);
    if (!patch.title || !track) return;
    const title = $('.row-title, .card-title', el);
    if (title) { const eq = $('.eq', title); title.textContent = track.title; if (eq) title.prepend(eq); }
    const sub = $('.row-sub', el);
    if (sub) sub.innerHTML = rowSub(track);
    const csub = $('.card-sub', el);
    if (csub) csub.textContent = track.artist;
  });
  if (player.current?.id === id) {
    playerBar.dataset.track = ''; // force the player artwork to redraw
    updatePlayerUI();
    player.updateMediaMetadata();
    saveSession();
  }
  refreshGroupCovers();
});

function markCurrentRows() {
  const id = player.current?.id;
  $$('.row[data-id]').forEach((r) => {
    const cur = r.dataset.id === id;
    if (r.classList.contains('is-current') === cur) return;
    r.classList.toggle('is-current', cur);
    const title = $('.row-title', r);
    const eq = $('.eq', title);
    if (cur && !eq) title.insertAdjacentHTML('afterbegin', '<span class="eq"><i></i><i></i><i></i></span>');
    if (!cur && eq) eq.remove();
  });
}

function updateSleepLabel() {
  const el = $('.sleep-label');
  const s = player.sleep;
  if (!s) el.textContent = 'Sleep';
  else if (s.endOfTrack) el.textContent = 'End of song';
  else el.textContent = fmtTime((s.at - Date.now()) / 1000);
  $('[data-action="sleep-timer"]').classList.toggle('on', !!s);
}

// Seek bars
$$('.seek').forEach((range) => {
  range.addEventListener('input', () => {
    seeking = true;
    const dur = player.media.duration;
    const pct = range.value / 1000;
    range.style.setProperty('--p', `${pct * 100}%`);
    if (isFinite(dur)) $$('.time.cur').forEach((el) => { el.textContent = fmtTime(pct * dur); });
  });
  range.addEventListener('change', () => {
    seeking = false;
    if (isFinite(player.media.duration)) player.seek((range.value / 1000) * player.media.duration);
  });
});

$('.volume').addEventListener('input', (e) => {
  player.setVolume(e.target.value / 100);
});
$('.volume').addEventListener('change', () => store.setting('volume', player.volume));

/* ==========================================================================
   Player events
   ========================================================================== */
let pendingRecent = null;

player.addEventListener('track', () => {
  pendingRecent = player.current?.id || null;
  // Find a poster for the song that's playing (and the next few) if it has none.
  if (player.current) artwork.ensure([player.current, ...player.upcoming.slice(0, 3)], { priority: true });
  updatePlayerUI();
  updateTimeUI();
  saveSessionNow();
});
player.addEventListener('state', () => {
  updateStateUI();
  const cur = player.current;
  if (player.playing && cur && pendingRecent === cur.id) {
    pendingRecent = null;
    store.pushRecent(cur);
  }
});
player.addEventListener('time', updateTimeUI);
player.addEventListener('mode', () => { updateModeUI(); saveSession(); });
player.addEventListener('volume', updateVolumeUI);
player.addEventListener('queue', () => { refreshQueueSheet(); saveSession(); });
player.addEventListener('sleep', () => { updateSleepLabel(); if (!player.sleep && !player.playing) toast('Sleep timer — paused'); });
player.addEventListener('preview', (e) => {
  toast(e.detail.reason ? `${e.detail.reason} — playing the 30-second preview` : india.hasKey()
    ? 'Full song not found on YouTube — playing the 30-second preview'
    : '30-second preview · add a free YouTube key in Settings for full songs');
});
player.addEventListener('notice', (e) => toast(e.detail.message));
player.addEventListener('engine', () => updateDock());
let resumeTipShown = false;
player.addEventListener('resumed', () => {
  if (resumeTipShown || !player.onYouTube) return;
  resumeTipShown = true;
  toast('Picked up where you left off — YouTube songs pause while Echo is in the background');
});
player.addEventListener('error', (e) => toast(`${e.detail.message}${e.detail.track ? ` — ${e.detail.track.title}` : ''}`));

setInterval(() => { if (player.sleep) updateSleepLabel(); }, 1000);

function saveSessionNow() {
  const snap = player.snapshot();
  store.set('session', snap ? { ...snap, queue: snap.queue.map(store.slim), context: player.context || null } : null, { silent: true });
}
const saveSession = debounce(saveSessionNow, 500);

setInterval(() => { if (player.playing) saveSession(); }, 5000);
addEventListener('pagehide', () => { saveSessionNow(); store.flush(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { saveSessionNow(); store.flush(); } });

/* ==========================================================================
   Actions (event delegation)
   ========================================================================== */
function rowContext(el) {
  const row = el.closest('[data-list]');
  if (!row) return {};
  const list = lists.get(row.dataset.list) || [];
  const index = Number(row.dataset.index);
  return { list, index, track: list[index], listKey: row.dataset.list, groupId: row.dataset.group };
}

// Describes where playback started from, shown as "Playing from …" on the player.
function contextFor(listKey) {
  const here = location.hash || '#/home';
  if (listKey?.startsWith('group:')) {
    const g = store.getGroup(listKey.slice(6));
    return g ? { label: g.name, href: `#/group/${encodeURIComponent(g.id)}`, groupId: g.id } : null;
  }
  const route = parseRoute();
  const fixed = {
    liked: { label: 'Liked songs', href: '#/liked' },
    recents: { label: 'Recently played', href: '#/recent' },
    device: { label: 'On this device', href: '#/device' },
    'home-trending': { label: 'Trending now', href: '#/trending' },
    trending: { label: `Trending${route.query.get('genre') ? ` · ${route.query.get('genre')}` : ''}`, href: here },
    playlist: { label: $('.collection-info h1')?.textContent || 'Playlist', href: here },
    search: { label: `Search “${route.query.get('q') || ''}”`, href: here },
    'search-mine': { label: 'Your library', href: here },
    'search-india': { label: `Search “${route.query.get('q') || ''}”`, href: here },
    'search-yt': { label: `Search “${route.query.get('q') || ''}”`, href: here },
    'home-india': { label: `Latest ${india.LANGS[indianLang()].label}`, href: `#/india/${indianLang()}` },
    'india-trend': { label: `${india.LANGS[indianLang()].label} · Trending`, href: here },
    'india-labels': { label: `${india.LANGS[indianLang()].label} · New from labels`, href: here },
    'india-latest': { label: `${india.LANGS[indianLang()].label} · Latest`, href: here },
    'india-top': { label: `${india.LANGS[indianLang()].label} · Top charts`, href: here },
  };
  return fixed[listKey] || null;
}

function playFrom(list, index, shuffle, listKey) {
  if (!list?.length) return;
  player.context = contextFor(listKey);
  player.playList(list, index, shuffle !== undefined ? { shuffle } : {});
}

async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm)$/i.test(f.name));
  if (!files.length) { toast('No audio files selected'); return; }
  toast(`Adding ${files.length} song${files.length === 1 ? '' : 's'}…`);
  const added = [];
  for (const file of files) {
    const [tags, duration] = await Promise.all([readTags(file), probeDuration(file)]);
    const guess = guessFromFilename(file.name);
    try {
      added.push(await store.addLocalFile(file, {
        title: tags.title || guess.title,
        artist: tags.artist || guess.artist || 'Unknown artist',
        artwork: tags.artwork,
        duration,
        guessed: !tags.title, // name came from the file name, so it can be tidied up automatically
      }));
    } catch (e) {
      toast(`Couldn’t save ${file.name}: ${e.message}`);
    }
  }
  if (addTarget && added.length) store.addToGroup(addTarget, added);
  artwork.ensure(added.filter((t) => !t.artwork));
  if (added.length) toast(`Added ${added.length} song${added.length === 1 ? '' : 's'}${addTarget ? ' to the group' : ''}`);
  render();
}

const actions = {
  'play-row': (el) => {
    const { list, index } = rowContext(el);
    if (!list?.length) return;
    if (player.current?.id === list[index].id) { player.toggle(); return; }
    playFrom(list, index, undefined, rowContext(el).listKey); // with shuffle on, the tapped song plays first and the rest are shuffled
  },
  'play-list': (el) => playFrom(lists.get(el.dataset.list), 0, false, el.dataset.list),
  'shuffle-list': (el) => playFrom(lists.get(el.dataset.list), 0, true, el.dataset.list),
  'open-context': () => { if (player.context?.href) { closeNowPlaying(); navigate(player.context.href); } },
  like: (el) => {
    const { track } = rowContext(el);
    if (!track) return;
    const liked = store.toggleLike(track);
    el.classList.toggle('is-liked', liked);
    $('use', el).setAttribute('href', liked ? '#i-heart-fill' : '#i-heart');
    if (player.current?.id === track.id) updateLikeUI();
    toast(liked ? 'Added to Liked songs' : 'Removed from Liked songs');
    if (parseRoute().name === 'liked') render();
  },
  'like-current': () => {
    if (!player.current) return;
    const liked = store.toggleLike(player.current);
    updateLikeUI();
    $$(`.row[data-id="${CSS.escape(player.current.id)}"] .like-btn`).forEach((b) => { b.classList.toggle('is-liked', liked); $('use', b).setAttribute('href', liked ? '#i-heart-fill' : '#i-heart'); });
    toast(liked ? 'Added to Liked songs' : 'Removed from Liked songs');
  },
  'track-menu': (el) => {
    const { track, groupId, index } = rowContext(el);
    if (track) openTrackMenu(track, { groupId, index });
  },
  'quick-add': (el) => {
    const { track } = rowContext(el);
    if (!track || !addTarget) return;
    const n = store.addToGroup(addTarget, [track]);
    toast(n ? `Added “${track.title}”` : 'Already in this group');
    el.classList.add('added');
  },
  'current-menu': () => { if (player.current) openTrackMenu(player.current); },

  toggle: () => player.toggle(),
  next: () => player.next(),
  prev: () => player.prev(),
  shuffle: () => { player.toggleShuffle(); toast(player.shuffle ? 'Shuffle on' : 'Shuffle off'); },
  repeat: () => { player.cycleRepeat(); toast({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[player.repeat]); },
  mute: () => player.toggleMute(),
  'open-now-playing': (el, e) => {
    if (e.target.closest('[data-action="like-current"]')) return;
    if (matchMedia('(min-width: 800px)').matches && !e.target.closest('.pb-art')) return;
    openNowPlaying();
  },
  'close-now-playing': () => closeNowPlaying(),
  'open-queue': () => openQueue(),
  'sleep-timer': () => openSleepTimer(),
  speed: () => openSpeed(),
  'set-sleep': (el) => {
    const v = el.dataset.value;
    player.setSleep(v === 'end' ? 'end' : Number(v));
    closeSheet();
    toast(player.sleep ? (player.sleep.endOfTrack ? 'Will stop after this song' : `Sleep timer set for ${v} min`) : 'Sleep timer off');
  },
  'set-speed': (el) => {
    const v = Number(el.dataset.value);
    player.setRate(v);
    store.setting('speed', v);
    $('.speed-label').textContent = `${v}×`;
    if (sheetRoot.classList.contains('open')) closeSheet();
    if (parseRoute().name === 'settings') renderSettings();
  },

  'queue-jump': (el, e) => { if (!e.target.closest('button')) { player.jumpTo(Number(el.dataset.qpos)); } },
  'queue-move': (el) => { const p = Number(el.closest('[data-qpos]').dataset.qpos); player.move(p, p + Number(el.dataset.dir)); },
  'queue-remove': (el) => player.removeAt(Number(el.closest('[data-qpos]').dataset.qpos)),
  'clear-queue': () => { player.clearUpcoming(); toast('Queue cleared'); },

  'menu-play-next': () => { player.playNext(sheetTrack); closeSheet(); toast('Playing next'); },
  'menu-add-queue': () => { player.addToQueue(sheetTrack); closeSheet(); toast('Added to queue'); },
  'menu-add-group': () => openAddToGroup([sheetTrack]),
  'menu-like': () => {
    const liked = store.toggleLike(sheetTrack);
    closeSheet(); updateLikeUI();
    toast(liked ? 'Added to Liked songs' : 'Removed from Liked songs');
    render();
  },
  'menu-remove-group': () => { store.removeFromGroup(sheetContext.groupId, sheetTrack.id); closeSheet(); toast('Removed from group'); render(); },
  'menu-move': (el) => {
    const i = sheetContext.index;
    store.moveInGroup(sheetContext.groupId, i, i + Number(el.dataset.dir));
    closeSheet(); render();
  },
  'menu-remove-queue': () => { player.removeAt(sheetContext.queuePos); closeSheet(); },
  'menu-rename': () => openRename(sheetTrack),
  'menu-share': async () => {
    const t = sheetTrack;
    closeSheet();
    const data = { title: t.title, text: `${t.title} — ${t.artist}`, url: t.link };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(t.link); toast('Link copied'); }
    } catch { /* cancelled */ }
  },
  'menu-delete-local': () => {
    const t = sheetTrack;
    confirmSheet(`Delete “${esc(t.title)}” from this device?`, 'Delete', async () => {
      const qp = player.order.findIndex((qi) => player.queue[qi].id === t.id);
      if (qp !== -1) player.removeAt(qp);
      await store.removeLocal(t.id);
      toast('Deleted');
      render();
    });
  },
  'confirm-yes': async () => { const fn = confirmHandler; confirmHandler = null; closeSheet(); await fn?.(); },

  'new-group': () => openGroupEditor(null),
  'new-group-with-tracks': () => openGroupEditor(null, [].concat(sheetTrack)),
  'pick-group': (el) => {
    const g = store.getGroup(el.dataset.group);
    const tracks = [].concat(sheetTrack);
    const n = store.addToGroup(g.id, tracks);
    closeSheet();
    toast(n ? `Added to “${g.name}”` : `Already in “${g.name}”`);
    if (parseRoute().name === 'group') render();
  },
  'save-list-as-group': (el) => {
    const tracks = lists.get(el.dataset.list) || [];
    if (!tracks.length) return;
    sheetTrack = tracks;
    openAddToGroup(tracks);
  },
  'group-menu': (el) => openGroupMenu(el.dataset.group),
  'edit-group': (el) => openGroupEditor(store.getGroup(el.dataset.group)),
  'queue-group': (el) => { const g = store.getGroup(el.dataset.group); closeSheet(); if (g?.tracks.length) { player.addToQueue(g.tracks); toast('Added to queue'); } },
  'duplicate-group': (el) => {
    const g = store.getGroup(el.dataset.group);
    const copy = store.createGroup({ ...g, name: `${g.name} (copy)` });
    closeSheet();
    navigate(`#/group/${encodeURIComponent(copy.id)}`);
  },
  'share-group': async (el) => {
    const g = store.getGroup(el.dataset.group);
    closeSheet();
    const payload = { app: 'echo-group', version: 1, group: { name: g.name, emoji: g.emoji, color: g.color, description: g.description, tracks: g.tracks.filter((t) => t.source !== 'local') } };
    const name = `${g.name.replace(/[^\w\- ]+/g, '').trim() || 'group'}.echo-group.json`;
    const file = new File([JSON.stringify(payload)], name, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: g.name }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    download(name, payload);
    toast('Group exported — share the file with a friend');
  },
  'delete-group': (el) => {
    const g = store.getGroup(el.dataset.group);
    confirmSheet(`Delete the group “${esc(g.name)}”?`, 'Delete', () => {
      store.deleteGroup(g.id);
      toast('Group deleted');
      if (parseRoute().name === 'group') navigate('#/library'); else render();
    });
  },
  'add-songs': (el) => {
    addTarget = el.dataset.group;
    navigate('#/search');
  },
  'done-adding': () => {
    const id = addTarget;
    addTarget = null;
    navigate(`#/group/${encodeURIComponent(id)}`);
  },

  upload: () => $('#fileInput').click(),
  'add-link': () => openAddLink(),
  'import-file': () => $('#importInput').click(),
  'export-all': () => { download(`echo-backup-${new Date().toISOString().slice(0, 10)}.json`, store.exportData()); toast('Backup downloaded'); },
  'reset-all': () => confirmSheet('Erase all groups, likes, settings and saved files?', 'Erase', async () => {
    player.stop();
    await store.resetAll();
    applyTheme();
    toast('Everything erased');
    navigate('#/home');
    render();
  }),
  'clear-recents': () => { store.set('recents', []); render(); },
  'save-yt-key': async () => {
    const key = $('#ytKey').value.trim();
    if (!key) { toast('Paste your key first'); return; }
    toast('Testing key…');
    try {
      await india.testKey(key);
      store.setting('ytKey', key);
      toast('YouTube connected — full songs are on 🎉');
      renderSettings();
    } catch (e) {
      toast(`That key didn’t work: ${e.message}`);
    }
  },
  'remove-yt-key': () => { store.setting('ytKey', ''); toast('Key removed'); renderSettings(); },
  'set-indian-lang': (el) => { store.setting('indianLang', el.dataset.value); renderSettings(); },
  'open-now-playing-force': () => openNowPlaying(),
  'set-theme': (el) => { store.setting('theme', el.dataset.value); applyTheme(); renderSettings(); },
  'set-accent': (el) => { store.setting('accent', el.dataset.value); applyTheme(); renderSettings(); },
  'set-trending-time': (el) => { store.setting('trendingTime', el.dataset.value); renderSettings(); },
  install: async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    $('#installBtn')?.classList.add('hidden');
  },
  'clear-search': () => { const i = $('#searchInput'); i.value = ''; i.dispatchEvent(new Event('input')); i.focus(); },
  'retry-search': () => searchResults(($('#searchInput')?.value || '').trim()),
  retry: () => render(),
  'close-sheet': () => closeSheet(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  // Buttons nested inside a clickable row handle themselves; the row only handles direct clicks.
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (el.tagName === 'A') e.preventDefault();
  fn(el, e);
});

$('#fileInput').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app === 'echo-group') {
      const g = store.importGroup(data);
      toast(`Imported group “${g.name}”`);
      navigate(`#/group/${encodeURIComponent(g.id)}`);
    } else {
      store.importData(data);
      applyTheme();
      toast('Backup imported');
      render();
    }
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
});

// Drag & drop audio files anywhere on desktop.
document.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  document.body.classList.remove('dropping');
  handleFiles(e.dataTransfer.files);
});

// Keyboard shortcuts.
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  const map = {
    ' ': () => player.toggle(),
    k: () => player.toggle(),
    ArrowRight: () => (e.shiftKey ? player.next() : player.seekBy(10)),
    ArrowLeft: () => (e.shiftKey ? player.prev() : player.seekBy(-10)),
    n: () => player.next(),
    p: () => player.prev(),
    s: () => actions.shuffle(),
    r: () => actions.repeat(),
    m: () => player.toggleMute(),
    l: () => actions['like-current'](),
    q: () => openQueue(),
    '/': () => { navigate('#/search'); setTimeout(() => $('#searchInput')?.focus(), 50); },
    Escape: () => { if (sheetRoot.classList.contains('open')) closeSheet(); else closeNowPlaying(); },
  };
  const fn = map[k] || map[k.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
});

// Swipe down to close the now-playing screen on phones.
(() => {
  let startY = null;
  np.addEventListener('touchstart', (e) => { if (!e.target.closest('input')) startY = e.touches[0].clientY; }, { passive: true });
  np.addEventListener('touchend', (e) => {
    if (startY !== null && e.changedTouches[0].clientY - startY > 110) closeNowPlaying();
    startY = null;
  });
})();

// Re-render when data used by the current view changes from elsewhere (e.g. groups list in sidebar).
store.subscribe((key) => {
  if (key === 'groups') renderSideGroups();
  if (key === 'liked') updateLikeUI();
});

/* ==========================================================================
   PWA install + service worker
   ========================================================================== */
let deferredInstall = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  $('#installBtn')?.classList.remove('hidden');
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/* ==========================================================================
   Boot
   ========================================================================== */
async function boot() {
  await store.load();
  const s = store.get('settings');
  applyTheme();
  player.setVolume(s.volume ?? 1);
  player.rate = s.speed || 1;
  $('.speed-label').textContent = `${player.rate}×`;
  updateVolumeUI();
  player.context = store.get('session')?.context || null;
  player.restore(store.get('session'));
  updatePlayerUI();
  addEventListener('hashchange', () => {
    closeSheet({ fromHistory: true });
    closeNowPlaying({ fromHistory: true });
    overlays.length = 0;
    render(); view.scrollTo?.(0, 0); window.scrollTo(0, 0); });
  render();
}

boot();
