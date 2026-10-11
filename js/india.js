// Indian film & regional music: latest releases and charts from Apple's free iTunes catalogue
// (30-second previews, posters), plus full songs from official label uploads on YouTube when the
// user has added a free YouTube Data API key.
import * as store from './store.js';
import { jsonp } from './artwork.js';

export const LANGS = {
  telugu: { label: 'Telugu', genreId: 1265, handles: ['@adityamusic', '@TSeriesTelugu', '@LahariMusic', '@SonyMusicSouth', '@MangoMusic'] },
  tamil: { label: 'Tamil', genreId: 1264, handles: ['@SonyMusicSouth', '@thinkmusicindia', '@SaregamaTamil', '@TSeriesTamil'] },
  hindi: { label: 'Hindi', genreId: 1263, handles: ['@tseries', '@SonyMusicIndia', '@zeemusiccompany', '@saregamamusic', '@TipsOfficial'] },
  kannada: { label: 'Kannada', handles: ['@LahariMusic', '@AnandAudio', '@SaregamaKannada', '@PRKAudio'] },
  malayalam: { label: 'Malayalam', handles: ['@SaregamaMalayalam', '@MuzikLab', '@SonyMusicSouth', '@GoodwillEntertainments'] },
  punjabi: { label: 'Punjabi', handles: ['@SpeedRecords', '@TSeriesApnaPunjab', '@WhiteHillMusic'] },
};

const HOUR = 3600 * 1000;
const memo = new Map();

async function cached(key, ttl, fn, { persist = false } = {}) {
  const hit = persist ? store.get('ytCache')[key] : memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = await fn();
  const entry = { at: Date.now(), data };
  if (persist) {
    // Keep the persisted cache small: drop entries older than a day.
    const fresh = Object.fromEntries(Object.entries(store.get('ytCache')).filter(([, v]) => Date.now() - v.at < 24 * HOUR));
    store.set('ytCache', { ...fresh, [key]: entry }, { silent: true });
  } else memo.set(key, entry);
  return data;
}

/* ==========================================================================
   Apple / iTunes (no key needed)
   ========================================================================== */
const SOUNDTRACK = /\s*[([]\s*(original\s+motion\s+picture\s+soundtrack|original\s+soundtrack|from\s+[^)\]]*)[)\]]\s*/gi;

function cleanAlbum(name) {
  return String(name || '').replace(SOUNDTRACK, ' ').replace(/\s*-\s*(EP|Single)$/i, '').trim();
}

function fromItunes(r) {
  return {
    id: `itunes:${r.trackId}`,
    source: 'itunes',
    itunesId: r.trackId,
    title: String(r.trackName || '').replace(SOUNDTRACK, ' ').trim(),
    artist: r.artistName || '',
    album: cleanAlbum(r.collectionName),
    artwork: (r.artworkUrl100 || '').replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/600x600bb.jpg'),
    duration: r.trackTimeMillis ? r.trackTimeMillis / 1000 : 0,
    preview: r.previewUrl || '',
    released: r.releaseDate || '',
  };
}

function dedupe(tracks) {
  const seen = new Set();
  return tracks.filter((t) => {
    const k = `${t.title}|${t.artist}`.toLowerCase();
    return !seen.has(k) && seen.add(k);
  });
}

async function itunesSearch(params) {
  const qs = new URLSearchParams({ media: 'music', entity: 'song', country: 'in', limit: '200', ...params });
  const data = await jsonp(`https://itunes.apple.com/search?${qs}`);
  return (data?.results || []).filter((r) => r.kind === 'song' && r.previewUrl);
}

// Newest songs in a language, sorted by release date.
export function latest(lang) {
  return cached(`latest:${lang}`, 6 * HOUR, async () => {
    const L = LANGS[lang];
    let results = await itunesSearch({ term: L.label, attribute: 'genreIndex' });
    if (results.length < 15) results = results.concat(await itunesSearch({ term: L.label }));
    return dedupe(results.map(fromItunes))
      .sort((a, b) => (b.released || '').localeCompare(a.released || ''))
      .slice(0, 60);
  });
}

