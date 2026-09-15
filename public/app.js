import { HiddenPlayer, State } from './player.js';

/* ================= helpers ================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const clamp01 = (n) => Math.min(1, Math.max(0, n));

function fmt(total) {
  const t = Math.max(0, Math.floor(total || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Covers, karaoke, remixes, live recordings… skipped by autoplay unless you're already playing one.
const VARIANT =
  /\b(cover|karaoke|instrumental|reaction|remix|slowed|sped[ -]?up|reverb|8d|nightcore|tutorial|lesson|chords|mashup|live (at|from|in|on)|live performance)\b/i;
const normKey = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
const stripExtras = (s) =>
  String(s || '')
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+(ft\.?|feat\.?|featuring)\s.*$/i, '')
    .trim();
// "Song (Acoustic) ft. X" and "Song" share a key, so another version of a song counts as a repeat.
const songKey = (t) => normKey(stripExtras(t.title));

function isRepeat(track, keys) {
  const key = songKey(track);
  const raw = normKey(track.rawTitle);
  for (const k of keys) {
    if (k && (k === key || (k.length >= 6 && raw.includes(k)))) return true;
  }
  return false;
}

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`spoti:${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`spoti:${key}`, JSON.stringify(value));
    } catch {}
  },
};

async function api(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body.error || `Request failed (${res.status})`;
    throw new Error(body.detail ? `${message}: ${body.detail}` : message);
  }
  return body;
}

/* ================= icons ================= */

const S = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const SPEAKER = '<path d="M3 9.5h3.5L11 5.5v13l-4.5-4H3z"/>';
const NEXT = '<path d="M5 5.2v13.6a1 1 0 0 0 1.55.83l10-6.8a1 1 0 0 0 0-1.66l-10-6.8A1 1 0 0 0 5 5.2z"/><rect x="17" y="4" width="2.4" height="16" rx="1.2"/>';
const ICONS = {
  logo: '<circle cx="12" cy="12" r="11" fill="#1ed760"/><rect x="6.5" y="9" width="2.4" height="6" rx="1.2" fill="#000"/><rect x="10.8" y="6.5" width="2.4" height="11" rx="1.2" fill="#000"/><rect x="15.1" y="8" width="2.4" height="8" rx="1.2" fill="#000"/>',
  play: '<path d="M7 4.9v14.2a1 1 0 0 0 1.52.85l11.3-7.1a1 1 0 0 0 0-1.7L8.52 4.05A1 1 0 0 0 7 4.9z"/>',
  pause: '<rect x="6" y="4" width="4.2" height="16" rx="1.2"/><rect x="13.8" y="4" width="4.2" height="16" rx="1.2"/>',
  next: NEXT,
  prev: `<g transform="matrix(-1 0 0 1 24 0)">${NEXT}</g>`,
  shuffle: `<path ${S} d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>`,
  repeat: `<path ${S} d="M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3"/>`,
  heart: `<path ${S} d="M12 20.3s-7.6-4.5-9.4-9.1C1.4 7.9 3.5 4.3 7.1 4.3c2.1 0 3.6 1.1 4.9 2.9 1.3-1.8 2.8-2.9 4.9-2.9 3.6 0 5.7 3.6 4.5 6.9-1.8 4.6-9.4 9.1-9.4 9.1z"/>`,
  queue: `<path ${S} d="M3 6h13M3 11h13M3 16h8"/><path d="M15 13.5v7l5.5-3.5z"/>`,
  addQueue: `<path ${S} d="M3 6h13M3 11h13M3 16h7M18 13v8M14 17h8"/>`,
  volHigh: `${SPEAKER}<path ${S} d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/>`,
  volLow: `${SPEAKER}<path ${S} d="M15 9a4 4 0 0 1 0 6"/>`,
  volMute: `${SPEAKER}<path ${S} d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>`,
  home: `<path ${S} d="M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5.5v-6.5h-5V21H4a1 1 0 0 1-1-1z"/>`,
  search: `<circle ${S} cx="10.5" cy="10.5" r="6.5"/><path ${S} d="M20 20l-4.8-4.8"/>`,
  library: `<path ${S} d="M4 3.5v17M9.5 3.5v17M14.5 4.2l5.5 16"/>`,
  dots: '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>',
  close: `<path ${S} d="M6 6l12 12M18 6 6 18"/>`,
  chevLeft: `<path ${S} d="M15 5l-7 7 7 7"/>`,
  chevRight: `<path ${S} d="M9 5l7 7-7 7"/>`,
  chevDown: `<path ${S} d="M5 9l7 7 7-7"/>`,
  radio: `<circle cx="12" cy="12" r="2.2"/><path ${S} d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2"/>`,
  clock: `<circle ${S} cx="12" cy="12" r="9"/><path ${S} d="M12 7v5l3 2"/>`,
  playNext: `<path ${S} d="M4 12h12M12 6l6 6-6 6"/>`,
};
const icon = Object.fromEntries(
  Object.entries(ICONS).map(([name, body]) => [
    name,
    `<svg class="ic ic-${name}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`,
  ])
);

/* ================= state ================= */

const MAX_SONG_SECONDS = 15 * 60;

const state = {
  current: null, // { track, source: 'direct' | 'queue' | 'context' | 'autoplay' }
  queue: [], // songs the user explicitly queued — always played first
  context: { name: '', tracks: [] }, // rest of the list playback started from (e.g. Liked Songs)
  autoplay: [], // recommendations once the queue and context run out
  history: [],
  played: new Set(),
  playedTitles: new Set(),
  radioGen: 0,
  radioSeeds: new Set(),
  radioPromise: null,
  pending: [], // recommended songs (artist + title) not yet matched to a YouTube video
  shuffle: store.get('shuffle', false),
  repeat: store.get('repeat', 'off'), // 'off' | 'one'
  volume: store.get('volume', 80),
  muted: store.get('muted', false),
  liked: store.get('liked', []),
  recent: store.get('recent', []),
};

