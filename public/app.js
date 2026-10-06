import { HiddenPlayer, State } from './player.js';
import * as dz from './deezer.js';
import { LyricsView, prefetchLyrics } from './lyrics.js';

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
// Main artist of a credit like "The Weeknd, JENNIE & Lily Rose Depp" or "Calvin Harris feat. Rihanna".
const artistOf = (t) => normKey(String(t?.artist || '').split(/,|&| x | feat\.? | ft\.? | with /i)[0]);

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
  artist: `<circle ${S} cx="12" cy="8" r="4"/><path ${S} d="M4 21a8 8 0 0 1 16 0"/>`,
  album: `<circle ${S} cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.4"/>`,
  chart: `<path ${S} d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>`,
  lyrics: `<rect ${S} x="9" y="2.5" width="6" height="11.5" rx="3"/><path ${S} d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v4M8.5 21.5h7"/>`,
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
  radioPromise: null,
  station: newStation([]),
  sessionSkips: new Map(), // artist -> autoplay songs of theirs skipped early this visit
  shuffle: store.get('shuffle', false),
  repeat: store.get('repeat', 'off'), // 'off' | 'one'
  volume: store.get('volume', 80),
  muted: store.get('muted', false),
  liked: store.get('liked', []),
};
const likedIds = new Set(state.liked.map((t) => t.id));

// What autoplay is built around, like a Spotify radio station: `anchors` are the songs it started
// from (one song, or the list playback started from), `loved` the songs finished or saved since.
function newStation(anchors) {
  return { anchors, loved: [], refills: 0, seeds: {} };
}

// How much you like each artist, learned from autoplay and kept between visits: skipping one of
// their recommended songs early counts against them, finishing one or saving a song counts for them.
const taste = store.get('taste', {});
function nudgeTaste(track, delta) {
  const key = artistOf(track);
  if (!key) return;
  const score = Math.max(-5, Math.min(5, (taste[key] || 0) + delta));
  delete taste[key]; // re-added last, so the oldest opinions are the ones dropped
  if (score) taste[key] = score;
  const keys = Object.keys(taste);
  if (keys.length > 500) delete taste[keys[0]];
  store.set('taste', taste);
}
const dislikes = (t) => (taste[artistOf(t)] || 0) <= -3 || (state.sessionSkips.get(artistOf(t)) || 0) >= 2;

// Videos whose owners don't allow playing them outside YouTube, so autoplay never picks them again.
const unplayable = new Set(store.get('unplayable', []));
function markUnplayable(id) {
  unplayable.add(id);
  store.set('unplayable', [...unplayable].slice(-300));
}

// Recently played was removed; delete the history that older versions saved in the browser.
try {
  localStorage.removeItem('spoti:recent');
} catch {}

// Named track lists that rendered rows point at via data-list / data-id.
const lists = new Map([
  ['liked', { tracks: state.liked, mode: 'context', name: 'Liked Songs' }],
]);

// Tile colors for Deezer's genres, in order.
const GENRE_COLORS = [
  '#e13300', '#bc5900', '#e91429', '#dc148c', '#8d67ab', '#477d95', '#608108', '#1e3264',
  '#0d73ec', '#e1118c', '#27856a', '#503750', '#af2896', '#148a08', '#7358ff', '#ba5d07',
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

// Songs come from Deezer, which only has 30-second previews, so each one plays from its upload on
// YouTube. Our server finds that upload (artist, title and length); matches are remembered here.
const videoIds = new Map(Object.entries(store.get('videos', {})));
const lookups = new Map(); // track id -> pending lookup

function rememberVideo(track, videoId) {
  videoIds.delete(track.id);
  if (videoId) videoIds.set(track.id, videoId);
  while (videoIds.size > 2000) videoIds.delete(videoIds.keys().next().value);
  store.set('videos', Object.fromEntries(videoIds));
}

// A song's YouTube video id, or null if YouTube has nothing that matches. Songs saved before the
// switch to Deezer are YouTube videos already. `exclude` skips videos that failed to play.
function resolveVideo(track, { exclude = [] } = {}) {
  if (!track.dz) return Promise.resolve(track.id);
  if (!exclude.length) {
    if (videoIds.has(track.id)) return Promise.resolve(videoIds.get(track.id));
    if (lookups.has(track.id)) return lookups.get(track.id);
  }
  const lookup = api('/api/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ songs: [{ artist: track.artist, title: track.title, duration: track.duration, exclude }] }),
  })
    .then(({ videos = [] }) => {
      const videoId = videos[0] || null;
      if (videoId) rememberVideo(track, videoId);
      return videoId;
    })
    .finally(() => lookups.delete(track.id));
  if (!exclude.length) lookups.set(track.id, lookup);
  return lookup;
}

// Looks up the next song's video while this one plays, so it starts without a pause.
function prefetchNext() {
  const upcoming = [state.queue[0], state.context.tracks[0], state.autoplay[0]].find(Boolean);
  if (upcoming) resolveVideo(upcoming).catch(() => {});
  // With lyrics open, the next song's are ready the moment it starts.
  if (upcoming && lyrics.isOpen) prefetchLyrics(upcoming);
}

function startTrack(entry, { pushHistory = true } = {}) {
  if (pushHistory && state.current) {
    state.history.push(state.current);
    if (state.history.length > 100) state.history.shift();
  }
  state.current = entry;
  state.played.add(entry.track.id);
  state.playedTitles.add(songKey(entry.track));
  updateNowPlaying();
  renderQueue();
  ensureRadio();
  loadCurrent();
}

