const ORIGIN = 'https://www.youtube-nocookie.com';

export const State = Object.freeze({
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
});

/**
 * Invisible youtube-nocookie embed driven through the embed's postMessage protocol
 * (the same one YouTube's iframe_api script uses), so www.youtube.com never has to be
 * reachable from the browser. The iframe is kept at 200×200 — the smallest size YouTube
 * allows — so it streams the lowest quality (144p) and uses minimal bandwidth.
 *
 * Events: "ready", "statechange", "timeupdate", "error" (detail = YouTube error code),
 * "blocked" (the embed never answered — youtube-nocookie.com is probably unreachable).
 */
export class HiddenPlayer extends EventTarget {
  state = State.UNSTARTED;
  duration = 0;
  videoId = null;

  #iframe = null;
  #ready = false;
  #pending = [];
  #handshake = null;
  #readyTimeout = null;
  #time = 0;
  #stamp = 0;
  #loadedAt = 0;
  #volume = 100;
  #muted = false;
  #wantPlay = false;

  constructor(host) {
    super();
    this.host = host;
    window.addEventListener('message', (e) => this.#onMessage(e));
  }

  get currentTime() {
    if (this.state !== State.PLAYING) return this.#time;
    const t = this.#time + (performance.now() - this.#stamp) / 1000;
    return this.duration ? Math.min(t, this.duration) : t;
  }

  get isPlaying() {
    return this.state === State.PLAYING || this.state === State.BUFFERING;
  }

  load(videoId, start = 0) {
    this.videoId = videoId;
    this.duration = 0;
    this.#time = start;
    this.#stamp = this.#loadedAt = performance.now();
    this.#wantPlay = true;
    if (!this.#iframe) return this.#create(videoId);
    this.#command('loadVideoById', [videoId, start, 'tiny']);
  }

  play() {
    this.#wantPlay = true;
    this.#command('playVideo');
  }

  pause() {
    this.#wantPlay = false;
    this.#command('pauseVideo');
  }

  seek(seconds) {
    this.#time = Math.max(0, seconds);
    this.#stamp = performance.now();
    this.#command('seekTo', [this.#time, true]);
    this.dispatchEvent(new Event('timeupdate'));
  }

  setVolume(volume) {
    this.#volume = volume;
    this.#command('setVolume', [volume]);
  }

  setMuted(muted) {
    this.#muted = muted;
    this.#command(muted ? 'mute' : 'unMute');
  }

  #create(videoId) {
    const params = new URLSearchParams({
      enablejsapi: '1',
      autoplay: '1',
      controls: '0',
      disablekb: '1',
      fs: '0',
      iv_load_policy: '3',
      playsinline: '1',
      rel: '0',
      vq: 'tiny',
      origin: location.origin,
      widget_referrer: location.href,
    });
    const iframe = document.createElement('iframe');
    iframe.width = '200';
    iframe.height = '200';
    iframe.title = 'Audio player';
    iframe.tabIndex = -1;
    iframe.setAttribute('allow', 'autoplay; encrypted-media');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.src = `${ORIGIN}/embed/${encodeURIComponent(videoId)}?${params}`;
    iframe.addEventListener('load', () => this.#startHandshake());
    this.host.append(iframe);
    this.#iframe = iframe;
    this.#readyTimeout = setTimeout(() => {
      if (!this.#ready) this.dispatchEvent(new Event('blocked'));
    }, 20000);
  }

  #startHandshake() {
    clearInterval(this.#handshake);
    const ping = () => this.#post({ event: 'listening' });
    ping();
    this.#handshake = setInterval(() => (this.#ready ? clearInterval(this.#handshake) : ping()), 250);
  }

  #post(message) {
    this.#iframe?.contentWindow?.postMessage(
      JSON.stringify({ ...message, id: 1, channel: 'widget' }),
      ORIGIN
    );
  }

  #command(func, args = []) {
    if (!this.#ready) {
      this.#pending.push([func, args]);
      return;
    }
    this.#post({ event: 'command', func, args });
  }

  #onMessage(event) {
    if (event.origin !== ORIGIN || !this.#iframe || event.source !== this.#iframe.contentWindow) return;
    let data;
    try {
      data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    switch (data?.event) {
      case 'onReady':
        return this.#onReady();
      case 'initialDelivery':
      case 'infoDelivery':
        return this.#onInfo(data.info);
      case 'onStateChange':
        return this.#setState(data.info);
      case 'onError':
        return this.dispatchEvent(new CustomEvent('error', { detail: data.info }));
    }
  }

  #onReady() {
    if (this.#ready) return;
    this.#ready = true;
    clearInterval(this.#handshake);
    clearTimeout(this.#readyTimeout);
    for (const name of ['onStateChange', 'onError']) {
      this.#post({ event: 'command', func: 'addEventListener', args: [name] });
    }
    this.#post({ event: 'command', func: 'setVolume', args: [this.#volume] });
    this.#post({ event: 'command', func: this.#muted ? 'mute' : 'unMute', args: [] });
    for (const [func, args] of this.#pending.splice(0)) this.#post({ event: 'command', func, args });
    if (this.#wantPlay) this.#post({ event: 'command', func: 'playVideo', args: [] });
    this.dispatchEvent(new Event('ready'));
  }

  #onInfo(info) {
    if (!info || typeof info !== 'object') return;
    const reportedId = info.videoData?.video_id;
    // Right after switching videos the embed can still report the previous one's clock.
    const fresh = reportedId ? reportedId === this.videoId : performance.now() - this.#loadedAt > 1000;
    if (fresh) {
      if (typeof info.currentTime === 'number') {
        this.#time = info.currentTime;
        this.#stamp = performance.now();
        this.dispatchEvent(new Event('timeupdate'));
      }
      if (info.duration > 0) this.duration = info.duration;
    }
    if (typeof info.playerState === 'number') this.#setState(info.playerState);
  }

  #setState(next) {
    if (typeof next !== 'number' || next === this.state) return;
    // A late "ended" from the previous video must not skip the one just loaded.
    if (next === State.ENDED && performance.now() - this.#loadedAt < 1500) return;
    if (this.state === State.PLAYING) this.#time = this.currentTime;
    if (next === State.ENDED && this.duration) this.#time = this.duration;
    this.state = next;
    this.#stamp = performance.now();
    this.dispatchEvent(new Event('statechange'));
  }
}