// Named track lists that rendered rows point at via data-list / data-id.
const lists = new Map([
  ['liked', { tracks: state.liked, mode: 'context', name: 'Liked Songs' }],
  // A song started from Recently played continues with related music, not the rest of the list.
  ['recent', { tracks: state.recent, mode: 'radio', name: 'Recently played' }],
]);

const GENRES = [
  { name: 'Pop', q: 'pop hits', color: '#e13300' },
  { name: 'Hip-Hop', q: 'hip hop hits', color: '#bc5900' },
  { name: 'Rock', q: 'rock classics', color: '#e91429' },
  { name: 'R&B', q: 'r&b songs', color: '#dc148c' },
  { name: 'K-Pop', q: 'kpop hits', color: '#8d67ab' },
  { name: 'Chill', q: 'chill songs', color: '#477d95' },
  { name: 'Dance / EDM', q: 'edm hits', color: '#608108' },
  { name: 'Indie', q: 'indie songs', color: '#1e3264' },
  { name: 'Jazz', q: 'jazz classics', color: '#0d73ec' },
  { name: 'Latin', q: 'latin hits', color: '#e1118c' },
  { name: 'Acoustic', q: 'acoustic songs', color: '#27856a' },
  { name: 'Lo-fi', q: 'lofi songs', color: '#503750' },
];

/* ================= elements ================= */

$$('[data-icon]').forEach((el) =>
  el.insertAdjacentHTML('afterbegin', el.dataset.icon.split(' ').map((n) => icon[n]).join(''))
);

const player = new HiddenPlayer($('#yt-host'));
const main = $('#main');
const view = $('#view');
const menu = $('#menu');
const searchInput = $('#search-input');
const suggestionsEl = $('#suggestions');
const progressEls = $$('[data-progress]');
const volumeEls = $$('[data-volume]');
const timeCurEls = $$('[data-time="cur"]');
const timeDurEls = $$('[data-time="dur"]');
const miniProgress = $('#mini-progress');
const isMobile = () => matchMedia('(max-width: 768px)').matches;
const noHover = matchMedia('(hover: none)');

/* ================= playback ================= */

function startTrack(entry, { pushHistory = true } = {}) {
  if (pushHistory && state.current) {
    state.history.push(state.current);
    if (state.history.length > 100) state.history.shift();
  }
  state.current = entry;
  state.played.add(entry.track.id);
  state.playedTitles.add(songKey(entry.track));
  addRecent(entry.track);
  player.load(entry.track.id);
  updateNowPlaying();
  renderQueue();
  ensureRadio();
}

// Play a song on its own: autoplay continues with similar songs (Spotify's song radio).
function playFresh(track) {
  state.context = { name: '', tracks: [] };
  resetRadio();
  startTrack({ track: { ...track }, source: 'direct' });
}

// Play a song from a list: the rest of that list follows, then autoplay.
function playFromList(list, index) {
  const rest = list.tracks.slice(index + 1).map((t) => ({ ...t }));
  state.context = { name: list.name, tracks: state.shuffle ? shuffleInPlace(rest) : rest };
  resetRadio();
  startTrack({ track: { ...list.tracks[index] }, source: 'direct' });
}

function playRef({ list, index, track }) {
  if (state.current?.track.id === track.id) return togglePlay();
  if (list.mode === 'context') playFromList(list, index);
  else playFresh(track);
}

function togglePlay() {
  if (!state.current) {
    if (state.queue.length) next();
    return;
  }
  if (player.isPlaying) player.pause();
  else player.play();
}

function takeNext() {
  if (state.queue.length) return { track: state.queue.shift(), source: 'queue' };
  if (state.context.tracks.length) return { track: state.context.tracks.shift(), source: 'context' };
  if (state.autoplay.length) return { track: state.autoplay.shift(), source: 'autoplay' };
  return null;
}

let advancing = false;
async function next() {
  const entry = takeNext();
  if (entry) return startTrack(entry);
  if (!state.current) return;
  if (advancing) return toast('Finding similar songs…');

  // Nothing lined up yet: fetch recommendations, then continue.
  advancing = true;
  const from = state.current;
  const slow = setTimeout(() => toast('Finding similar songs…'), 400);
  try {
    await fillAutoplay();
    if (state.current !== from) return;
    const later = takeNext();
    if (later) startTrack(later);
    else toast("Couldn't find more songs to play");
  } finally {
    clearTimeout(slow);
    advancing = false;
  }
}

function prev() {
  if (!state.current) return;
  if (player.currentTime > 3 || !state.history.length) {
    player.seek(0);
    player.play();
    return;
  }
  const { track, source } = state.current;
  const list = source === 'queue' ? state.queue : source === 'context' ? state.context.tracks : state.autoplay;
  list.unshift(track);
  startTrack(state.history.pop(), { pushHistory: false });
}

function seekBy(delta) {
  if (!state.current) return;
  const dur = player.duration || state.current.track.duration;
  player.seek(Math.min(Math.max(0, player.currentTime + delta), Math.max(0, dur - 0.5)));
}

function jumpTo(section, index) {
  const list = section === 'queue' ? state.queue : section === 'context' ? state.context.tracks : state.autoplay;
  const skipped = list.splice(0, index + 1);
  startTrack({ track: skipped.pop(), source: section });
}

function addToQueue(track, { playNext = false } = {}) {
  if (playNext) state.queue.unshift({ ...track });
  else state.queue.push({ ...track });
  if (!state.current) return next();
  toast(playNext ? 'Playing next' : 'Added to queue');
  renderQueue();
}

/* ---------- autoplay / radio ---------- */

function resetRadio() {
  state.radioGen++;
  state.autoplay.length = 0;
  state.pending.length = 0;
  state.radioSeeds.clear();
  state.radioPromise = null;
}