// Finds the playing song's video and loads it. Until then the previous song is paused, and if
// YouTube has no match the song is skipped (but not song after song: three misses in a row stop).
let loadSeq = 0;
let missStreak = 0;
async function loadCurrent({ exclude = [], start = 0, autoplay = true } = {}) {
  const entry = state.current;
  const seq = ++loadSeq;
  if (autoplay && entry.track.dz && (exclude.length || !videoIds.has(entry.track.id))) player.pause();
  let videoId = null;
  let failed = false;
  try {
    videoId = await resolveVideo(entry.track, { exclude });
  } catch (err) {
    failed = true;
    console.warn('YouTube lookup failed:', err.message);
  }
  if (seq !== loadSeq || state.current !== entry) return;
  if (!videoId) {
    if (++missStreak >= 3) {
      missStreak = 0;
      return toast(failed ? "Can't reach the server to find songs on YouTube." : "Couldn't find these songs on YouTube.", 6000);
    }
    toast(failed ? `Couldn't load "${entry.track.title}" — skipping` : `"${entry.track.title}" isn't on YouTube — skipping`);
    return next('error');
  }
  missStreak = 0;
  entry.videoId = videoId;
  if (autoplay) player.load(videoId, start);
  else player.cue(videoId, start);
  prefetchNext();
}

// Play a song on its own: autoplay continues with similar songs (Spotify's song radio).
function playFresh(track) {
  state.context = { name: '', tracks: [] };
  resetRadio();
  state.station = newStation([{ ...track }]);
  startTrack({ track: { ...track }, source: 'direct' });
}

// Play a song from a list: the rest of that list follows, then autoplay with songs like the list's.
function playFromList(list, index) {
  const rest = list.tracks.slice(index + 1).map((t) => ({ ...t }));
  state.context = { name: list.name, tracks: state.shuffle ? shuffleInPlace(rest) : rest };
  resetRadio();
  state.station = newStation(shuffleInPlace(list.tracks.map((t) => ({ ...t }))).slice(0, 50));
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
  for (const [list, source] of [
    [state.queue, 'queue'],
    [state.context.tracks, 'context'],
    [state.autoplay, 'autoplay'],
  ]) {
    while (list.length) {
      const track = list.shift();
      if (!unplayable.has(track.id)) return { track, source };
    }
  }
  return null;
}

/* ---------- listening feedback ---------- */

const EARLY_SKIP_SECONDS = 30;

// How the playing song ended: 'skip' (Next, or picking another song in the queue), 'end' (played
// to the end) or 'error'. Like Spotify, only autoplay's own picks teach it anything: an early skip
// leaves just one more song by that artist, at the back of Next up (and one per mix after that),
// and a second one takes them out of the mix for this visit. A song played to the end can become
// the seed of the next recommendations.
function rate(reason) {
  const entry = state.current;
  if (!entry || entry.rated || entry.source !== 'autoplay') return;
  entry.rated = true;
  const { track } = entry;
  if (reason === 'end') {
    nudgeTaste(track, 0.5);
    state.station.loved.push(track);
    return;
  }
  // A song still being looked up on YouTube hasn't started yet.
  const elapsed = entry.videoId ? player.currentTime : 0;
  if (reason !== 'skip' || elapsed >= EARLY_SKIP_SECONDS) return;
  const key = artistOf(track);
  state.sessionSkips.set(key, (state.sessionSkips.get(key) || 0) + 1);
  nudgeTaste(track, -1);
  state.station.loved = state.station.loved.filter((t) => artistOf(t) !== key);
  const others = state.autoplay.filter((t) => artistOf(t) !== key);
  const last = dislikes(track) ? [] : state.autoplay.filter((t) => artistOf(t) === key).slice(0, 1);
  state.autoplay = [...spaceRuns(queuedRuns(others), recentArtists()), ...last];
}

let advancing = false;
async function next(reason = 'skip') {
  rate(reason);
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
  updatePositionState();
}

function jumpTo(section, index) {
  const list = section === 'queue' ? state.queue : section === 'context' ? state.context.tracks : state.autoplay;
  const skipped = list.splice(0, index + 1);
  rate('skip');
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
  state.radioPromise = null;
}

// Songs in a row by the same artist play as one "run", as radio stations do: autoplay can stay
// with an artist for up to three songs on purpose, but never runs into them again by accident.
const MAX_RUN = 3;
// An artist doesn't come back within this many songs of their last one.
const ARTIST_GAP = 3;
let runSeq = 0;

function newRuns(tracks) {
  const runs = [];
  for (const t of tracks) {
    const artist = artistOf(t);
    const last = runs.at(-1);
    if (last && last.artist === artist && last.tracks.length < MAX_RUN) last.tracks.push(t);
    else runs.push({ artist, tracks: [t] });
  }
  for (const run of runs) {
    const id = ++runSeq;
    for (const t of run.tracks) t.run = id;
  }
  return runs;
}

// The runs already lined up in Next up, from the run ids given to their songs when they were added.
function queuedRuns(tracks) {
  const runs = [];
  for (const t of tracks) {
    const last = runs.at(-1);
    if (last && t.run && last.tracks[0].run === t.run) last.tracks.push(t);
    else runs.push({ artist: artistOf(t), tracks: [t] });
  }
  return runs;
}

// Artists of the songs just played, oldest first.
const recentArtists = () =>
  [...state.history.slice(-ARTIST_GAP).map((e) => e.track), state.current?.track].filter(Boolean).map(artistOf);

// Orders runs so no artist returns within ARTIST_GAP songs, keeping the given order wherever it can.
// `keepFirst` lets the first run follow its own artist: a station opening with more songs by the
// artist of the song you chose.
function spaceRuns(runs, recent, { keepFirst = false } = {}) {
  const played = [...recent];
  const pool = [...runs];
  const out = [];
  while (pool.length) {
    const window = played.slice(-ARTIST_GAP);
    let i = keepFirst && !out.length ? 0 : pool.findIndex((r) => !window.includes(r.artist));
    if (i < 0) i = pool.findIndex((r) => r.artist !== played.at(-1));
    if (i < 0) {
      // Only the artist that just played is left: slot their run in earlier, between two other
      // artists, rather than right after themselves (unless every song left is theirs).
      const [run] = pool.splice(0, 1);
      let k = out.length - 1;
      while (k > 0 && (out[k - 1].artist === run.artist || out[k].artist === run.artist)) k--;
      if (k > 0) out.splice(k, 0, run);
      else out.push(run);
      continue;
    }
    const [run] = pool.splice(i, 1);
    out.push(run);
    played.push(...run.tracks.map(() => run.artist));
  }
  return out.flatMap((r) => r.tracks);
}

