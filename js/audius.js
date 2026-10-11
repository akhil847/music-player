// Client for the Audius open music API: free, ad-free streaming with trending charts and search.
// Docs: https://docs.audius.org/developers/api
const APP_NAME = 'echo-music-player';
const GATEWAY = 'https://api.audius.co';
const HOST_KEY = 'echo.audiusHost';

let hostPromise;

async function pickHost() {
  const cached = sessionStorage.getItem(HOST_KEY);
  if (cached) return cached;
  try {
    const res = await fetch(GATEWAY, { cache: 'no-store' });
    const json = await res.json();
    const hosts = Array.isArray(json.data) ? json.data.filter((h) => typeof h === 'string') : [];
    if (hosts.length) {
      const host = hosts[Math.floor(Math.random() * hosts.length)];
      sessionStorage.setItem(HOST_KEY, host);
      return host;
    }
  } catch { /* fall through to gateway */ }
  return GATEWAY;
}

function host() {
  if (!hostPromise) hostPromise = pickHost();
  return hostPromise;
}

function resetHost() {
  sessionStorage.removeItem(HOST_KEY);
  hostPromise = null;
}

async function request(path, params = {}) {
  const qs = new URLSearchParams({ ...params, app_name: APP_NAME });
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = attempt === 2 ? GATEWAY : await host();
    try {
      const res = await fetch(`${base}/v1${path}?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return json.data;
    } catch (err) {
      lastErr = err;
      resetHost();
    }
  }
  throw lastErr;
}

export async function streamUrl(trackId) {
  const base = await host();
  return `${base}/v1/tracks/${encodeURIComponent(trackId)}/stream?app_name=${APP_NAME}`;
}

function art(obj) {
  const a = obj?.artwork;
  if (!a) return '';
  return a['480x480'] || a['1000x1000'] || a['150x150'] || '';
}

export function normalizeTrack(t) {
  return {
    id: `audius:${t.id}`,
    source: 'audius',
    audiusId: t.id,
    title: t.title || 'Untitled',
    artist: t.user?.name || 'Unknown artist',
    artwork: art(t),
    duration: t.duration || 0,
    genre: t.genre || '',
    plays: t.play_count || 0,
    link: t.permalink ? `https://audius.co${t.permalink}` : '',
  };
}

function normalizePlaylist(p) {
  return {
    id: p.id,
    title: p.playlist_name || 'Playlist',
    artist: p.user?.name || '',
    artwork: art(p),
    count: p.track_count || 0,
  };
}

const playable = (t) => t && t.is_streamable !== false && !t.is_delete;

export async function trending({ genre = '', time = 'week', limit = 50 } = {}) {
  const params = { time, limit };
  if (genre) params.genre = genre;
  const data = await request('/tracks/trending', params);
  return (data || []).filter(playable).map(normalizeTrack);
}

export async function searchTracks(query, limit = 40) {
  const data = await request('/tracks/search', { query, limit });
  return (data || []).filter(playable).map(normalizeTrack);
}

export async function trendingPlaylists(time = 'week', limit = 20) {
  const data = await request('/playlists/trending', { time, limit });
  return (data || []).map(normalizePlaylist);
}

export async function searchPlaylists(query, limit = 12) {
  const data = await request('/playlists/search', { query, limit });
  return (data || []).map(normalizePlaylist);
}

export async function playlist(id) {
  const [info, tracks] = await Promise.all([
    request(`/playlists/${encodeURIComponent(id)}`),
    request(`/playlists/${encodeURIComponent(id)}/tracks`),
  ]);
  const meta = Array.isArray(info) ? info[0] : info;
  return {
    ...normalizePlaylist(meta || {}),
    tracks: (tracks || []).filter(playable).map(normalizeTrack),
  };
}

export const GENRES = [
  'Electronic', 'Hip-Hop/Rap', 'Pop', 'R&B/Soul', 'Rock', 'Alternative', 'Lo-Fi', 'Ambient',
  'House', 'Techno', 'Dubstep', 'Drum & Bass', 'Trap', 'Jazz', 'Acoustic', 'Classical',
  'Country', 'Latin', 'Reggae', 'Metal', 'Funk', 'Soundtrack', 'World', 'Devotional',
];