function appendAutoplay(tracks, gen) {
  if (gen !== state.radioGen || !tracks?.length) return 0;
  const taken = new Set([
    state.current?.track.id,
    ...state.queue.map((t) => t.id),
    ...state.context.tracks.map((t) => t.id),
    ...state.autoplay.map((t) => t.id),
  ]);
  const keys = new Set([...state.playedTitles, ...state.autoplay.map(songKey)]);
  const allowVariants = VARIANT.test(state.current?.track.rawTitle || '');
  const fresh = [];
  for (const t of tracks) {
    // Songs from YouTube Music artist pages may come without a duration, so only long ones are skipped.
    if (t.duration > MAX_SONG_SECONDS) continue;
    if (state.played.has(t.id) || taken.has(t.id)) continue;
    if ((!allowVariants && VARIANT.test(t.rawTitle)) || isRepeat(t, keys)) continue;
    keys.add(songKey(t));
    fresh.push(t);
  }
  state.autoplay.push(...(state.shuffle ? shuffleInPlace(fresh) : fresh));
  return fresh.length;
}

// Deezer's public API, called from the browser with JSONP (it sends no CORS headers). It runs here
// rather than on the server because Deezer, like YouTube, blocks requests from cloud servers.
let deezerSeq = 0;
function deezer(path) {
  return new Promise((resolve, reject) => {
    const callback = `__deezer${++deezerSeq}`;
    const script = document.createElement('script');
    const finish = (err, data) => {
      clearTimeout(timer);
      window[callback] = () => {}; // a response arriving after the timeout must not throw
      script.remove();
      if (err) reject(err);
      else if (data?.error) reject(new Error(`Deezer: ${data.error.message || data.error.type}`));
      else resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('Deezer timed out')), 8000);
    window[callback] = (data) => finish(null, data);
    script.onerror = () => finish(new Error('Deezer is unreachable'));
    script.src = `https://api.deezer.com${path}${path.includes('?') ? '&' : '?'}output=jsonp&callback=${callback}`;
    document.head.append(script);
  });
}

async function deezerTrackFor(track) {
  const artist = stripExtras(track.artist);
  const title = stripExtras(track.title);
  const artistKey = normKey(artist);
  for (const q of new Set([`${artist} ${title}`.trim(), title])) {
    if (!q) continue;
    const { data = [] } = await deezer(`/search?limit=10&q=${encodeURIComponent(q)}`);
    const sameArtist = data.find((d) => {
      const a = normKey(d.artist?.name);
      return artistKey && a && (a.includes(artistKey) || artistKey.includes(a));
    });
    if (sameArtist || data[0]) return sameArtist || data[0];
  }
  return null;
}

// Deezer's artist radio: songs by the artist and by similar artists — the same idea as Spotify's radio.
async function loadDeezerRadio(seed, gen) {
  const found = await deezerTrackFor(seed);
  if (!found?.artist?.id) throw new Error('song not found on Deezer');
  const { data = [] } = await deezer(`/artist/${found.artist.id}/radio?limit=40`);
  if (gen !== state.radioGen) return;
  const keys = new Set([
    songKey(seed),
    songKey({ title: found.title_short || found.title }),
    ...state.playedTitles,
    ...state.autoplay.map(songKey),
    ...state.pending.map(songKey),
  ]);
  for (const d of data) {
    const song = { artist: d.artist?.name || '', title: d.title_short || d.title || '', duration: d.duration || 0 };
    const key = songKey(song);
    if (!song.artist || !key || keys.has(key)) continue;
    keys.add(key);
    state.pending.push(song);
  }
  if (state.shuffle) shuffleInPlace(state.pending);
}

// Matches the next few recommended songs to their YouTube uploads (via our server's YouTube search).
async function matchPending(gen) {
  const songs = state.pending.splice(0, 6);
  const { tracks = [] } = await api('/api/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ songs }),
  });
  return appendAutoplay(tracks.filter(Boolean), gen);
}

// Keeps "Next up" stocked. Recommendations come from YouTube Music's song radio (through our
// server). Only if YouTube Music isn't reachable from the server is Deezer's artist radio used,
// and as a last resort the server's YouTube lookup. When recommendations run out, a new radio
// starts from whatever is playing then, so the music drifts naturally like Spotify's.
function ensureRadio() {
  const seed = state.current?.track;
  if (!seed) return Promise.resolve();
  if (state.radioPromise) return state.radioPromise;
  if (state.autoplay.length >= 4 || state.context.tracks.length > 2) return Promise.resolve();
  if (!state.pending.length && state.radioSeeds.has(seed.id)) return Promise.resolve();

  const gen = state.radioGen;
  const promise = (async () => {
    try {
      if (!state.pending.length) {
        state.radioSeeds.add(seed.id);
        const params = new URLSearchParams({ id: seed.id, artist: seed.artist, title: seed.title });
        let added = 0;
        try {
          added = appendAutoplay((await api(`/api/ytmusic/radio?${params}`)).tracks, gen);
        } catch (err) {
          console.warn('YouTube Music radio unavailable, trying Deezer:', err.message);
        }
        if (!added && gen === state.radioGen) {
          try {
            await loadDeezerRadio(seed, gen);
          } catch (err) {
            console.warn('Deezer radio unavailable, using server lookup:', err.message);
            appendAutoplay((await api(`/api/radio?${params}`)).tracks, gen);
          }
        }
      }
      while (gen === state.radioGen && state.autoplay.length < 4 && state.pending.length) {
        await matchPending(gen);
        renderQueue();
      }
    } catch (err) {
      console.warn('Autoplay lookup failed:', err.message);
      if (gen === state.radioGen) state.radioSeeds.delete(seed.id);
    } finally {
      if (state.radioPromise === promise) state.radioPromise = null;
      renderQueue();
    }
  })();
  state.radioPromise = promise;
  renderQueue();
  return promise;
}