// Like Spotify's radio, now and then plays a song you saved, when its artist is part of the mix:
// about one in eight songs, on average, however small the batch.
function familiarPicks(batch, taken, keys) {
  const count = Math.floor(batch.length / 8) + (Math.random() < (batch.length % 8) / 8 ? 1 : 0);
  if (!count) return [];
  const artists = new Set(batch.map(artistOf));
  const picks = state.liked.filter(
    (t) =>
      artists.has(artistOf(t)) &&
      !taken.has(t.id) &&
      !state.played.has(t.id) &&
      !unplayable.has(t.id) &&
      !state.sessionSkips.has(artistOf(t)) &&
      !dislikes(t) &&
      !isRepeat(t, keys)
  );
  return shuffleInPlace(picks)
    .slice(0, count)
    .map((t) => ({ ...t }));
}

function appendAutoplay(tracks, gen, { opening = false } = {}) {
  if (gen !== state.radioGen || !tracks?.length) return 0;
  const taken = new Set([
    state.current?.track.id,
    ...state.queue.map((t) => t.id),
    ...state.context.tracks.map((t) => t.id),
    ...state.autoplay.map((t) => t.id),
  ]);
  const keys = new Set([...state.playedTitles, ...state.autoplay.map(songKey)]);
  const allowVariants = VARIANT.test(state.current?.track.rawTitle || '');
  // Artists skipped early once this visit get one song per mix.
  const skippedOnce = new Set();
  const fresh = [];
  for (const t of tracks) {
    // Songs from YouTube Music artist pages may come without a duration, so only long ones are skipped.
    if (!t || t.duration > MAX_SONG_SECONDS) continue;
    if (state.played.has(t.id) || taken.has(t.id) || unplayable.has(t.id) || dislikes(t)) continue;
    if ((!allowVariants && VARIANT.test(t.rawTitle)) || isRepeat(t, keys)) continue;
    if (state.sessionSkips.has(artistOf(t))) {
      if (skippedOnce.has(artistOf(t))) continue;
      skippedOnce.add(artistOf(t));
    }
    keys.add(songKey(t));
    taken.add(t.id);
    fresh.push({ ...t });
  }
  if (!fresh.length) return 0;

  // Shuffle never applies to autoplay: its order is what makes it sound like a radio station.
  const runs = newRuns(fresh);
  for (const t of familiarPicks(fresh, taken, keys)) {
    runs.splice(2 + Math.floor(Math.random() * Math.max(1, runs.length - 1)), 0, ...newRuns([t]));
  }
  const recent = [...recentArtists(), ...state.autoplay.map(artistOf)];
  state.autoplay.push(...spaceRuns(runs, recent, { keepFirst: opening && !state.autoplay.length }));
  return fresh.length;
}

// Each seed song gives a few different mixes (each one reaches a little further) before it's retired.
const MAX_SEED_USES = 3;

// The song the next recommendations are built from. The first mix comes from what's playing. After
// that, like Spotify's radio, it alternates between the station's anchors, so the music stays close
// to where it started, and the songs you finished or saved since, so it follows what you enjoy.
function nextSeed() {
  const st = state.station;
  const cur = state.current?.track;
  const ok = (t) => t && (st.seeds[t.id] || 0) < MAX_SEED_USES && !dislikes(t);
  const anchors = st.anchors.filter(ok);
  const anchor = anchors[Math.floor(Math.random() * anchors.length)];
  const loved = st.loved.filter(ok).at(-1);
  const order = st.refills === 0 ? [cur, anchor, loved] : st.refills % 2 ? [loved, anchor, cur] : [anchor, loved, cur];
  return order.find(ok) || (cur && (st.seeds[cur.id] || 0) < 9 ? cur : null);
}

// Keeps "Next up" stocked with recommendations from Deezer (see dz.radioMix).
function ensureRadio() {
  if (!state.current) return Promise.resolve();
  if (state.radioPromise) return state.radioPromise;
  if (state.autoplay.length >= 4 || state.context.tracks.length > 2) return Promise.resolve();
  const seed = nextSeed();
  if (!seed) return Promise.resolve();

  const gen = state.radioGen;
  const station = state.station;
  const promise = (async () => {
    const uses = station.seeds[seed.id] || 0;
    try {
      station.seeds[seed.id] = uses + 1;
      const first = station.refills++ === 0;
      const tracks = await dz.radioMix(seed, { variant: uses });
      // A station's first mix may open with more songs by the artist you chose, right after them.
      const opening = first && state.current?.track.id === seed.id;
      appendAutoplay(tracks, gen, { opening });
    } catch (err) {
      console.warn('Autoplay lookup failed:', err.message);
      // The seed wasn't really used, so it can be tried again.
      if (gen === state.radioGen) station.seeds[seed.id] = uses;
    } finally {
      if (state.radioPromise === promise) state.radioPromise = null;
      renderQueue();
    }
  })();
  state.radioPromise = promise;
  renderQueue();
  return promise;
}

