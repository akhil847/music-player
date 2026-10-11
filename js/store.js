// App state persisted to IndexedDB: likes, groups, local library, recents, settings and playback session.
import { kv, files } from './db.js';

const DEFAULTS = {
  liked: [],          // track objects, newest first
  groups: [],         // { id, name, emoji, color, description, tracks: [], createdAt }
  localTracks: [],    // track objects for files stored on this device
  recents: [],        // recently played tracks
  searches: [],       // recent search strings
  artCache: {},       // "title|artist" -> { url } or { at } for a failed lookup
  ytCache: {},        // cached YouTube lists: key -> { at, data }
  ytMatch: {},        // song id -> YouTube video id found for it
  ytChannels: {},     // "@handle" -> uploads playlist id (or '' if the handle doesn't exist)
  settings: {
    theme: 'dark',
    accent: '#8b5cf6',
    volume: 1,
    speed: 1,
    crossfade: false,
    trendingTime: 'week',
    name: '',
    ytKey: '',          // free YouTube Data API key, enables full Indian film songs
    indianLang: 'telugu',
  },
  session: null,      // { queue, order, index, position, shuffle, repeat }
};

const state = structuredClone(DEFAULTS);
const listeners = new Set();
const dirty = new Set();
let saveTimer;

export async function load() {
  await Promise.all(Object.keys(DEFAULTS).map(async (key) => {
    try {
      const v = await kv.get(key);
      if (v !== undefined) {
        state[key] = key === 'settings' ? { ...DEFAULTS.settings, ...v } : v;
      }
    } catch (e) {
      console.warn('load failed', key, e);
    }
  }));
  return state;
}

export function get(key) { return state[key]; }

export function set(key, value, { silent = false } = {}) {
  state[key] = value;
  dirty.add(key);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
  if (!silent) listeners.forEach((fn) => fn(key));
}

export async function flush() {
  const keys = [...dirty];
  dirty.clear();
  await Promise.all(keys.map((k) => kv.set(k, state[k]).catch((e) => console.warn('save failed', k, e))));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setting(key, value) {
  set('settings', { ...state.settings, [key]: value });
}

/* ---------- Likes ---------- */
export function isLiked(id) { return state.liked.some((t) => t.id === id); }

export function toggleLike(track) {
  const liked = isLiked(track.id);
  set('liked', liked ? state.liked.filter((t) => t.id !== track.id) : [slim(track), ...state.liked]);
  return !liked;
}

/* ---------- Recents ---------- */
export function pushRecent(track) {
  const list = [slim(track), ...state.recents.filter((t) => t.id !== track.id)].slice(0, 50);
  set('recents', list, { silent: true });
}

export function pushSearch(q) {
  q = q.trim();
  if (!q) return;
  set('searches', [q, ...state.searches.filter((s) => s.toLowerCase() !== q.toLowerCase())].slice(0, 10), { silent: true });
}

/* ---------- Groups ---------- */
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

export function getGroup(id) { return state.groups.find((g) => g.id === id); }

export function createGroup({ name, emoji = '🎵', color = '#8b5cf6', description = '', tracks = [] }) {
  const group = { id: uid(), name: name.trim() || 'New group', emoji, color, description, tracks: tracks.map(slim), createdAt: Date.now() };
  set('groups', [group, ...state.groups]);
  return group;
}

export function updateGroup(id, patch) {
  set('groups', state.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)));
}

export function deleteGroup(id) {
  set('groups', state.groups.filter((g) => g.id !== id));
}

export function addToGroup(id, tracks) {
  const group = getGroup(id);
  if (!group) return 0;
  const existing = new Set(group.tracks.map((t) => t.id));
  const fresh = tracks.filter((t) => !existing.has(t.id)).map(slim);
  if (fresh.length) updateGroup(id, { tracks: [...group.tracks, ...fresh] });
  return fresh.length;
}

export function removeFromGroup(id, trackId) {
  const group = getGroup(id);
  if (group) updateGroup(id, { tracks: group.tracks.filter((t) => t.id !== trackId) });
}