// Apple Music India top songs for a language (legacy RSS feed). Returns [] when unavailable.
export function topChart(lang) {
  const L = LANGS[lang];
  if (!L.genreId) return Promise.resolve([]);
  return cached(`top:${lang}`, 6 * HOUR, async () => {
    try {
      const res = await fetch(`https://itunes.apple.com/in/rss/topsongs/limit=50/genre=${L.genreId}/json`);
      const json = await res.json();
      return (json.feed?.entry || []).map((e) => {
        const preview = (e.link || []).find?.((l) => l.attributes?.assetType === 'preview');
        const img = e['im:image']?.[e['im:image'].length - 1]?.label || '';
        return fromItunes({
          trackId: e.id?.attributes?.['im:id'],
          trackName: e['im:name']?.label,
          artistName: e['im:artist']?.label,
          collectionName: e['im:collection']?.['im:name']?.label,
          artworkUrl100: img.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/100x100bb.jpg'),
          previewUrl: preview?.attributes?.href,
          trackTimeMillis: Number(preview?.['im:duration']?.label) || 0,
          releaseDate: e['im:releaseDate']?.label,
        });
      }).filter((t) => t.itunesId && t.preview);
    } catch {
      return [];
    }
  });
}

// Song search in the Indian catalogue (works without a key; previews or full via YouTube).
export function searchSongs(q) {
  return cached(`isearch:${q.toLowerCase()}`, HOUR, async () => dedupe((await itunesSearch({ term: q, limit: '30' })).map(fromItunes)));
}

/* ==========================================================================
   YouTube Data API (free key; ~10,000 units/day — a search costs 100, a list costs 1)
   ========================================================================== */
export const hasKey = () => !!store.get('settings').ytKey;

async function yt(path, params, key = store.get('settings').ytKey) {
  if (!key) throw new Error('No YouTube key');
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key })}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = json.error?.errors?.[0]?.reason || '';
    const err = new Error(reason === 'quotaExceeded'
      ? 'Today’s free YouTube limit is used up — it resets tomorrow'
      : json.error?.message || `YouTube error ${res.status}`);
    err.reason = reason;
    throw err;
  }
  return json;
}

export async function testKey(key) {
  await yt('videos', { part: 'id', id: 'dQw4w9WgXcQ' }, key);
  return true;
}