// Used when the user skips and nothing is lined up yet: wait for the recommendations, and only if
// they fail entirely fall back to other songs by the same artist.
async function fillAutoplay() {
  const seed = state.current.track;
  const gen = state.radioGen;
  await ensureRadio();
  if (!state.autoplay.length && gen === state.radioGen) {
    try {
      appendAutoplay((await dz.search(seed.artist)).tracks, gen);
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
  updatePositionState();
  scheduleTick();
  if (s === State.PAUSED) saveSession();
  if (s === State.ENDED) {
    if (state.repeat === 'one') {
      player.seek(0);
      player.play();
    } else {
      next('end');
    }
  }
});

player.addEventListener('timeupdate', scheduleTick);

// YouTube's error codes for a video that's gone (100) or not allowed in embeds (101, 150).
const UNPLAYABLE_ERRORS = [100, 101, 150];

// How many other uploads of a song are tried when its video won't play outside YouTube.
const MAX_VIDEO_RETRIES = 2;

player.addEventListener('error', (e) => {
  const entry = state.current;
  if (entry && UNPLAYABLE_ERRORS.includes(e.detail)) {
    const tried = [...(entry.badVideos || []), entry.videoId].filter(Boolean);
    if (entry.track.dz && tried.length <= MAX_VIDEO_RETRIES) {
      entry.badVideos = tried;
      rememberVideo(entry.track, null);
      return loadCurrent({ exclude: tried });
    }
    markUnplayable(entry.track.id);
  }
  if (++errorStreak > 5) {
    errorStreak = 0;
    toast('Playback keeps failing. The video player may be blocked on this network.', 6000);
    return;
  }
  toast(`"${state.current?.track.title ?? 'This song'}" can't be played here — skipping`);
  next('error');
});

player.addEventListener('blocked', () => {
  toast("Couldn't load the player. youtube-nocookie.com may be blocked on this network.", 8000);
});

/* ================= library: liked songs ================= */

const isLiked = (id) => likedIds.has(id);

// Saving a song also tells autoplay you like its artist, and can make it a seed for what plays next.
function toggleLike(track) {
  const i = state.liked.findIndex((t) => t.id === track.id);
  if (i >= 0) {
    state.liked.splice(i, 1);
    likedIds.delete(track.id);
    nudgeTaste(track, -2);
    state.station.loved = state.station.loved.filter((t) => t.id !== track.id);
    toast('Removed from Liked Songs');
  } else {
    const { run, ...saved } = track; // `run` is autoplay's bookkeeping, not part of the song
    state.liked.unshift(saved);
    likedIds.add(track.id);
    nudgeTaste(track, 2);
    state.station.loved.push({ ...track });
    toast('Added to Liked Songs');
  }
  store.set('liked', state.liked);
  updateLikes();
  renderLibrary();
  if (document.body.dataset.route === 'liked') renderLiked();
}

/* ================= rendering ================= */

const section = (title, body) => `<section class="section"><h2>${esc(title)}</h2>${body}</section>`;
const empty = (title, text, extra = '') =>
  `<div class="empty"><h2>${title}</h2><p>${text}</p>${extra}</div>`;

const loading = () => `<div style="margin-top:24px">${'<div class="skeleton"></div>'.repeat(8)}</div>`;
const failed = (err) =>
  empty('Something went wrong', esc(err.message), '<button class="pill" data-action="retry">Try again</button>');

// Deezer's genres, loaded once per visit.
let genreList = null;
function loadGenres() {
  genreList ??= dz.genres().catch((err) => {
    genreList = null;
    throw err;
  });
  return genreList;
}

const genreColor = (i) => GENRE_COLORS[i % GENRE_COLORS.length];

const genreGrid = (items) =>
  `<div class="genre-grid">${items
    .map(
      (g, i) =>
        `<a class="genre" style="--c:${genreColor(i)}" href="#/genre/${g.id}">${esc(g.name)}${
          g.picture ? `<img src="${esc(g.picture)}" alt="" loading="lazy">` : ''
        }</a>`
    )
    .join('')}</div>`;

const artistLink = (t) => (t.artistId ? `<a href="#/artist/${t.artistId}">${esc(t.artist)}</a>` : esc(t.artist));

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
        <div class="row-title" title="${esc(t.album ? `${t.title} · ${t.album}` : t.rawTitle)}">${esc(t.title)}</div>
        <div class="row-artist">${artistLink(t)}</div>
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

const RECORD_TYPES = { album: 'Album', single: 'Single', ep: 'EP', compile: 'Compilation' };
const recordType = (type) => RECORD_TYPES[type] || 'Album';

// Album and artist tiles link to their pages, with a button to play them right away.
const albumCard = (a, { byArtist = true } = {}) => `
  <a class="card" href="#/album/${a.id}">
    <div class="card-art">
      <img src="${esc(a.cover.small)}" alt="" loading="lazy">
      <button class="card-play" data-action="play-album" data-id="${a.id}" aria-label="Play ${esc(a.title)}">${icon.play}</button>
    </div>
    <div class="card-title" title="${esc(a.title)}">${esc(a.title)}</div>
    <div class="card-sub">${esc(byArtist ? a.artist : [a.year, recordType(a.type)].filter(Boolean).join(' • '))}</div>
  </a>`;

const artistCard = (a) => `
  <a class="card artist-card" href="#/artist/${a.id}">
    <div class="card-art">
      <img src="${esc(a.picture.small)}" alt="" loading="lazy">
      <button class="card-play" data-action="play-artist" data-id="${a.id}" aria-label="Play ${esc(a.name)}">${icon.play}</button>
    </div>
    <div class="card-title" title="${esc(a.name)}">${esc(a.name)}</div>
    <div class="card-sub">Artist</div>
  </a>`;

const cards = (items, card) => `<div class="cards">${items.map((x) => card(x)).join('')}</div>`;

const playBar = (key, label) => `
  <div class="action-bar">
    <button class="big-play" data-action="play-list" data-target="${key}" aria-label="Play ${esc(label)}">${icon.play}</button>
    <button class="ctrl ${state.shuffle ? 'on' : ''}" data-action="shuffle" aria-label="Shuffle">${icon.shuffle}</button>
  </div>`;

function libraryHTML() {
  const n = state.liked.length;
  return `
    <a class="lib-item" href="#/liked">
      <div class="lib-art liked-art">${icon.heart}</div>
      <div class="lib-meta"><div class="lib-title">Liked Songs</div><div class="lib-sub">Playlist • ${n} song${n === 1 ? '' : 's'}</div></div>
    </a>`;
}

function renderLibrary() {
  $('#library-list').innerHTML = libraryHTML();
  if (document.body.dataset.route === 'library') renderLibraryPage();
  markCurrent();
}

async function renderHome(gen) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  view.innerHTML = `
    <section class="home-hero">
      <h1>${greeting}</h1>
      <div class="quick-grid">
        <a class="quick" href="#/liked"><div class="quick-art liked-art">${icon.heart}</div><span>Liked Songs</span></a>
        <a class="quick" href="#/genre/0"><div class="quick-art charts-art">${icon.chart}</div><span>Top charts</span></a>
      </div>
    </section>
    ${
      state.liked.length
        ? ''
        : `<section class="welcome"><h2>Start listening</h2><p>Search for any song, artist or album. When your queue runs out, similar songs keep playing.</p><a class="pill" href="#/search">Search music</a></section>`
    }
    <div id="home-more">${loading()}</div>`;

  try {
    const [top, genres] = await Promise.all([dz.charts(0), loadGenres()]);
    if (gen !== viewGen) return;
    lists.set('chart', { tracks: top.tracks, mode: 'context', name: 'Top charts' });
    $('#home-more').innerHTML = `
      <section class="section">
        <div class="section-head"><h2>Top songs right now</h2><a class="link-btn" href="#/genre/0">Show all</a></div>
        <div class="tracklist">${rows(top.tracks.slice(0, 5), 'chart')}</div>
      </section>
      ${top.artists.length ? section('Popular artists', cards(top.artists, artistCard)) : ''}
      ${top.albums.length ? section('Popular albums', cards(top.albums, albumCard)) : ''}
      ${section('Browse genres', genreGrid(genres))}`;
    markCurrent();
    updateLikes();
  } catch (err) {
    if (gen === viewGen) $('#home-more').innerHTML = failed(err);
  }
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
        ? `${playBar('liked', 'Liked Songs')}
          <div class="tracklist">${rowsHead()}${rows(state.liked, 'liked')}</div>`
        : empty('Songs you like will appear here', 'Save songs by tapping the heart icon.', '<a class="pill" href="#/search">Find songs</a>')
    }`;
}

function renderLibraryPage() {
  view.innerHTML = `<div class="library-page"><h1>Your Library</h1><div class="library-list">${libraryHTML()}</div></div>`;
}

async function renderArtist(id, gen) {
  view.innerHTML = loading();
  try {
    const { artist, top, albums, related } = await dz.artistPage(id);
    if (gen !== viewGen) return;
    lists.set('artist', { tracks: top, mode: 'context', name: artist.name });
    view.innerHTML = `
      <header class="artist-hero" style="--img:url('${esc(artist.picture.large)}')">
        <div>
          <div class="eyebrow">Artist</div>
          <h1 class="playlist-title">${esc(artist.name)}</h1>
          <div class="playlist-meta">${artist.fans.toLocaleString('en')} fans on Deezer</div>
        </div>
      </header>
      ${top.length ? `${playBar('artist', artist.name)}${section('Popular', `<div class="tracklist">${rows(top, 'artist')}</div>`)}` : ''}
      ${albums.length ? section('Discography', cards(albums, (a) => albumCard(a, { byArtist: false }))) : ''}
      ${related.length ? section('Fans also like', cards(related, artistCard)) : ''}`;
    markCurrent();
    updateLikes();
  } catch (err) {
    if (gen === viewGen) view.innerHTML = failed(err);
  }
}

async function renderAlbum(id, gen) {
  view.innerHTML = loading();
  try {
    const { album, tracks } = await dz.albumPage(id);
    if (gen !== viewGen) return;
    lists.set('album', { tracks, mode: 'context', name: album.title });
    const minutes = Math.round(album.duration / 60);
    const meta = [
      album.artistId ? `<a href="#/artist/${album.artistId}"><b>${esc(album.artist)}</b></a>` : esc(album.artist),
      esc(album.year),
      `${tracks.length} song${tracks.length === 1 ? '' : 's'}${minutes ? `, ${minutes} min` : ''}`,
    ].filter(Boolean);
    view.innerHTML = `
      <header class="playlist-head tinted" style="--c:#535353">
        <img class="playlist-art" src="${esc(album.cover.large)}" alt="">
        <div>
          <div class="eyebrow">${recordType(album.type)}</div>
          <h1 class="playlist-title">${esc(album.title)}</h1>
          <div class="playlist-meta">${meta.join(' • ')}</div>
        </div>
      </header>
      ${playBar('album', album.title)}
      <div class="tracklist">${rowsHead()}${rows(tracks, 'album')}</div>
      ${album.label ? `<p class="hint album-label">${esc(album.label)}</p>` : ''}`;
    markCurrent();
    updateLikes();
  } catch (err) {
    if (gen === viewGen) view.innerHTML = failed(err);
  }
}

// A genre's charts, or the overall charts for genre 0.
async function renderGenre(id, gen) {
  view.innerHTML = loading();
  try {
    const [g, top, genres] = await Promise.all([dz.genre(id), dz.charts(id), loadGenres().catch(() => [])]);
    if (gen !== viewGen) return;
    lists.set('genre', { tracks: top.tracks, mode: 'context', name: g.name });
    const index = genres.findIndex((x) => String(x.id) === String(id));
    view.innerHTML = `
      <header class="playlist-head tinted" style="--c:${index < 0 ? '#1e3264' : genreColor(index)}">
        ${g.picture ? `<img class="playlist-art" src="${esc(g.picture)}" alt="">` : `<div class="playlist-art charts-art">${icon.chart}</div>`}
        <div>
          <div class="eyebrow">${Number(id) ? 'Genre' : 'Chart'}</div>
          <h1 class="playlist-title">${esc(g.name)}</h1>
          <div class="playlist-meta">The most played songs on Deezer right now</div>
        </div>
      </header>
      ${top.tracks.length ? `${playBar('genre', g.name)}<div class="tracklist">${rowsHead()}${rows(top.tracks, 'genre')}</div>` : ''}
      ${top.artists.length ? section('Popular artists', cards(top.artists, artistCard)) : ''}
      ${top.albums.length ? section('Popular albums', cards(top.albums, albumCard)) : ''}`;
    markCurrent();
    updateLikes();
  } catch (err) {
    if (gen === viewGen) view.innerHTML = failed(err);
  }
}

let scrollObserver = null;

const MIN_ARTIST_FANS = 5000;

// The top result is the artist when the search is their name, and otherwise the best song. An
// artist named after a hit (a tribute act called "Blinding Lights") only wins if they're well known.
function topResult(q, artists, topSong) {
  const key = normKey(q);
  const [first] = artists;
  if (!first || key.length < 2) return null;
  const name = normKey(first.name);
  if (name !== key && !(key.length >= 4 && name.includes(key))) return null;
  return !topSong || artistOf(topSong) === artistOf({ artist: first.name }) || first.fans >= 100000 ? first : null;
}

async function renderSearch(q, gen) {
  if (!q) {
    view.innerHTML = loading();
    try {
      const genres = await loadGenres();
      if (gen === viewGen) view.innerHTML = section('Browse all', genreGrid(genres));
    } catch (err) {
      if (gen === viewGen) view.innerHTML = failed(err);
    }
    return;
  }
  view.innerHTML = loading();
  try {
    const res = await dz.search(q);
    if (gen !== viewGen) return;
    const { tracks, artists, albums } = res;
    lists.set('search', { tracks, mode: 'radio', name: q });
    if (!tracks.length && !artists.length && !albums.length) {
      view.innerHTML = empty(`No results found for "${esc(q)}"`, 'Check the spelling, or try different keywords.');
      return;
    }
    const top = tracks[0];
    const artist = topResult(q, artists, top);
    const topCard = artist
      ? `<a class="top-card" href="#/artist/${artist.id}">
          <img class="round" src="${esc(artist.picture.small)}" alt="">
          <div class="top-title">${esc(artist.name)}</div>
          <div class="top-sub"><span class="chip">Artist</span></div>
          <button class="card-play" data-action="play-artist" data-id="${artist.id}" aria-label="Play ${esc(artist.name)}">${icon.play}</button>
        </a>`
      : top
        ? `<div class="top-card" data-list="search" data-id="${esc(top.id)}">
            <img src="${esc(top.thumbnail.small)}" alt="">
            <div class="top-title" title="${esc(top.title)}">${esc(top.title)}</div>
            <div class="top-sub"><span class="chip">Song</span><span class="row-artist">${artistLink(top)}</span></div>
            <button class="card-play pp" data-act="play" aria-label="Play ${esc(top.title)}">${icon.play}${icon.pause}</button>
          </div>`
        : '';
    // Deezer's artist search also returns karaoke and tribute accounts, with few fans and no photo.
    const otherArtists = artists.filter((a) => a !== artist && a.fans >= MIN_ARTIST_FANS && a.hasPicture).slice(0, 6);
    view.innerHTML = `
      <div class="search-top">
        ${topCard ? `<section><h2>Top result</h2>${topCard}</section>` : ''}
        ${tracks.length ? `<section><h2>Songs</h2><div class="tracklist">${rows(tracks.slice(0, 4), 'search')}</div></section>` : ''}
      </div>
      ${otherArtists.length ? section('Artists', cards(otherArtists, artistCard)) : ''}
      ${albums.length ? section('Albums', cards(albums, albumCard)) : ''}
      <section class="section" id="more-section" ${tracks.length > 4 ? '' : 'hidden'}>
        <h2>More songs</h2>
        <div class="tracklist" id="more-results">${rows(tracks.slice(4), 'search', 4)}</div>
      </section>
      <div class="sentinel" id="sentinel"></div>`;
    markCurrent();
    updateLikes();
    setupInfiniteScroll(q, res.next, gen);
  } catch (err) {
    if (gen === viewGen) view.innerHTML = failed(err);
  }
}

function setupInfiniteScroll(q, nextIndex, gen) {
  scrollObserver?.disconnect();
  if (nextIndex == null) return;
  const sentinel = $('#sentinel');
  let index = nextIndex;
  let busy = false;

  scrollObserver = new IntersectionObserver(
    async ([entry]) => {
      if (!entry.isIntersecting || busy || index == null || gen !== viewGen) return;
      busy = true;
      sentinel.classList.add('loading');
      try {
        const res = await dz.searchMore(q, index);
        if (gen !== viewGen) return;
        const list = lists.get('search');
        const known = new Set(list.tracks.map((t) => t.id));
        const fresh = res.tracks.filter((t) => !known.has(t.id));
        const offset = list.tracks.length;
        list.tracks.push(...fresh);
        $('#more-section').hidden = false;
        $('#more-results').insertAdjacentHTML('beforeend', rows(fresh, 'search', offset));
        markCurrent();
        updateLikes();
        index = fresh.length ? res.next : null;
      } catch {
        index = null;
      } finally {
        busy = false;
        sentinel.classList.remove('loading');
        if (index == null) scrollObserver?.disconnect();
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
  // Every change to what's playing or lined up comes through here, so it's saved from here too.
  persistSession();
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
    html += `<h3>Next up · Autoplay</h3><p class="hint">Similar artists, mixed like a radio station. Skip a song early and you'll hear less of that artist.</p>`;
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