// Used when the user skips and nothing is lined up yet: wait for the related-songs lookup, and
// only if it fails entirely fall back to other songs by the same artist.
async function fillAutoplay() {
  const seed = state.current.track;
  const gen = state.radioGen;
  await ensureRadio();
  if (!state.autoplay.length && gen === state.radioGen) {
    try {
      const res = await api(`/api/search?q=${encodeURIComponent(seed.artist)}`);
      appendAutoplay(res.tracks, gen);
    } catch {}
  }
  renderQueue();
}

/* ---------- player events ---------- */

let errorStreak = 0;

player.addEventListener('statechange', () => {
  const s = player.state;
  document.body.classList.toggle('is-playing', player.isPlaying);
  if (s === State.PLAYING) errorStreak = 0;
  if ('mediaSession' in navigator && (s === State.PLAYING || s === State.PAUSED)) {
    navigator.mediaSession.playbackState = s === State.PLAYING ? 'playing' : 'paused';
  }
  if (s === State.ENDED) {
    if (state.repeat === 'one') {
      player.seek(0);
      player.play();
    } else {
      next();
    }
  }
});

player.addEventListener('error', () => {
  if (++errorStreak > 5) {
    errorStreak = 0;
    toast('Playback keeps failing. The video player may be blocked on this network.', 6000);
    return;
  }
  toast(`"${state.current?.track.title ?? 'This song'}" can't be played here — skipping`);
  next();
});

player.addEventListener('blocked', () => {
  toast("Couldn't load the player. youtube-nocookie.com may be blocked on this network.", 8000);
});

/* ================= library: liked + recent ================= */

const isLiked = (id) => state.liked.some((t) => t.id === id);

function toggleLike(track) {
  const i = state.liked.findIndex((t) => t.id === track.id);
  if (i >= 0) {
    state.liked.splice(i, 1);
    toast('Removed from Liked Songs');
  } else {
    state.liked.unshift({ ...track });
    toast('Added to Liked Songs');
  }
  store.set('liked', state.liked);
  updateLikes();
  renderLibrary();
  if (document.body.dataset.route === 'liked') renderLiked();
}

function addRecent(track) {
  const i = state.recent.findIndex((t) => t.id === track.id);
  if (i >= 0) state.recent.splice(i, 1);
  state.recent.unshift({ ...track });
  if (state.recent.length > 30) state.recent.length = 30;
  store.set('recent', state.recent);
  renderLibrary();
}

/* ================= rendering ================= */

const section = (title, body) => `<section class="section"><h2>${esc(title)}</h2>${body}</section>`;
const empty = (title, text, extra = '') =>
  `<div class="empty"><h2>${title}</h2><p>${text}</p>${extra}</div>`;

const genreGrid = () =>
  `<div class="genre-grid">${GENRES.map(
    (g) => `<a class="genre" style="--c:${g.color}" href="#/search?q=${encodeURIComponent(g.q)}">${esc(g.name)}</a>`
  ).join('')}</div>`;

function rows(tracks, key, offset = 0) {
  return tracks
    .map(
      (t, i) => `
    <div class="row" data-list="${key}" data-id="${esc(t.id)}" tabindex="0">
      <div class="row-num">
        <span class="n">${offset + i + 1}</span>
        <span class="eq"><i></i><i></i><i></i></span>
        <button class="row-play pp" data-act="play" aria-label="Play ${esc(t.title)}">${icon.play}${icon.pause}</button>
      </div>
      <img class="row-art" src="${esc(t.thumbnail.small)}" alt="" loading="lazy">
      <div class="row-main">
        <div class="row-title" title="${esc(t.rawTitle)}">${esc(t.title)}</div>
        <div class="row-artist">${esc(t.artist)}</div>
      </div>
      <button class="icon-btn like-btn row-like" data-act="like" data-like="${esc(t.id)}" aria-label="Save to Liked Songs">${icon.heart}</button>
      <button class="icon-btn row-add" data-act="queue" aria-label="Add to queue" title="Add to queue">${icon.addQueue}</button>
      <div class="row-dur">${esc(t.durationText)}</div>
      <button class="icon-btn row-more" data-act="menu" aria-label="More options">${icon.dots}</button>
    </div>`
    )
    .join('');
}

const rowsHead = () =>
  `<div class="row row-head"><div class="row-num">#</div><div></div><div>Title</div><div></div><div></div>${icon.clock}<div></div></div>`;

function cards(tracks, key) {
  return `<div class="cards">${tracks
    .map(
      (t) => `
    <div class="card" data-list="${key}" data-id="${esc(t.id)}">
      <div class="card-art">
        <img src="${esc(t.thumbnail.small)}" alt="" loading="lazy">
        <button class="card-play pp" data-act="play" aria-label="Play ${esc(t.title)}">${icon.play}${icon.pause}</button>
      </div>
      <div class="card-title" title="${esc(t.rawTitle)}">${esc(t.title)}</div>
      <div class="card-sub">${esc(t.artist)}</div>
    </div>`
    )
    .join('')}</div>`;
}

function libraryHTML() {
  const n = state.liked.length;
  const recent = state.recent
    .map(
      (t) => `
    <div class="lib-item" data-list="recent" data-id="${esc(t.id)}" title="${esc(t.rawTitle)}">
      <img class="lib-art" src="${esc(t.thumbnail.small)}" alt="" loading="lazy">
      <div class="lib-meta"><div class="lib-title">${esc(t.title)}</div><div class="lib-sub">Song • ${esc(t.artist)}</div></div>
    </div>`
    )
    .join('');
  return `
    <a class="lib-item" href="#/liked">
      <div class="lib-art liked-art">${icon.heart}</div>
      <div class="lib-meta"><div class="lib-title">Liked Songs</div><div class="lib-sub">Playlist • ${n} song${n === 1 ? '' : 's'}</div></div>
    </a>
    ${recent ? `<div class="lib-label">Recently played</div>${recent}` : '<p class="lib-empty">Songs you play will show up here.</p>'}`;
}