export function moveInGroup(id, from, to) {
  const group = getGroup(id);
  if (!group || to < 0 || to >= group.tracks.length) return;
  const tracks = [...group.tracks];
  const [t] = tracks.splice(from, 1);
  tracks.splice(to, 0, t);
  updateGroup(id, { tracks });
}

/* ---------- Local files ---------- */
export async function addLocalFile(file, meta) {
  const id = `local:${uid()}`;
  await files.put(id, file);
  const track = { id, source: 'local', title: meta.title, artist: meta.artist, artwork: meta.artwork || '', duration: meta.duration || 0, genre: '', size: file.size, guessed: !!meta.guessed };
  set('localTracks', [track, ...state.localTracks]);
  return track;
}

export async function removeLocal(id) {
  await files.del(id);
  set('localTracks', state.localTracks.filter((t) => t.id !== id));
  set('liked', state.liked.filter((t) => t.id !== id));
  set('groups', state.groups.map((g) => ({ ...g, tracks: g.tracks.filter((t) => t.id !== id) })));
}

export function addUrlTrack({ url, title, artist }) {
  const track = { id: `url:${uid()}`, source: 'url', src: url, title: title || url.split('/').pop() || 'Stream', artist: artist || 'Web link', artwork: '', duration: 0, genre: '' };
  set('localTracks', [track, ...state.localTracks]);
  return track;
}

export function updateTrackMeta(id, patch) {
  const fix = (list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t));
  set('localTracks', fix(state.localTracks));
  set('liked', fix(state.liked));
  set('groups', state.groups.map((g) => ({ ...g, tracks: fix(g.tracks) })));
  set('recents', fix(state.recents), { silent: true });
}

/* ---------- Backup ---------- */
export function exportData() {
  const { liked, groups, settings, recents } = state;
  // Local files live only on this device, so only portable tracks are exported.
  const portable = (list) => list.filter((t) => t.source !== 'local');
  return {
    app: 'echo',
    version: 1,
    exportedAt: new Date().toISOString(),
    liked: portable(liked),
    groups: groups.map((g) => ({ ...g, tracks: portable(g.tracks) })),
    urlTracks: state.localTracks.filter((t) => t.source === 'url'),
    recents: portable(recents),
    settings: { ...settings, ytKey: '' }, // never put the private key in a shareable file
  };
}

export function importData(data) {
  if (!data || data.app !== 'echo') throw new Error('Not an Echo backup file');
  const byId = (a, b) => {
    const seen = new Set(a.map((t) => t.id));
    return [...a, ...(b || []).filter((t) => !seen.has(t.id))];
  };
  set('liked', byId(state.liked, data.liked));
  const groupIds = new Set(state.groups.map((g) => g.id));
  set('groups', [...state.groups, ...(data.groups || []).filter((g) => !groupIds.has(g.id))]);
  set('localTracks', byId(state.localTracks, data.urlTracks));
  if (data.settings) set('settings', { ...state.settings, ...data.settings, ytKey: data.settings.ytKey || state.settings.ytKey });
}

export function importGroup(data) {
  if (!data || data.app !== 'echo-group' || !data.group) throw new Error('Not an Echo group file');
  const g = data.group;
  return createGroup({ name: g.name, emoji: g.emoji, color: g.color, description: g.description, tracks: (g.tracks || []).filter((t) => t.source !== 'local') });
}

export async function resetAll() {
  await kv.clear();
  await files.clear();
  Object.assign(state, structuredClone(DEFAULTS));
  listeners.forEach((fn) => fn('*'));
}

// Keep only the fields needed to re-play a track later.
export function slim(t) {
  const { id, source, audiusId, title, artist, artwork, duration, genre, src, link, album, preview, videoId, itunesId } = t;
  return Object.fromEntries(Object.entries({ id, source, audiusId, title, artist, artwork, duration, genre, src, link, album, preview, videoId, itunesId }).filter(([, v]) => v !== undefined && v !== ''));
}