/* ---------- lyrics ---------- */

const lyrics = new LyricsView($('#lyrics'), {
  time: () => (state.current?.videoId ? player.currentTime : 0),
  duration: () => (state.current?.videoId ? player.duration : 0),
  videoId: () => state.current?.videoId,
  seek: (seconds) => {
    player.seek(seconds);
    player.play();
    updatePositionState();
    scheduleTick();
  },
});

function toggleLyrics(force) {
  const open = force ?? !lyrics.isOpen;
  if (open === lyrics.isOpen) return;
  document.body.classList.toggle('lyrics-open', open);
  $('#lyrics').hidden = !open;
  $$('[data-action="lyrics"]').forEach((b) => b.classList.toggle('on', open));
  lyrics.setOpen(open);
  if (open) prefetchNext();
}

function updateNowPlaying() {
  const t = state.current?.track;
  document.body.classList.toggle('has-track', !!t);
  $$('[data-np="title"]').forEach((el) => (el.textContent = t?.title ?? ''));
  $$('[data-np="artist"]').forEach((el) => (el.textContent = t?.artist ?? ''));
  $$('[data-np="art"]').forEach((el) => {
    if (t) el.src = el.dataset.size === 'hq' ? t.thumbnail.large : t.thumbnail.small;
    else el.removeAttribute('src');
    // Album art is square; video thumbnails are zoomed past their letterbox bars.
    el.classList.toggle('square', !!t?.thumbnail.square);
  });
  // The background is blurred beyond recognition anyway, so the small image does: it's far cheaper to blur.
  $('#fullplayer').style.setProperty('--art', t ? `url("${t.thumbnail.small}")` : 'none');
  document.title = t ? `${t.title} • ${t.artist}` : 'Spoti - Web Player';
  updateLikes();
  markCurrent();
  updateMediaSession(t);
  lyrics.setTrack(t);
  scheduleTick();
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
        artwork: [
          {
            src: new URL(t.thumbnail.large, location.href).href,
            sizes: t.thumbnail.square ? '544x544' : '480x360',
            type: 'image/jpeg',
          },
        ],
      })
    : null;
  updatePositionState();
}