function renderLibrary() {
  $('#library-list').innerHTML = libraryHTML();
  if (document.body.dataset.route === 'library') renderLibraryPage();
  markCurrent();
}

function renderHome() {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const quick = state.recent
    .slice(0, 7)
    .map(
      (t) => `
    <div class="quick" data-list="recent" data-id="${esc(t.id)}" title="${esc(t.rawTitle)}">
      <img src="${esc(t.thumbnail.small)}" alt="" loading="lazy"><span>${esc(t.title)}</span>
      <button class="mini-play pp" data-act="play" aria-label="Play ${esc(t.title)}">${icon.play}${icon.pause}</button>
    </div>`
    )
    .join('');

  view.innerHTML = `
    <section class="home-hero">
      <h1>${greeting}</h1>
      <div class="quick-grid">
        <a class="quick" href="#/liked"><div class="quick-art liked-art">${icon.heart}</div><span>Liked Songs</span></a>
        ${quick}
      </div>
    </section>
    ${
      state.recent.length
        ? section('Recently played', cards(state.recent.slice(0, 12), 'recent'))
        : `<section class="welcome"><h2>Start listening</h2><p>Search for any song or artist. When your queue runs out, similar songs keep playing.</p><a class="pill" href="#/search">Search music</a></section>`
    }
    ${section('Browse genres', genreGrid())}`;
}

function renderLiked() {
  const n = state.liked.length;
  view.innerHTML = `
    <header class="playlist-head">
      <div class="playlist-art liked-art">${icon.heart}</div>
      <div>
        <div class="eyebrow">Playlist</div>
        <h1 class="playlist-title">Liked Songs</h1>
        <div class="playlist-meta">${n} song${n === 1 ? '' : 's'}</div>
      </div>
    </header>
    ${
      n
        ? `<div class="action-bar">
            <button class="big-play" data-action="play-list" data-target="liked" aria-label="Play Liked Songs">${icon.play}</button>
            <button class="ctrl ${state.shuffle ? 'on' : ''}" data-action="shuffle" aria-label="Shuffle">${icon.shuffle}</button>
          </div>
          <div class="tracklist">${rowsHead()}${rows(state.liked, 'liked')}</div>`
        : empty('Songs you like will appear here', 'Save songs by tapping the heart icon.', '<a class="pill" href="#/search">Find songs</a>')
    }`;
}

function renderLibraryPage() {
  view.innerHTML = `<div class="library-page"><h1>Your Library</h1><div class="library-list">${libraryHTML()}</div></div>`;
}

let scrollObserver = null;

async function renderSearch(q, gen) {
  if (!q) {
    view.innerHTML = section('Browse all', genreGrid());
    return;
  }
  view.innerHTML = `<div style="margin-top:24px">${'<div class="skeleton"></div>'.repeat(8)}</div>`;
  try {
    const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (gen !== viewGen) return;
    const tracks = res.tracks || [];
    lists.set('search', { tracks, mode: 'radio', name: q });
    if (!tracks.length) {
      view.innerHTML = empty(`No results found for "${esc(q)}"`, 'Check the spelling, or try different keywords.');
      return;
    }
    const [top] = tracks;
    view.innerHTML = `
      <div class="search-top">
        <section>
          <h2>Top result</h2>
          <div class="top-card" data-list="search" data-id="${esc(top.id)}">
            <img src="${esc(top.thumbnail.small)}" alt="">
            <div class="top-title" title="${esc(top.rawTitle)}">${esc(top.title)}</div>
            <div class="top-sub"><span class="chip">Song</span><span class="row-artist">${esc(top.artist)}</span></div>
            <button class="card-play pp" data-act="play" aria-label="Play ${esc(top.title)}">${icon.play}${icon.pause}</button>
          </div>
        </section>
        <section>
          <h2>Songs</h2>
          <div class="tracklist">${rows(tracks.slice(0, 4), 'search')}</div>
        </section>
      </div>
      <section class="section" id="more-section" ${tracks.length > 4 ? '' : 'hidden'}>
        <h2>More results</h2>
        <div class="tracklist" id="more-results">${rows(tracks.slice(4), 'search', 4)}</div>
      </section>
      <div class="sentinel" id="sentinel"></div>`;
    markCurrent();
    updateLikes();
    setupInfiniteScroll(q, res.continuation, gen);
  } catch (err) {
    if (gen !== viewGen) return;
    view.innerHTML = empty(
      'Something went wrong',
      esc(err.message),
      '<button class="pill" data-action="retry">Try again</button>'
    );
  }
}

function setupInfiniteScroll(q, continuation, gen) {
  scrollObserver?.disconnect();
  if (!continuation) return;
  const sentinel = $('#sentinel');
  let token = continuation;
  let loading = false;

  scrollObserver = new IntersectionObserver(
    async ([entry]) => {
      if (!entry.isIntersecting || loading || !token || gen !== viewGen) return;
      loading = true;
      sentinel.classList.add('loading');
      try {
        const res = await api(`/api/search?q=${encodeURIComponent(q)}&continuation=${encodeURIComponent(token)}`);
        if (gen !== viewGen) return;
        const list = lists.get('search');
        const known = new Set(list.tracks.map((t) => t.id));
        const fresh = (res.tracks || []).filter((t) => !known.has(t.id));
        const offset = list.tracks.length;
        list.tracks.push(...fresh);
        $('#more-section').hidden = false;
        $('#more-results').insertAdjacentHTML('beforeend', rows(fresh, 'search', offset));
        markCurrent();
        updateLikes();
        token = fresh.length ? res.continuation : null;
      } catch {
        token = null;
      } finally {
        loading = false;
        sentinel.classList.remove('loading');
        if (!token) scrollObserver?.disconnect();
        else if (gen === viewGen) {
          // Re-observe so a sentinel that's still on screen triggers the next page.
          scrollObserver.unobserve(sentinel);
          scrollObserver.observe(sentinel);
        }
      }
    },
    { root: main, rootMargin: '600px' }
  );
  scrollObserver.observe(sentinel);
}