function decode(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

const JUNK = /\b(full\s+video\s+song|full\s+video|video\s+song|lyrical\s+video|lyrical\s+song|lyrical|lyric\s+video|official\s+video|official\s+audio|official\s+music\s+video|music\s+video|full\s+song|audio\s+song|official|4k|hd|hq)\b/gi;
const LANG_TAG = /\(\s*(telugu|tamil|hindi|kannada|malayalam|punjabi|marathi|bengali)\s*\)/gi;

// "Naatu Naatu Full Video Song (Telugu) | RRR Songs | NTR, Ram Charan" -> title "Naatu Naatu", album "RRR".
function parseVideoTitle(raw) {
  const parts = decode(raw).split(/\s+[|│]\s+|\s+\/\/\s+/).map((p) => p.trim()).filter(Boolean);
  const hasJunk = (x) => new RegExp(JUNK.source, 'i').test(x);
  const strip = (x) => String(x || '').replace(JUNK, ' ').replace(LANG_TAG, ' ');
  let title = parts[0] || '';
  let album = parts[1] || '';
  const dash = title.match(/^(.+?)\s+[-–]\s+(.+)$/);
  if (dash) {
    const [a, b] = [dash[1], dash[2]];
    if (a.trim().startsWith('#')) [title, album] = [b, a];               // "#Movie - Song Name"
    else if (hasJunk(b) || !strip(b).trim()) title = a;                 // "Song - Lyric Video | Movie"
    else [title, album] = [a, b];                                       // "Song - Movie | Actors"
  }
  album = strip(album).replace(/#/g, '').replace(/\b(movie\s+)?songs?\b|\bmovie\b|\bfull\b/gi, ' ');
  const tidy = (x) => x.replace(/[[\]{}]/g, ' ').replace(/^[\s\-–:#]+|[\s\-–:,]+$/g, '').replace(/\s{2,}/g, ' ').trim();
  return { title: tidy(strip(title).replace(/#/g, '')) || decode(raw), album: tidy(album) };
}

function fromYouTube(videoId, snippet) {
  const { title, album } = parseVideoTitle(snippet.title || '');
  return {
    id: `yt:${videoId}`,
    source: 'youtube',
    videoId,
    title,
    artist: decode(snippet.videoOwnerChannelTitle || snippet.channelTitle || 'YouTube'),
    album,
    artwork: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    duration: 0,
    link: `https://www.youtube.com/watch?v=${videoId}`,
    published: snippet.publishedAt || '',
  };
}

async function ytSearch(q, extra = {}) {
  const json = await yt('search', {
    part: 'snippet', type: 'video', videoEmbeddable: 'true', videoCategoryId: '10',
    regionCode: 'IN', maxResults: '25', q, ...extra,
  });
  return (json.items || []).filter((i) => i.id?.videoId).map((i) => fromYouTube(i.id.videoId, i.snippet));
}

const SONGLIKE = /song|lyric|video|audio|full|music/i;
const NOT_SONG = /\b(trailer|teaser|glimpse|promo|making|bts|behind the scenes|jukebox|interview|press meet|pre[-\s]?release|event|speech|bgm|ringtone|reaction|scene|dialogue|first look|motion poster|announcement|shorts?)\b|#shorts/i;

// Most-watched songs of the last 30 days for a language.
export function trending(lang) {
  return cached(`yt-trend:${lang}`, 6 * HOUR, async () => {
    const since = new Date(Date.now() - 30 * 24 * HOUR).toISOString();
    const items = await ytSearch(`${LANGS[lang].label} songs`, { order: 'viewCount', publishedAfter: since, maxResults: '40' });
    return items.filter((t) => !NOT_SONG.test(t.title));
  }, { persist: true });
}

async function uploadsPlaylist(handle) {
  const known = store.get('ytChannels')[handle];
  if (known !== undefined) return known;
  let id = '';
  try {
    const json = await yt('channels', { part: 'contentDetails', forHandle: handle });
    id = json.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || '';
  } catch (e) {
    if (e.reason === 'quotaExceeded') throw e;
  }
  store.set('ytChannels', { ...store.get('ytChannels'), [handle]: id }, { silent: true });
  return id;
}

// Newest song uploads from the big music labels' official channels.
export function fromLabels(lang) {
  return cached(`yt-labels:${lang}`, 3 * HOUR, async () => {
    const lists = await Promise.all(LANGS[lang].handles.map(async (h) => {
      const pl = await uploadsPlaylist(h).catch(() => '');
      if (!pl) return [];
      const json = await yt('playlistItems', { part: 'snippet', playlistId: pl, maxResults: '25' }).catch(() => ({}));
      return (json.items || [])
        .filter((i) => i.snippet?.resourceId?.videoId && i.snippet.title !== 'Private video' && i.snippet.title !== 'Deleted video')
        .filter((i) => SONGLIKE.test(i.snippet.title) && !NOT_SONG.test(i.snippet.title))
        .filter((i) => lang === 'hindi' || lang === 'punjabi' || new RegExp(LANGS[lang].label, 'i').test(i.snippet.title) || !/\((telugu|tamil|hindi|kannada|malayalam)\)/i.test(i.snippet.title))
        .map((i) => fromYouTube(i.snippet.resourceId.videoId, i.snippet));
    }));
    return dedupe(lists.flat()).sort((a, b) => (b.published || '').localeCompare(a.published || '')).slice(0, 40);
  }, { persist: true });
}

export function searchYouTube(q) {
  return cached(`yt-search:${q.toLowerCase()}`, 24 * HOUR, () => ytSearch(`${q} song`, { maxResults: '15' }), { persist: true });
}

// Find the official full song on YouTube for a chart/preview song.
export async function findVideo(track) {
  if (track.videoId) return track.videoId;
  if (!hasKey()) return null;
  const known = store.get('ytMatch')[track.id];
  if (known) return known;
  const q = [track.title, track.album && track.album !== track.title ? track.album : '', track.artist.split(/,|&/)[0], 'song']
    .filter(Boolean).join(' ');
  const items = await ytSearch(q, { maxResults: '3' });
  const id = items[0]?.videoId || null;
  if (id) store.set('ytMatch', { ...store.get('ytMatch'), [track.id]: id }, { silent: true });
  return id;
}