// Lets the lock screen and notification controls show the song's progress and seek within it.
function updatePositionState() {
  if (!navigator.mediaSession?.setPositionState) return;
  const duration = currentDuration();
  try {
    if (!state.current || !duration) navigator.mediaSession.setPositionState();
    else navigator.mediaSession.setPositionState({ duration, position: Math.min(player.currentTime, duration), playbackRate: 1 });
  } catch {}
}

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => player.play(),
    pause: () => player.pause(),
    previoustrack: prev,
    nexttrack: () => next(),
    seekbackward: () => seekBy(-10),
    seekforward: () => seekBy(10),
    seekto: (d) => {
      player.seek(d.seekTime);
      updatePositionState();
    },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {}
  }
}

/* ================= sliders: seek + volume ================= */

function setSlider(el, p) {
  const value = String(Math.round(p * 10000) / 10000);
  if (el.dataset.value === value) return;
  el.style.setProperty('--p', value);
  el.dataset.value = value;
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
      scheduleTick();
    },
    onCommit: (p) => {
      seekPreview = null;
      if (state.current && currentDuration()) player.seek(p * currentDuration());
      updatePositionState();
      scheduleTick();
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
let lastMini = '';
function paintProgress() {
  const dur = currentDuration();
  const cur = seekPreview ?? (state.current ? Math.min(player.currentTime, dur || Infinity) : 0);
  const p = dur ? clamp01(cur / dur) : 0;
  for (const el of progressEls) if (!el.classList.contains('dragging')) setSlider(el, p);
  const mini = String(Math.round(p * 10000) / 10000);
  if (mini !== lastMini) miniProgress.style.setProperty('--p', (lastMini = mini));
  const c = fmt(cur);
  const d = fmt(dur);
  if (c !== lastCur) timeCurEls.forEach((el) => (el.textContent = lastCur = c));
  if (d !== lastDur) {
    timeDurEls.forEach((el) => (el.textContent = lastDur = d));
    updatePositionState();
  }
}

// Progress is repainted about four times a second, and only while a song plays or a seek is being
// dragged: a 3-minute song moves the bar well under a pixel between paints.
const PAINT_INTERVAL = 250;
let ticking = false;
let lastPaint = 0;

function scheduleTick() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(tick);
}

