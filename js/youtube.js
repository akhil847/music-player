// YouTube playback engine with the same interface as an <audio> element, so the Player can
// switch between the two per song. Uses the official IFrame Player API; the video stays visible
// in a small dock (or full size on the Now Playing screen), as YouTube's terms require.
let apiPromise;

function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { apiPromise = null; reject(new Error('Could not load YouTube')); };
      document.head.append(s);
    });
  }
  return apiPromise;
}

const ERRORS = {
  2: 'This YouTube video link is invalid',
  5: 'YouTube couldn’t play this video here',
  100: 'This YouTube video was removed or made private',
  101: 'The owner doesn’t allow this video to play outside YouTube',
  150: 'The owner doesn’t allow this video to play outside YouTube',
};

export class YTEngine extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.player = null;
    this.ready = null;
    this.videoId = '';
    this.timer = null;
    this._paused = true;
    this._duration = NaN;
    this._volume = 1;
    this._muted = false;
    this._rate = 1;
  }

  fire(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  ensure() {
    if (!this.ready) {
      this.ready = loadApi().then((YT) => new Promise((resolve) => {
        const el = document.createElement('div');
        this.container.append(el);
        this.player = new YT.Player(el, {
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
          events: {
            onReady: () => resolve(this.player),
            onStateChange: (e) => this.onState(e.data),
            onError: (e) => this.onError(e.data),
          },
        });
      }));
      this.ready.catch(() => { this.ready = null; });
    }
    return this.ready;
  }

  async load(videoId, { autoplay = false, startAt = 0 } = {}) {
    const p = await this.ensure();
    this.videoId = videoId;
    this._duration = NaN;
    this._paused = true;
    p.setVolume(Math.round(this._volume * 100));
    if (this._muted) p.mute(); else p.unMute();
    const opts = { videoId, startSeconds: startAt || 0 };
    if (autoplay) p.loadVideoById(opts); else p.cueVideoById(opts);
    try { p.setPlaybackRate(this._rate); } catch { /* not all rates are available */ }
    this.fire('timeupdate');
  }

  onState(s) {
    const S = window.YT.PlayerState;
    if (s === S.PLAYING) {
      const wasPaused = this._paused;
      this._paused = false;
      this.updateDuration();
      if (wasPaused) this.fire('play');
      this.fire('playing');
      this.startTimer();
    } else if (s === S.PAUSED) {
      if (!this._paused) { this._paused = true; this.fire('pause'); }
      this.stopTimer();
      this.fire('timeupdate');
    } else if (s === S.BUFFERING) {
      this.fire('waiting');
    } else if (s === S.ENDED) {
      this._paused = true;
      this.stopTimer();
      this.fire('pause');
      this.fire('ended');
    } else if (s === S.CUED) {
      this.updateDuration();
    }
  }

  onError(code) {
    this._paused = true;
    this.stopTimer();
    this.fire('error', { code, message: ERRORS[code] || 'YouTube couldn’t play this song' });
  }

  updateDuration() {
    const d = this.player?.getDuration?.();
    if (d && d !== this._duration) {
      this._duration = d;
      this.fire('durationchange');
      this.fire('loadedmetadata');
    }
  }

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => { this.updateDuration(); this.fire('timeupdate'); }, 250);
  }

  stopTimer() { clearInterval(this.timer); this.timer = null; }

  get paused() { return this._paused; }
  get currentSrc() { return this.videoId; }
  get duration() { return this._duration; }
  get currentTime() { return this.player?.getCurrentTime?.() || 0; }
  set currentTime(t) { this.player?.seekTo?.(t, true); this.fire('timeupdate'); }
  get volume() { return this._volume; }
  set volume(v) { this._volume = v; this.player?.setVolume?.(Math.round(v * 100)); }
  get muted() { return this._muted; }
  set muted(m) {
    this._muted = m;
    if (this.player?.mute) { if (m) this.player.mute(); else this.player.unMute(); }
  }
  get playbackRate() { return this._rate; }
  set playbackRate(r) { this._rate = r; try { this.player?.setPlaybackRate?.(r); } catch { /* ignore */ } }

  play() {
    if (!this.player?.playVideo) return Promise.reject(new Error('YouTube is not ready'));
    this.player.playVideo();
    return Promise.resolve();
  }

  pause() { this.player?.pauseVideo?.(); }

  stop() {
    this.player?.stopVideo?.();
    this._paused = true;
    this.stopTimer();
    this.videoId = '';
  }
}