function renderQueue() {
  if (!document.body.classList.contains('queue-open')) return;
  const item = (t, sectionName, i) => `
    <div class="q-item ${sectionName === 'current' ? 'is-now' : ''}" ${sectionName === 'current' ? '' : `data-q="${sectionName}" data-i="${i}"`} title="${esc(t.rawTitle)}">
      <img src="${esc(t.thumbnail.small)}" alt="" loading="lazy">
      <div class="q-meta"><div class="q-title">${esc(t.title)}</div><div class="q-artist">${esc(t.artist)}</div></div>
      ${
        sectionName === 'queue'
          ? `<button class="icon-btn q-remove" data-qremove="${i}" aria-label="Remove from queue">${icon.close}</button>`
          : `<span class="q-dur">${esc(t.durationText)}</span>`
      }
    </div>`;

  const cur = state.current?.track;
  let html = `<h3>Now playing</h3>${cur ? item(cur, 'current') : '<p class="hint">Nothing playing yet.</p>'}`;
  if (state.queue.length) {
    html += `<div class="q-section-head"><h3>Next in queue</h3><button class="link-btn" data-action="clear-queue">Clear queue</button></div>`;
    html += state.queue.map((t, i) => item(t, 'queue', i)).join('');
  }
  if (state.context.tracks.length) {
    html += `<h3>Next from: ${esc(state.context.name)}</h3>`;
    html += state.context.tracks.slice(0, 50).map((t, i) => item(t, 'context', i)).join('');
  }
  if (cur) {
    html += `<h3>Next up · Autoplay</h3><p class="hint">Songs by this artist and similar artists.</p>`;
    html += state.autoplay.length
      ? state.autoplay.slice(0, 50).map((t, i) => item(t, 'autoplay', i)).join('')
      : `<p class="hint">${state.radioPromise ? 'Finding similar songs…' : 'Recommendations will appear here.'}</p>`;
  }
  $('#queue-body').innerHTML = html;
}

function toggleQueue(force) {
  const open = force ?? !document.body.classList.contains('queue-open');
  document.body.classList.toggle('queue-open', open);
  $('#queue-panel').hidden = !open;
  $$('[data-action="queue"]').forEach((b) => b.classList.toggle('on', open));
  if (open) renderQueue();
}

function updateNowPlaying() {
  const t = state.current?.track;
  document.body.classList.toggle('has-track', !!t);
  $$('[data-np="title"]').forEach((el) => (el.textContent = t?.title ?? ''));
  $$('[data-np="artist"]').forEach((el) => (el.textContent = t?.artist ?? ''));
  $$('[data-np="art"]').forEach((el) => {
    if (t) el.src = el.dataset.size === 'hq' ? t.thumbnail.large : t.thumbnail.small;
    else el.removeAttribute('src');
  });
  $('#fullplayer').style.setProperty('--art', t ? `url("${t.thumbnail.large}")` : 'none');
  document.title = t ? `${t.title} • ${t.artist}` : 'Spoti - Web Player';
  updateLikes();
  markCurrent();
  updateMediaSession(t);
}

function markCurrent() {
  $$('.is-current').forEach((el) => el.classList.remove('is-current'));
  const id = state.current?.track.id;
  if (id) $$(`[data-id="${CSS.escape(id)}"]`).forEach((el) => el.classList.add('is-current'));
}

function updateLikes() {
  $$('[data-like]').forEach((el) => el.classList.toggle('on', isLiked(el.dataset.like)));
  const liked = !!state.current && isLiked(state.current.track.id);
  $$('[data-action="like-current"]').forEach((el) => {
    el.classList.toggle('on', liked);
    el.setAttribute('aria-label', liked ? 'Remove from Liked Songs' : 'Save to Liked Songs');
  });
}

function updateModes() {
  $$('[data-action="shuffle"]').forEach((b) => b.classList.toggle('on', state.shuffle));
  $$('[data-action="repeat"]').forEach((b) => {
    b.classList.toggle('on', state.repeat === 'one');
    b.classList.toggle('repeat-one', state.repeat === 'one');
  });
}

function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = t
    ? new MediaMetadata({
        title: t.title,
        artist: t.artist,
        artwork: [{ src: new URL(t.thumbnail.large, location.href).href, sizes: '480x360', type: 'image/jpeg' }],
      })
    : null;
}

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => player.play(),
    pause: () => player.pause(),
    previoustrack: prev,
    nexttrack: () => next(),
    seekbackward: () => seekBy(-10),
    seekforward: () => seekBy(10),
    seekto: (d) => player.seek(d.seekTime),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {}
  }
}

/* ================= sliders: seek + volume ================= */

function setSlider(el, p) {
  el.style.setProperty('--p', p);
  el.dataset.value = p;
  const now = String(Math.round(p * 100));
  if (el.getAttribute('aria-valuenow') !== now) el.setAttribute('aria-valuenow', now);
}

function makeSlider(el, { onInput, onCommit, step }) {
  let dragging = false;
  const ratio = (e) => {
    const r = el.getBoundingClientRect();
    return clamp01((e.clientX - r.left) / r.width);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const p = ratio(e);
    setSlider(el, p);
    onInput?.(p);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const p = ratio(e);
    setSlider(el, p);
    onInput?.(p);
  });
  el.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    const p = ratio(e);
    setSlider(el, p);
    onCommit(p);
  });
  el.addEventListener('pointercancel', () => {
    dragging = false;
    el.classList.remove('dragging');
    onCommit(Number(el.dataset.value || 0));
  });
  el.addEventListener('keydown', (e) => {
    const s = typeof step === 'function' ? step() : step;
    const cur = Number(el.dataset.value || 0);
    let p;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') p = cur + s;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') p = cur - s;
    else if (e.key === 'Home') p = 0;
    else if (e.key === 'End') p = 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    p = clamp01(p);
    setSlider(el, p);
    onCommit(p);
  });
}

