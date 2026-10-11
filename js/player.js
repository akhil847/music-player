// Playback engine: queue, shuffle/repeat, media session (lock screen controls), sleep timer.
import * as audius from './audius.js';
import { files } from './db.js';
import { YTEngine } from './youtube.js';

export const REPEAT = { OFF: 'off', ALL: 'all', ONE: 'one' };

export class Player extends EventTarget {
  constructor(audio, ytContainer) {
    super();
    this.audio = audio;
    this.yt = new YTEngine(ytContainer);
    this.media = audio;   // whichever engine plays the current song (audio element or YouTube)
    this.findVideo = null; // set by the app: finds the full YouTube song for a chart/preview track
    this.queue = [];      // tracks in the order they were added
    this.order = [];      // indexes into queue, in play order
    this.pos = -1;        // position within order
    this.shuffle = false;
    this.repeat = REPEAT.OFF;
    this.errorStreak = 0;
    this.objectUrl = null;
    this.loadToken = 0;
    this.sleep = null;    // { at: timestamp } | { endOfTrack: true }

    for (const media of [audio, this.yt]) {
      // Ignore events from the engine that isn't playing the current song.
      const on = (type, fn) => media.addEventListener(type, (e) => { if (media === this.media) fn(e); });
      on('play', () => { this.bgPaused = false; this.emit('state'); });
      on('pause', () => {
        // Paused by the browser because the app went to the background (not by the user)?
        if (document.hidden && Date.now() - this.userPausedAt > 1500) this.bgPaused = true;
        this.emit('state');
      });
      on('playing', () => { this.errorStreak = 0; this.emit('state'); });
      on('waiting', () => this.emit('state'));
      on('timeupdate', () => { this.emit('time'); this.checkSleep(); });
      on('durationchange', () => { this.emit('time'); this.updatePositionState(); });
      on('loadedmetadata', () => this.updatePositionState());
      on('ended', () => this.onEnded());
      on('error', (e) => this.onError(e.detail));
    }
    this.bgPaused = false;
    this.userPausedAt = 0;
    // Coming back to the app: carry on with a song the browser paused in the background.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !this.bgPaused || !this.current) return;
      this.bgPaused = false;
      if (this.media.paused) {
        this.media.play().then(() => this.emit('resumed')).catch(() => this.emit('state'));
      }
    });
    this.setupMediaSession();
    setInterval(() => this.checkSleep(), 1000);
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get current() { return this.pos >= 0 ? this.queue[this.order[this.pos]] : null; }
  get playing() { return !this.media.paused; }
  get onYouTube() { return this.media === this.yt; }
  get upcoming() { return this.order.slice(this.pos + 1).map((i) => this.queue[i]); }
  get history() { return this.order.slice(0, Math.max(0, this.pos)).map((i) => this.queue[i]); }

  /* ---------- Queue building ---------- */
  playList(tracks, startIndex = 0, { shuffle } = {}) {
    if (!tracks.length) return;
    if (shuffle !== undefined) this.shuffle = shuffle;
    this.queue = tracks.slice();
    this.order = tracks.map((_, i) => i);
    if (this.shuffle) {
      const start = shuffle && startIndex === 0 ? Math.floor(Math.random() * tracks.length) : startIndex;
      this.order = [start, ...shuffled(this.order.filter((i) => i !== start))];
      this.pos = 0;
    } else {
      this.pos = Math.min(Math.max(startIndex, 0), tracks.length - 1);
    }
    this.emit('queue');
    return this.load(true);
  }

  playNext(tracks) {
    tracks = [].concat(tracks);
    if (!this.current) return this.playList(tracks);
    const base = this.queue.length;
    this.queue.push(...tracks);
    this.order.splice(this.pos + 1, 0, ...tracks.map((_, i) => base + i));
    this.emit('queue');
  }

  addToQueue(tracks) {
    tracks = [].concat(tracks);
    if (!this.current) return this.playList(tracks);
    const base = this.queue.length;
    this.queue.push(...tracks);
    this.order.push(...tracks.map((_, i) => base + i));
    this.emit('queue');
  }

  // Remove the item at `p` positions into the play order.
  removeAt(p) {
    if (p < 0 || p >= this.order.length) return;
    const qi = this.order[p];
    this.queue.splice(qi, 1);
    this.order.splice(p, 1);
    this.order = this.order.map((i) => (i > qi ? i - 1 : i));
    if (p < this.pos) this.pos--;
    else if (p === this.pos) {
      if (!this.order.length) { this.stop(); return; }
      if (this.pos >= this.order.length) this.pos = this.order.length - 1;
      this.load(this.playing);
    }
    this.emit('queue');
  }

  move(p, to) {
    if (to <= this.pos || to >= this.order.length || p <= this.pos) return;
    const [qi] = this.order.splice(p, 1);
    this.order.splice(to, 0, qi);
    this.emit('queue');
  }

  jumpTo(p) {
    if (p < 0 || p >= this.order.length) return;
    this.pos = p;
    this.emit('queue');
    this.load(true);
  }

  clearUpcoming() {
    const keep = this.order.slice(0, this.pos + 1);
    this.queue = keep.map((i) => this.queue[i]);
    this.order = keep.map((_, i) => i);
    this.emit('queue');
  }

  stop() {
    this.releaseAudio();
    this.yt.stop();
    this.media = this.audio;
    this.emit('engine');
    this.queue = []; this.order = []; this.pos = -1;
    this.emit('track'); this.emit('queue'); this.emit('state');
  }

  /* ---------- Transport ---------- */
  async load(autoplay, startAt = 0) {
    const track = this.current;
    if (!track) return;
    const token = ++this.loadToken;
    this.wantPlay = !!autoplay;
    this.emit('track');
    this.updateMediaMetadata();
    this.previewFallback = false;
    let r;
    try {
      r = await this.resolve(track);
    } catch (err) {
      if (token === this.loadToken) this.failTrack(err);
      return;
    }
    if (token !== this.loadToken) return;
    if (r.kind === 'yt') {
      this.switchTo(this.yt);
      try {
        await this.yt.load(r.videoId, { autoplay, startAt });
      } catch (err) {
        if (token === this.loadToken) this.onError({ message: err.message });
      }
      return;
    }
    this.switchTo(this.audio);
    if (r.preview) this.emit('preview', { track });
    this.playUrl(r.src, autoplay, startAt);
  }

  async playUrl(src, autoplay, startAt = 0) {
    this.audio.src = src;
    this.audio.playbackRate = this.rate || 1;
    if (startAt) {
      const seek = () => { try { this.audio.currentTime = startAt; } catch { /* ignore */ } };
      this.audio.addEventListener('loadedmetadata', seek, { once: true });
    }
    if (autoplay) {
      try { await this.audio.play(); } catch (err) {
        if (err.name !== 'AbortError') this.emit('state');
      }
    }
  }

  switchTo(media) {
    if (media === this.media) return;
    if (this.media === this.yt) this.yt.stop();
    else this.releaseAudio();
    this.media = media;
    this.emit('engine');
  }

  releaseAudio() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  // -> { kind: 'audio', src, preview? } | { kind: 'yt', videoId }
  async resolve(track) {
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
    if (track.source === 'youtube') return { kind: 'yt', videoId: track.videoId };
    if (track.source === 'itunes') {
      // Full song from YouTube when possible, otherwise Apple's 30-second preview.
      const videoId = await this.findVideo?.(track).catch((err) => { this.emit('notice', { message: err.message }); return null; });
      if (videoId) return { kind: 'yt', videoId };
      if (track.preview) return { kind: 'audio', src: track.preview, preview: true };
      throw new Error('No playable version of this song was found');
    }
    if (track.source === 'audius') return { kind: 'audio', src: await audius.streamUrl(track.audiusId) };
    if (track.source === 'url') return { kind: 'audio', src: track.src };
    if (track.source === 'local') {
      const blob = await files.get(track.id);
      if (!blob) throw new Error('This file is no longer on this device');
      this.objectUrl = URL.createObjectURL(blob);
      return { kind: 'audio', src: this.objectUrl };
    }
    throw new Error('Unknown track source');
  }

  toggle() {
    if (!this.current) return;
    if (this.media.paused) {
      this.wantPlay = true;
      if (!this.media.currentSrc) this.load(true);
      else this.media.play().catch(() => this.load(true));
    } else {
      this.wantPlay = false;
      this.userPausedAt = Date.now();
      this.bgPaused = false;
      this.media.pause();
    }
  }

  play() { if (this.media.paused) this.toggle(); }
  pause() { this.wantPlay = false; this.userPausedAt = Date.now(); this.bgPaused = false; this.media.pause(); }

  next(auto = false) {
    if (!this.order.length) return;
    if (this.pos + 1 < this.order.length) this.pos++;
    else if (this.repeat === REPEAT.ALL) {
      if (this.shuffle) this.reshuffle(true);
      this.pos = 0;
    } else if (!auto) {
      // Manual "next" at the end of the queue wraps to the start, keeping the play/pause state.
      this.pos = 0;
      this.emit('queue');
      return this.load(this.playing);
    } else {
      this.media.pause();
      this.media.currentTime = 0;
      this.emit('state');
      return;
    }
    this.emit('queue');
    return this.load(true);
  }

  prev() {
    if (!this.order.length) return;
    if (this.media.currentTime > 3 || this.pos === 0 && this.repeat !== REPEAT.ALL) {
      this.media.currentTime = 0;
      return;
    }
    this.pos = this.pos > 0 ? this.pos - 1 : this.order.length - 1;
    this.emit('queue');
    return this.load(true);
  }

  seek(seconds) {
    if (!isFinite(this.media.duration)) return;
    this.media.currentTime = Math.max(0, Math.min(seconds, this.media.duration));
    this.updatePositionState();
  }

  seekBy(delta) { this.seek(this.media.currentTime + delta); }

  get volume() { return this.audio.volume; }
  get muted() { return this.audio.muted; }
  setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    for (const m of [this.audio, this.yt]) { m.volume = v; m.muted = false; }
    this.emit('volume');
  }
  toggleMute() {
    const m = !this.audio.muted;
    this.audio.muted = m;
    this.yt.muted = m;
    this.emit('volume');
  }
  setRate(r) { this.rate = r; this.audio.playbackRate = r; this.yt.playbackRate = r; this.emit('rate'); }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.order.length) {
      if (this.shuffle) this.reshuffle(false);
      else {
        const qi = this.order[this.pos];
        this.order = this.queue.map((_, i) => i);
        this.pos = qi;
      }
    }
    this.emit('mode'); this.emit('queue');
  }

  // Shuffle everything after the current track (or the whole queue when restarting).
  reshuffle(all) {
    if (all) { this.order = shuffled(this.queue.map((_, i) => i)); return; }
    const qi = this.order[this.pos];
    this.order = [qi, ...shuffled(this.queue.map((_, i) => i).filter((i) => i !== qi))];
    this.pos = 0;
  }

  cycleRepeat() {
    this.repeat = this.repeat === REPEAT.OFF ? REPEAT.ALL : this.repeat === REPEAT.ALL ? REPEAT.ONE : REPEAT.OFF;
    this.emit('mode');
  }

  onEnded() {
    if (this.sleep?.endOfTrack) { this.sleep = null; this.emit('sleep'); this.emit('state'); return; }
    if (this.repeat === REPEAT.ONE) { this.media.currentTime = 0; this.media.play().catch(() => {}); return; }
    this.next(true);
  }

  onError(detail) {
    if (this.media === this.audio && !this.audio.getAttribute('src')) return;
    const t = this.current;
    // A chart song whose YouTube video can't be embedded falls back to its 30-second preview.
    if (this.media === this.yt && t?.source === 'itunes' && t.preview && !this.previewFallback) {
      this.previewFallback = true;
      this.switchTo(this.audio);
      this.emit('preview', { track: t, reason: detail?.message });
      this.playUrl(t.preview, true);
      return;
    }
    this.failTrack(new Error(detail?.message || 'Could not play this track'));
  }

  failTrack(err) {
    this.errorStreak++;
    this.emit('error', { message: err.message, track: this.current });
    // Only skip ahead when the user was actually trying to listen (not e.g. when restoring a session offline).
    if (this.wantPlay && this.errorStreak < 4 && this.pos + 1 < this.order.length) this.next(true);
  }

  /* ---------- Sleep timer ---------- */
  setSleep(minutes) {
    if (minutes === 'end') this.sleep = { endOfTrack: true };
    else if (minutes > 0) this.sleep = { at: Date.now() + minutes * 60000 };
    else this.sleep = null;
    this.emit('sleep');
  }

  checkSleep() {
    if (this.sleep?.at && Date.now() >= this.sleep.at) {
      this.sleep = null;
      this.userPausedAt = Date.now();
      this.media.pause();
      this.emit('sleep');
    }
  }

  /* ---------- Media Session (lock screen / headphones / car) ---------- */
  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers = {
      play: () => this.play(),
      pause: () => this.pause(),
      previoustrack: () => this.prev(),
      nexttrack: () => this.next(),
      seekbackward: (d) => this.seekBy(-(d.seekOffset || 10)),
      seekforward: (d) => this.seekBy(d.seekOffset || 10),
      seekto: (d) => this.seek(d.seekTime),
      stop: () => this.pause(),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ }
    }
  }

  updateMediaMetadata() {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    const t = this.current;
    if (!t) { navigator.mediaSession.metadata = null; return; }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: this.context?.label || 'Echo',
      artwork: t.artwork
        ? [{ src: t.artwork, sizes: '480x480', type: 'image/jpeg' }]
        : [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
    });
  }

  updatePositionState() {
    const a = this.media;
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!isFinite(a.duration) || a.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({ duration: a.duration, position: Math.min(a.currentTime, a.duration), playbackRate: a.playbackRate || 1 });
    } catch { /* ignore */ }
  }

  /* ---------- Persistence ---------- */
  snapshot() {
    if (!this.current) return null;
    return { queue: this.queue, order: this.order, pos: this.pos, position: this.media.currentTime || 0, shuffle: this.shuffle, repeat: this.repeat };
  }

  restore(s) {
    if (!s || !Array.isArray(s.queue) || !s.queue.length) return;
    this.queue = s.queue;
    this.order = Array.isArray(s.order) && s.order.length === s.queue.length ? s.order : s.queue.map((_, i) => i);
    this.pos = Math.min(Math.max(s.pos || 0, 0), this.order.length - 1);
    this.shuffle = !!s.shuffle;
    this.repeat = Object.values(REPEAT).includes(s.repeat) ? s.repeat : REPEAT.OFF;
    this.emit('queue'); this.emit('mode');
    this.load(false, s.position || 0);
  }
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