function tick(now) {
  ticking = false;
  const live = player.state === State.PLAYING || seekPreview != null;
  if (!live || seekPreview != null || now - lastPaint >= PAINT_INTERVAL) {
    paintProgress();
    lastPaint = now;
  }
  if (live) scheduleTick();
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
    ${ref.track.artistId ? `<button data-menu="artist" role="menuitem">${icon.artist}Go to artist</button>` : ''}
    ${ref.track.albumId ? `<button data-menu="album" role="menuitem">${icon.album}Go to album</button>` : ''}
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
    case 'artist':
      location.hash = `#/artist/${ref.track.artistId}`;
      return;
    case 'album':
      location.hash = `#/album/${ref.track.albumId}`;
      return;
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
      // Like Spotify, shuffle reorders the list you're playing, never autoplay's radio-style mix.
      if (state.shuffle) shuffleInPlace(state.context.tracks);
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
    case 'lyrics':
      return toggleLyrics();
    case 'close-lyrics':
      return toggleLyrics(false);
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
    case 'play-list':
      return playWhole(lists.get(el.dataset.target));
    case 'play-album':
      return playFetched(async () => {
        const { album, tracks } = await dz.albumPage(el.dataset.id);
        return { tracks, name: album.title };
      });
    case 'play-artist':
      return playFetched(async () => {
        const { artist, top } = await dz.artistPage(el.dataset.id);
        return { tracks: top, name: artist.name };
      });
    case 'go-artist': {
      // On phones the mini player opens the full player instead.
      if (isMobile() && $('#fullplayer').hidden) return handleAction('open-full');
      const id = state.current?.track.artistId;
      if (!id) return;
      $('#fullplayer').hidden = true;
      location.hash = `#/artist/${id}`;
      return;
    }
  }
}

// Plays a whole list from the top (or from a random song with shuffle on).
function playWhole(list) {
  if (!list?.tracks.length) return;
  playFromList(list, state.shuffle ? Math.floor(Math.random() * list.tracks.length) : 0);
}

