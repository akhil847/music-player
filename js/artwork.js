// Finds cover art / movie posters automatically for songs that don't have a picture,
// using Apple's free iTunes Search API (no key needed; covers film soundtracks too).
import * as store from './store.js';

const MISS_RETRY_MS = 7 * 24 * 3600 * 1000;
const NO_ARTIST = /^(unknown artist|web link)$/i;

// Strip download-site junk, brackets and quality tags so the search matches the real song.
export function cleanTitle(title) {
  return String(title || '')
    .replace(/\.(mp3|m4a|wav|flac|ogg|aac)$/i, '')
    .replace(/_+/g, ' ')
    .replace(/\s*[-|]\s*[\w.-]*\.(com|net|org|info|in|co|me|io|cc|fm|site|xyz)\b.*$/i, '')
    .replace(/[\w-]+\.(com|net|org|info|in|co|me|io|cc|site|xyz)\b/gi, '')
    .replace(/\(([^)]*)\)|\[([^\]]*)\]|\{[^}]*\}/g, ' ')
    .replace(/\b(official|video|audio|lyrics?|lyrical|full song|hd|hq|4k|\d{2,3}\s?kbps|mp3|copy|remastered)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\d{1,3}\s*[-.]\s+/, '') // leading track numbers like "01 - "
    .trim();
}

function cacheKey(t) {
  return `${cleanTitle(t.title).toLowerCase()}|${NO_ARTIST.test(t.artist || '') ? '' : (t.artist || '').toLowerCase()}`;
}

// JSONP keeps this working regardless of the API's CORS headers.
let jsonpSeq = 0;
export function jsonp(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const name = `__echoArt${Date.now()}_${jsonpSeq++}`;
    const script = document.createElement('script');
    const done = (fn, v) => { clearTimeout(timer); delete window[name]; script.remove(); fn(v); };
    const timer = setTimeout(() => done(reject, new Error('timeout')), timeout);
    window[name] = (data) => done(resolve, data);
    script.onerror = () => done(reject, new Error('network'));
    script.src = `${url}&callback=${name}`;
    document.head.append(script);
  });
}

async function search(term, entity) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=${entity}&limit=5`;
  const data = await jsonp(url);
  return data?.results || [];
}

function bigArt(url) {
  return url ? url.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/600x600bb.jpg') : '';
}

function score(result, title, artist) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const rt = norm(result.trackName || result.collectionName);
  const ra = norm(result.artistName);
  const t = norm(title);
  const a = norm(artist);
  let s = 0;
  if (rt === t) s += 3; else if (rt.includes(t) || t.includes(rt)) s += 2;
  if (a && (ra.includes(a) || a.includes(ra))) s += 2;
  return s;
}

// "(From RRR)" / "[From \"Pushpa\"]" -> "RRR": the movie name makes poster matches much better.
function movieHint(title) {
  const m = String(title || '').match(/[([]\s*from\s+["“']?([^"”')\]]+)/i);
  return m ? m[1].trim() : '';
}

// Returns { url, title, artist, confident } for the best match, or null.
export async function lookup(track) {
  const title = cleanTitle(track.title) || cleanTitle(track.artist);
  if (!title) return null;
  const artist = NO_ARTIST.test(track.artist || '') || cleanTitle(track.artist) === title ? '' : (track.artist || '');
  const movie = movieHint(track.title);
  const results = await search([title, movie || artist].filter(Boolean).join(' '), 'song');
  let best = results.map((r) => [score(r, title, artist), r]).sort((x, y) => y[0] - x[0])[0];
  // If artist + title found nothing, fall back to title alone (e.g. a movie name or a misspelt artist).
  if (!best && (artist || movie)) {
    const alt = await search(title, 'song');
    best = alt.map((r) => [score(r, title, ''), r]).sort((x, y) => y[0] - x[0])[0];
  }
  if (!best || best[0] < 2) return null;
  const r = best[1];
  return { url: bigArt(r.artworkUrl100), title: r.trackName || '', artist: r.artistName || '', confident: best[0] >= 3 };
}

/* ---------- Background queue ---------- */
const pending = new Map(); // track id -> track
let running = false;
let onFound = () => {};

export function onArtwork(fn) { onFound = fn; }

function needsArt(t) {
  if (!t || t.artwork) return false;
  const hit = store.get('artCache')[cacheKey(t)];
  if (hit === undefined) return true;
  if (hit.url) { applyCached(t, hit); return false; }
  return Date.now() - (hit.at || 0) > MISS_RETRY_MS;
}

function applyCached(t, hit) {
  const patch = { artwork: hit.url };
  // Songs named from a messy file name also get their proper title and artist.
  const local = store.get('localTracks').find((x) => x.id === t.id);
  if (local?.guessed && hit.confident && hit.title) {
    Object.assign(patch, { title: hit.title, artist: hit.artist || local.artist, guessed: false });
  }
  store.updateTrackMeta(t.id, patch);
  onFound(t.id, patch);
}

// Queue tracks for lookup; `priority` puts them at the front (used for the song that is playing).
export function ensure(tracks, { priority = false } = {}) {
  const fresh = [].concat(tracks).filter((t) => t && !pending.has(t.id) && needsArt(t));
  if (!fresh.length) return;
  if (priority) {
    const rest = [...pending];
    pending.clear();
    fresh.forEach((t) => pending.set(t.id, t));
    rest.forEach(([k, v]) => pending.set(k, v));
  } else {
    fresh.slice(0, 60).forEach((t) => pending.set(t.id, t));
  }
  run();
}

async function run() {
  if (running) return;
  running = true;
  while (pending.size) {
    const [id, t] = pending.entries().next().value;
    pending.delete(id);
    const key = cacheKey(t);
    const cached = store.get('artCache')[key];
    if (cached?.url) { applyCached(t, cached); continue; }
    try {
      const hit = await lookup(t);
      store.set('artCache', { ...store.get('artCache'), [key]: hit?.url ? hit : { at: Date.now() } }, { silent: true });
      if (hit?.url) applyCached(t, hit);
    } catch {
      // Offline or blocked: leave it uncached so it is retried next time.
    }
    await new Promise((r) => setTimeout(r, 350)); // be gentle with the free API
  }
  running = false;
}