let seekPreview = null;
const currentDuration = () => player.duration || state.current?.track.duration || 0;

progressEls.forEach((el) =>
  makeSlider(el, {
    step: () => (currentDuration() ? 5 / currentDuration() : 0),
    onInput: (p) => {
      if (state.current) seekPreview = p * currentDuration();
    },
    onCommit: (p) => {
      seekPreview = null;
      if (state.current && currentDuration()) player.seek(p * currentDuration());
    },
  })
);

function applyVolume() {
  const silent = state.muted || state.volume === 0;
  player.setVolume(state.volume);
  player.setMuted(silent);
  document.body.dataset.vol = silent ? 'mute' : state.volume < 50 ? 'low' : 'high';
  volumeEls.forEach((el) => {
    if (!el.classList.contains('dragging')) setSlider(el, silent ? 0 : state.volume / 100);
  });
  store.set('volume', state.volume);
  store.set('muted', state.muted);
}

function toggleMute() {
  if (state.muted || state.volume === 0) {
    state.muted = false;
    if (state.volume === 0) state.volume = 50;
  } else {
    state.muted = true;
  }
  applyVolume();
}

volumeEls.forEach((el) => {
  const set = (p) => {
    state.volume = Math.round(p * 100);
    state.muted = false;
    applyVolume();
  };
  makeSlider(el, { step: 0.05, onInput: set, onCommit: set });
});

let lastCur = '';
let lastDur = '';
function tick() {
  const dur = currentDuration();
  const cur = seekPreview ?? (state.current ? Math.min(player.currentTime, dur || Infinity) : 0);
  const p = dur ? clamp01(cur / dur) : 0;
  for (const el of progressEls) if (!el.classList.contains('dragging')) setSlider(el, p);
  miniProgress.style.setProperty('--p', p);
  const c = fmt(cur);
  const d = fmt(dur);
  if (c !== lastCur) timeCurEls.forEach((el) => (el.textContent = lastCur = c));
  if (d !== lastDur) timeDurEls.forEach((el) => (el.textContent = lastDur = d));
  requestAnimationFrame(tick);
}

/* ================= menu + toast ================= */

let menuRef = null;

function openMenu(ref, x, y) {
  menuRef = ref;
  const liked = isLiked(ref.track.id);
  menu.innerHTML = `
    <button data-menu="play" role="menuitem">${icon.play}Play</button>
    <button data-menu="next" role="menuitem">${icon.playNext}Play next</button>
    <button data-menu="queue" role="menuitem">${icon.addQueue}Add to queue</button>
    <button data-menu="radio" role="menuitem">${icon.radio}Go to song radio</button>
    <button data-menu="like" role="menuitem">${icon.heart}${liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}</button>`;
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`;
}

function closeMenu() {
  menu.hidden = true;
  menuRef = null;
}

function menuAction(action) {
  const ref = menuRef;
  closeMenu();
  if (!ref) return;
  switch (action) {
    case 'play':
      return playRef(ref);
    case 'next':
      return addToQueue(ref.track, { playNext: true });
    case 'queue':
      return addToQueue(ref.track);
    case 'radio':
      playFresh(ref.track);
      return toast(`Song radio: ${ref.track.title}`);
    case 'like':
      return toggleLike(ref.track);
  }
}

let toastTimer;
function toast(message, ms = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

/* ================= interaction ================= */

function trackRef(target) {
  const host = target.closest('[data-list][data-id]');
  if (!host) return null;
  const list = lists.get(host.dataset.list);
  const index = list ? list.tracks.findIndex((t) => t.id === host.dataset.id) : -1;
  return index < 0 ? null : { list, index, track: list.tracks[index] };
}

function handleAction(name, el) {
  switch (name) {
    case 'toggle':
      return togglePlay();
    case 'next':
      return next();
    case 'prev':
      return prev();
    case 'shuffle':
      state.shuffle = !state.shuffle;
      if (state.shuffle) {
        shuffleInPlace(state.context.tracks);
        shuffleInPlace(state.autoplay);
      }
      store.set('shuffle', state.shuffle);
      updateModes();
      renderQueue();
      return toast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
    case 'repeat':
      state.repeat = state.repeat === 'one' ? 'off' : 'one';
      store.set('repeat', state.repeat);
      updateModes();
      return toast(state.repeat === 'one' ? 'Repeating this song' : 'Repeat off');
    case 'like-current':
      return state.current && toggleLike(state.current.track);
    case 'queue':
      return toggleQueue();
    case 'close-queue':
      return toggleQueue(false);
    case 'clear-queue':
      state.queue.length = 0;
      return renderQueue();
    case 'mute':
      return toggleMute();
    case 'open-full':
      if (isMobile() && state.current) $('#fullplayer').hidden = false;
      return;
    case 'close-full':
      $('#fullplayer').hidden = true;
      return;
    case 'back':
      return history.back();
    case 'forward':
      return history.forward();
    case 'retry':
      return route();
    case 'play-list': {
      const list = lists.get(el.dataset.target);
      if (!list?.tracks.length) return;
      const index = state.shuffle ? Math.floor(Math.random() * list.tracks.length) : 0;
      return playFromList(list, index);
    }
  }
}

document.addEventListener('click', (e) => {
  const menuItem = e.target.closest('[data-menu]');
  if (menuItem) return menuAction(menuItem.dataset.menu);
  if (!menu.hidden) closeMenu();

  const remove = e.target.closest('[data-qremove]');
  if (remove) {
    state.queue.splice(Number(remove.dataset.qremove), 1);
    return renderQueue();
  }

  const actionEl = e.target.closest('[data-action]');
  if (actionEl) return handleAction(actionEl.dataset.action, actionEl);

  const ref = trackRef(e.target);
  const actEl = e.target.closest('[data-act]');
  if (ref && actEl) {
    e.preventDefault();
    switch (actEl.dataset.act) {
      case 'play':
        return playRef(ref);
      case 'like':
        return toggleLike(ref.track);
      case 'queue':
        return addToQueue(ref.track);
      case 'menu': {
        const r = actEl.getBoundingClientRect();
        return openMenu(ref, r.right - 230, r.bottom + 4);
      }
    }
  }

  const qItem = e.target.closest('[data-q]');
  if (qItem) {
    jumpTo(qItem.dataset.q, Number(qItem.dataset.i));
    if (isMobile()) toggleQueue(false);
    return;
  }

  // Cards play on click; track rows play on double-click (or a single tap on touch screens).
  if (ref && (noHover.matches || !e.target.closest('.row'))) playRef(ref);
});

document.addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return;
  const ref = e.target.closest('.row') && trackRef(e.target);
  if (ref) playRef(ref);
});

document.addEventListener('contextmenu', (e) => {
  const ref = trackRef(e.target);
  if (!ref) return;
  e.preventDefault();
  openMenu(ref, e.clientX, e.clientY);
});

main.addEventListener('scroll', () => !menu.hidden && closeMenu(), { passive: true });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenu();
    hideSuggestions();
    $('#fullplayer').hidden = true;
    if (isMobile()) toggleQueue(false);
    return;
  }
  if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
  if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || e.key === '/') {
    e.preventDefault();
    return focusSearch();
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Enter' && e.target.matches('.row')) {
    const ref = trackRef(e.target);
    if (ref) playRef(ref);
    return;
  }
  switch (e.key) {
    case ' ':
      e.preventDefault();
      return togglePlay();
    case 'ArrowRight':
      return seekBy(5);
    case 'ArrowLeft':
      return seekBy(-5);
    case 'm':
    case 'M':
      return toggleMute();
  }
});

/* ---------- search box + suggestions ---------- */

let suggestTimer;
let suggestReq = 0;
let suggestItems = [];
let suggestIndex = -1;

function focusSearch() {
  if (document.body.dataset.route !== 'search') location.hash = '#/search';
  requestAnimationFrame(() => searchInput.focus());
}

function hideSuggestions() {
  suggestionsEl.hidden = true;
  suggestItems = [];
  suggestIndex = -1;
  suggestReq++;
}

function showSuggestions(items) {
  suggestItems = items;
  suggestIndex = -1;
  if (!items.length) return hideSuggestions();
  suggestionsEl.innerHTML = items
    .map((s, i) => `<li role="option" data-sug="${i}">${icon.search}<span>${esc(s)}</span></li>`)
    .join('');
  suggestionsEl.hidden = false;
}

function submitSearch(q) {
  q = q.trim();
  if (!q) return;
  searchInput.value = q;
  clearTimeout(suggestTimer);
  hideSuggestions();
  if (isMobile()) searchInput.blur();
  const target = `#/search?q=${encodeURIComponent(q)}`;
  if (location.hash === target) route();
  else location.hash = target;
}