// Plays an album or artist straight from its tile, without opening its page.
async function playFetched(load) {
  try {
    playWhole(await load());
  } catch (err) {
    toast(`Couldn't load it: ${err.message}`);
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
  if (actionEl) {
    // A play button on an album or artist tile mustn't also open the page the tile links to.
    if (actionEl.closest('a[href]')) e.preventDefault();
    return handleAction(actionEl.dataset.action, actionEl);
  }

  // Links (an artist's name in a row, say) only navigate, away from the lyrics too.
  if (e.target.closest('a[href]')) return toggleLyrics(false);

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
  if (e.target.closest('button, a')) return;
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
    // One layer at a time: the lyrics first, then the full player and queue.
    if (lyrics.isOpen) return toggleLyrics(false);
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
    case 'l':
    case 'L':
      return toggleLyrics();
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

// As you type, the box lists a couple of matching artists and a few songs, like Spotify's. Picking
// an artist opens their page and picking a song plays it; Enter searches for what's typed.
function showSuggestions({ artists, tracks }) {
  suggestItems = [
    ...artists.map((artist) => ({ artist })),
    ...tracks.map((track) => ({ track })),
  ];
  suggestIndex = -1;
  if (!suggestItems.length) return hideSuggestions();
  suggestionsEl.innerHTML = suggestItems
    .map(({ artist, track }, i) =>
      artist
        ? `<li role="option" data-sug="${i}"><img class="sug-art round" src="${esc(artist.picture.small)}" alt=""><div class="sug-text"><div class="sug-title">${esc(artist.name)}</div><div class="sug-sub">Artist</div></div></li>`
        : `<li role="option" data-sug="${i}"><img class="sug-art" src="${esc(track.thumbnail.small)}" alt=""><div class="sug-text"><div class="sug-title">${esc(track.title)}</div><div class="sug-sub">Song • ${esc(track.artist)}</div></div></li>`
    )
    .join('');
  suggestionsEl.hidden = false;
}

function pickSuggestion(i) {
  const item = suggestItems[i];
  if (!item) return;
  clearTimeout(suggestTimer);
  hideSuggestions();
  if (isMobile()) searchInput.blur();
  if (item.artist) location.hash = `#/artist/${item.artist.id}`;
  else playFresh(item.track);
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
      const results = await dz.instant(q);
      if (req === suggestReq && document.activeElement === searchInput) showSuggestions(results);
    } catch {}
  }, 250);
});

searchInput.addEventListener('keydown', (e) => {
  if (suggestionsEl.hidden || !suggestItems.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = suggestItems.length;
    suggestIndex = e.key === 'ArrowDown' ? (suggestIndex + 1) % n : (suggestIndex - 1 + n) % n;
    $$('li', suggestionsEl).forEach((li, i) => li.classList.toggle('active', i === suggestIndex));
  } else if (e.key === 'Enter' && suggestIndex >= 0) {
    e.preventDefault();
    pickSuggestion(suggestIndex);
  }
});

searchInput.addEventListener('blur', () => setTimeout(hideSuggestions, 120));

suggestionsEl.addEventListener('mousedown', (e) => {
  const li = e.target.closest('[data-sug]');
  if (!li) return;
  e.preventDefault();
  pickSuggestion(Number(li.dataset.sug));
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
  // Deezer pages: #/artist/ID, #/album/ID and #/genre/ID (genre 0 is the overall charts).
  const page = path.match(/^\/(artist|album|genre)\/(\d+)$/);
  const name = page?.[1] || { '/search': 'search', '/liked': 'liked', '/library': 'library' }[path] || 'home';
  const gen = ++viewGen;

  document.body.dataset.route = name;
  $$('[data-route-link]').forEach((a) => a.classList.toggle('active', a.dataset.routeLink === name));
  scrollObserver?.disconnect();
  hideSuggestions();
  closeMenu();
  toggleLyrics(false);
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
    else if (name === 'artist') renderArtist(page[2], gen);
    else if (name === 'album') renderAlbum(page[2], gen);
    else if (name === 'genre') renderGenre(page[2], gen);
    else renderHome(gen);
  }
  markCurrent();
  updateLikes();
}

window.addEventListener('hashchange', route);

/* ================= saved session ================= */

// What's playing and lined up is saved in the browser, so a reload carries on where you left off.
let persistTimer;
function persistSession() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(saveSession, 1000);
}

function saveSession() {
  clearTimeout(persistTimer);
  if (!state.current) return store.set('session', null);
  const st = state.station;
  store.set('session', {
    current: { track: state.current.track, source: state.current.source },
    // A song still being looked up on YouTube hasn't started yet.
    position: state.current.videoId ? player.currentTime : 0,
    queue: state.queue,
    context: { name: state.context.name, tracks: state.context.tracks.slice(0, 500) },
    autoplay: state.autoplay.slice(0, 100),
    station: { ...st, anchors: st.anchors.slice(0, 50), loved: st.loved.slice(-20) },
    // So autoplay doesn't repeat what this session already played.
    played: [...state.played].slice(-300),
    playedTitles: [...state.playedTitles].slice(-300),
  });
}

// Restores the saved session paused, at the position it was left at.
function restoreSession() {
  const saved = store.get('session', null);
  if (!saved?.current?.track?.id) return;
  state.current = saved.current;
  state.queue.push(...(saved.queue || []));
  if (saved.context?.tracks) state.context = saved.context;
  state.autoplay.push(...(saved.autoplay || []));
  state.station = { ...newStation([]), ...saved.station };
  for (const id of saved.played || []) state.played.add(id);
  for (const key of saved.playedTitles || []) state.playedTitles.add(key);
  runSeq = Math.max(runSeq, ...state.autoplay.map((t) => t.run || 0));
  loadCurrent({ start: saved.position || 0, autoplay: false });
}

window.addEventListener('pagehide', saveSession);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession();
});

/* ================= boot ================= */

restoreSession();
renderLibrary();
route();
applyVolume();
updateModes();
updateNowPlaying();
ensureRadio();
