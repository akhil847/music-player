// Playback engine: queue, shuffle/repeat, media session (lock screen controls), sleep timer.
import * as audius from './audius.js';
import { files } from './db.js';

export const REPEAT = { OFF: 'off', ALL: 'all', ONE: 'one' };

export class Player extends EventTarget {
  constructor(audio) {
    super();
    this.audio = audio;
    this.queue = [];      // tracks in the order they were added
    this.order = [];      // indexes into queue, in play order
    this.pos = -1;        // position within order
    this.shuffle = false;
    this.repeat = REPEAT.OFF;
    this.errorStreak = 0;
    this.objectUrl = null;
    this.loadToken = 0;
    this.sleep = null;    // { at: timestamp } | { endOfTrack: true }

    audio.addEventListener('play', () => this.emit('state'));
    audio.addEventListener('pause', () => this.emit('state'));
    audio.addEventListener('playing', () => { this.errorStreak = 0; this.emit('state'); });
    audio.addEventListener('waiting', () => this.emit('state'));
    audio.addEventListener('timeupdate', () => { this.emit('time'); this.checkSleep(); });
    audio.addEventListener('durationchange', () => { this.emit('time'); this.updatePositionState(); });
    audio.addEventListener('loadedmetadata', () => this.updatePositionState());
    audio.addEventListener('ended', () => this.onEnded());
    audio.addEventListener('error', () => this.onError());
    this.setupMediaSession();
    setInterval(() => this.checkSleep(), 1000);
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get current() { return this.pos >= 0 ? this.queue[this.order[this.pos]] : null; }
  get playing() { return !this.audio.paused; }
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
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
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
    let src;
    try {
      src = await this.resolve(track);
    } catch (err) {
      if (token === this.loadToken) this.failTrack(err);
      return;
    }
    if (token !== this.loadToken) return;
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

  async resolve(track) {
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
    if (track.source === 'audius') return audius.streamUrl(track.audiusId);
    if (track.source === 'url') return track.src;
    if (track.source === 'local') {
      const blob = await files.get(track.id);
      if (!blob) throw new Error('This file is no longer on this device');
      this.objectUrl = URL.createObjectURL(blob);
      return this.objectUrl;
    }
    throw new Error('Unknown track source');
  }

  toggle() {
    if (!this.current) return;
    if (this.audio.paused) {
      this.wantPlay = true;
      if (!this.audio.currentSrc) this.load(true);
      else this.audio.play().catch(() => {});
    } else {
      this.wantPlay = false;
      this.audio.pause();
    }
  }

  play() { if (this.audio.paused) this.toggle(); }
  pause() { this.wantPlay = false; this.audio.pause(); }

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
      this.audio.pause();
      this.audio.currentTime = 0;
      this.emit('state');
      return;
    }
    this.emit('queue');
    return this.load(true);
  }

  prev() {
    if (!this.order.length) return;
    if (this.audio.currentTime > 3 || this.pos === 0 && this.repeat !== REPEAT.ALL) {
      this.audio.currentTime = 0;
      return;
    }
    this.pos = this.pos > 0 ? this.pos - 1 : this.order.length - 1;
    this.emit('queue');
    return this.load(true);
  }

  seek(seconds) {
    if (!isFinite(this.audio.duration)) return;
    this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration));
    this.updatePositionState();
  }

  seekBy(delta) { this.seek(this.audio.currentTime + delta); }

  setVolume(v) { this.audio.volume = Math.max(0, Math.min(1, v)); this.audio.muted = false; this.emit('volume'); }
  toggleMute() { this.audio.muted = !this.audio.muted; this.emit('volume'); }
  setRate(r) { this.rate = r; this.audio.playbackRate = r; this.emit('rate'); }

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
    if (this.repeat === REPEAT.ONE) { this.audio.currentTime = 0; this.audio.play().catch(() => {}); return; }
    this.next(true);
  }

  onError() {
    if (!this.audio.getAttribute('src')) return;
    this.failTrack(new Error('Could not play this track'));
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
      this.audio.pause();
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
      album: 'Echo',
      artwork: t.artwork
        ? [{ src: t.artwork, sizes: '480x480', type: 'image/jpeg' }]
        : [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
    });
  }

  updatePositionState() {
    const a = this.audio;
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!isFinite(a.duration) || a.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({ duration: a.duration, position: Math.min(a.currentTime, a.duration), playbackRate: a.playbackRate || 1 });
    } catch { /* ignore */ }
  }

  /* ---------- Persistence ---------- */
  snapshot() {
    if (!this.current) return null;
    return { queue: this.queue, order: this.order, pos: this.pos, position: this.audio.currentTime || 0, shuffle: this.shuffle, repeat: this.repeat };
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