searchInput.addEventListener('input', () => {
  $('#search-clear').hidden = !searchInput.value;
  clearTimeout(suggestTimer);
  const q = searchInput.value.trim();
  if (!q) return hideSuggestions();
  suggestTimer = setTimeout(async () => {
    const req = ++suggestReq;
    try {
      const { suggestions } = await api(`/api/suggest?q=${encodeURIComponent(q)}`);
      if (req === suggestReq && document.activeElement === searchInput) showSuggestions(suggestions || []);
    } catch {}
  }, 180);
});

searchInput.addEventListener('keydown', (e) => {
  if (suggestionsEl.hidden || !suggestItems.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = suggestItems.length;
    suggestIndex = e.key === 'ArrowDown' ? (suggestIndex + 1) % n : (suggestIndex - 1 + n) % n;
    $$('li', suggestionsEl).forEach((li, i) => li.classList.toggle('active', i === suggestIndex));
    searchInput.value = suggestItems[suggestIndex];
  }
});

searchInput.addEventListener('blur', () => setTimeout(hideSuggestions, 120));

suggestionsEl.addEventListener('mousedown', (e) => {
  const li = e.target.closest('[data-sug]');
  if (!li) return;
  e.preventDefault();
  submitSearch(suggestItems[Number(li.dataset.sug)]);
});

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitSearch(searchInput.value);
});

$('#search-clear').addEventListener('click', () => {
  searchInput.value = '';
  $('#search-clear').hidden = true;
  hideSuggestions();
  searchInput.focus();
});

/* ================= router ================= */

let viewGen = 0;

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = hash.split('?');
  const name = { '/search': 'search', '/liked': 'liked', '/library': 'library' }[path] || 'home';
  const gen = ++viewGen;

  document.body.dataset.route = name;
  $$('[data-route-link]').forEach((a) => a.classList.toggle('active', a.dataset.routeLink === name));
  scrollObserver?.disconnect();
  hideSuggestions();
  closeMenu();
  main.scrollTop = 0;

  if (name === 'search') {
    const q = new URLSearchParams(qs).get('q') || '';
    if (document.activeElement !== searchInput) searchInput.value = q;
    $('#search-clear').hidden = !searchInput.value;
    renderSearch(q, gen);
    if (!q && !isMobile()) searchInput.focus();
  } else {
    searchInput.value = '';
    $('#search-clear').hidden = true;
    if (name === 'liked') renderLiked();
    else if (name === 'library') renderLibraryPage();
    else renderHome();
  }
  markCurrent();
  updateLikes();
}

window.addEventListener('hashchange', route);

/* ================= boot ================= */

renderLibrary();
route();
applyVolume();
updateModes();
updateNowPlaying();
requestAnimationFrame(tick);
