import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function clientConfig(host, clientName, clientId, clientVersion, { userAgent = USER_AGENT, app = false, client = {} } = {}) {
  return {
    url: `https://${host}/youtubei/v1`,
    client: { clientName, clientVersion, hl: 'en', gl: 'US', ...client },
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
      'Accept-Language': 'en-US,en;q=0.9',
      'X-YouTube-Client-Name': clientId,
      'X-YouTube-Client-Version': clientVersion,
      // Browser-only headers; phone apps don't send these. The cookie skips the EU consent page.
      ...(app ? {} : { Origin: `https://${host}`, Referer: `https://${host}/`, Cookie: 'CONSENT=YES+1; SOCS=CAI' }),
    },
  };
}

const CLIENTS = {
  web: clientConfig('www.youtube.com', 'WEB', '1', '2.20250910.00.00'),
  music: clientConfig('music.youtube.com', 'WEB_REMIX', '67', '1.20250910.01.00'),
  // YouTube Music's phone apps, which use Google's API host. Google often blocks per client,
  // so /api/debug/related tests whether these get through where the website client doesn't.
  musicAndroid: clientConfig('youtubei.googleapis.com', 'ANDROID_MUSIC', '21', '7.27.52', {
    app: true,
    userAgent: 'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14) gzip',
    client: { androidSdkVersion: 34, osName: 'Android', osVersion: '14', platform: 'MOBILE' },
  }),
  musicIos: clientConfig('youtubei.googleapis.com', 'IOS_MUSIC', '26', '7.27.0', {
    app: true,
    userAgent: 'com.google.ios.youtubemusic/7.27.0 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
    client: { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '17.5.1.21F90', platform: 'MOBILE' },
  }),
};

// Reusing the visitor id YouTube hands out makes follow-up requests look like one browser session.
let visitorData = null;

// Search filter: type = video
const VIDEO_FILTER = 'EgIQAQ%3D%3D';

/* ---------------- tiny TTL cache ---------------- */
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 500;

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = fn().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { value, expires: Date.now() + CACHE_TTL });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

async function innertube(endpoint, body, { kind = 'web', timeout = 12000, fresh = false } = {}) {
  const { url, client, headers } = CLIENTS[kind];
  for (let attempt = 0; ; attempt++) {
    // `fresh` sends the request without the reused visitor id, like a first-time visitor.
    const visitor = fresh ? null : visitorData;
    const res = await fetch(`${url}/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers: visitor ? { ...headers, 'X-Goog-Visitor-Id': visitor } : headers,
      body: JSON.stringify({ context: { client: visitor ? { ...client, visitorData: visitor } : client }, ...body }),
      signal: AbortSignal.timeout(timeout),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.responseContext?.visitorData) visitorData = data.responseContext.visitorData;
      return data;
    }
    visitorData = null;
    // A stale visitor id can make YouTube reject a request: retry once without it.
    if (visitor && attempt === 0) continue;
    const raw = await res.text().catch(() => '');
    let reason = raw.slice(0, 160);
    try {
      reason = JSON.parse(raw).error?.message || reason;
    } catch {
      // HTML error pages, like Google's "Sorry..." bot check, are reduced to their title.
      const title = raw.match(/<title>([^<]*)<\/title>/i)?.[1];
      if (title) reason = /^sorry/i.test(title) ? 'blocked by Google bot check' : title;
    }
    throw new Error(`${kind} ${endpoint} HTTP ${res.status}${reason ? `: ${reason}` : ''}`);
  }
}

/* ---------------- parsing helpers ---------------- */

// Walks the (frequently changing) response tree and collects every object under `key`.
function collect(node, key, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, key, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      else collect(v, key, out);
    }
  }
  return out;
}

// Like collect(), but parses several keys at once and keeps their order in the document.
function collectMany(node, parsers, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectMany(item, parsers, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (Object.hasOwn(parsers, k)) out.push(parsers[k](v));
      else collectMany(v, parsers, out);
    }
  }
  return out;
}

const text = (t) => (t ? t.simpleText ?? (t.runs || []).map((r) => r.text).join('') : '');

function parseDuration(str) {
  if (!str) return 0;
  return str
    .split(':')
    .map(Number)
    .reduce((acc, n) => acc * 60 + (Number.isFinite(n) ? n : 0), 0);
}

// Thumbnails are proxied through this server so clients never hit i.ytimg.com directly.
function thumb(videoId) {
  return {
    small: `/api/thumb/${videoId}`,
    large: `/api/thumb/${videoId}?size=hq`,
  };
}

const NOISE =
  /\s*[([](official\s*)?(music\s*)?(video|audio|lyric(s)?|lyric video|visuali[sz]er|mv|hd|hq|4k|remastered( \d{4})?|explicit|clean|audio only|official)[^)\]]*[)\]]/gi;

function cleanChannel(name) {
  return name
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s*Official$/i, '')
    .trim();
}

// Turns "Artist - Song (Official Video)" into { title: "Song", artist: "Artist" }.
function prettify(rawTitle, channel) {
  let title = rawTitle.replace(NOISE, '').replace(/\s*\|\s*.*$/, '').trim();
  let artist = cleanChannel(channel);
  const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) {
    artist = m[1].trim();
    title = m[2].trim();
  }
  return { title: title || rawTitle, artist: artist || channel };
}

function toTrack({ videoId, rawTitle, channel, durationText }) {
  const { title, artist } = prettify(rawTitle, channel);
  return {
    id: videoId,
    title,
    artist,
    rawTitle,
    channel,
    duration: parseDuration(durationText),
    durationText: durationText || '',
    thumbnail: thumb(videoId),
  };
}

function fromVideoRenderer(v) {
  if (!v?.videoId) return null;
  // Skip live streams (no duration) — they don't behave like songs.
  const durationText = text(v.lengthText);
  if (!durationText) return null;
  return toTrack({
    videoId: v.videoId,
    rawTitle: text(v.title),
    channel: text(v.ownerText || v.longBylineText || v.shortBylineText),
    durationText,
  });
}

function fromPlaylistPanel(v) {
  if (!v?.videoId) return null;
  const durationText = text(v.lengthText);
  if (!durationText) return null;
  return toTrack({
    videoId: v.videoId,
    rawTitle: text(v.title),
    channel: text(v.shortBylineText || v.longBylineText),
    durationText,
  });
}

// Newer YouTube layouts render related videos as lockupViewModel instead of compactVideoRenderer.
function fromLockup(v) {
  if (!v?.contentId || (v.contentType && v.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO')) return null;
  const meta = v.metadata?.lockupMetadataViewModel;
  const rawTitle = meta?.title?.content;
  const channel = collect(meta?.metadata, 'metadataParts')[0]?.[0]?.text?.content || '';
  const durationText = collect(v.contentImage, 'thumbnailBadgeViewModel')
    .map((b) => b.text)
    .find((t) => /^\d+(:\d{2})+$/.test(t || ''));
  if (!rawTitle || !durationText) return null;
  return toTrack({ videoId: v.contentId, rawTitle, channel, durationText });
}

function dedupe(tracks) {
  const seen = new Set();
  return tracks.filter((t) => t && !seen.has(t.id) && seen.add(t.id));
}

/* ---------------- YouTube operations ---------------- */

async function search(query, continuation) {
  const data = continuation
    ? await innertube('search', { continuation })
    : await innertube('search', { query, params: decodeURIComponent(VIDEO_FILTER) });

  const tracks = dedupe(collect(data, 'videoRenderer').map(fromVideoRenderer));
  const tokens = collect(data, 'continuationCommand').map((c) => c.token).filter(Boolean);
  return { tracks, continuation: tokens.at(-1) || null };
}

// The regular watch page embeds the same data as the `next` API (related videos + the Mix) in its
// HTML. It's a different kind of request, so it can still work when the API call is refused.
async function watchPage(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}&hl=en&gl=US`, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
    signal: AbortSignal.timeout(RADIO_TIMEOUT + 3000),
  });
  if (!res.ok) throw new Error(`watch page HTTP ${res.status}`);
  const html = await res.text();
  const marker = html.search(/ytInitialData"?\]?\s*=\s*\{/);
  if (marker < 0) {
    const blocked = /captcha|unusual traffic|consent\.youtube/i.test(html);
    throw new Error(blocked ? 'watch page blocked by a bot check' : 'watch page had no ytInitialData');
  }
  const start = html.indexOf('{', marker);
  const end = html.indexOf(';</script>', start);
  if (end < 0) throw new Error('watch page data was cut off');
  return JSON.parse(html.slice(start, end));
}

const cachedSearch = (q) => cached(`s:${q}:`, () => search(q));

/* ---------------- matching helpers ---------------- */

// Covers, karaoke, remixes, live recordings… never what autoplay should pick.
const VARIANT =
  /\b(cover|karaoke|instrumental|reaction|remix|slowed|sped[ -]?up|reverb|8d|nightcore|tutorial|lesson|chords|mashup|live (at|from|in|on)|live performance)\b/i;

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
const stripExtras = (s) =>
  String(s || '')
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+(ft\.?|feat\.?|featuring)\s.*$/i, '')
    .trim();
const songKey = (title) => norm(stripExtras(title));

function sameSong(track, seed) {
  const key = songKey(seed.title);
  if (key.length < 3) return false;
  return songKey(track.title) === key || (key.length >= 6 && norm(track.rawTitle).includes(key));
}

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Picks the official upload of a song from YouTube search results, skipping covers and live versions.
async function findOnYouTube(artist, title, duration = 0) {
  const artistKey = norm(artist);
  const titleKey = songKey(title);
  if (!artistKey || !titleKey) return null;
  const { tracks } = await cachedSearch(`${artist} ${stripExtras(title)}`);
  let best = null;
  let bestScore = 0;
  for (const t of tracks.slice(0, 6)) {
    const raw = norm(t.rawTitle);
    if (!raw.includes(titleKey)) continue;
    let score = 3;
    if (norm(t.channel).includes(artistKey) || raw.includes(artistKey)) score += 2;
    if (/ - Topic$|VEVO$/i.test(t.channel)) score += 1;
    if (/official/i.test(t.rawTitle)) score += 1;
    if (VARIANT.test(t.rawTitle)) score -= 4;
    if (t.duration < 60 || t.duration > 600) score -= 4;
    if (duration && Math.abs(t.duration - duration) <= 20) score += 2;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best && { ...best, title, artist };
}

/* ---------------- YouTube Music ---------------- */

const YTMUSIC_TIMEOUT = 8000;

// "The Weeknd • After Hours • 2020" -> "The Weeknd"
const firstPart = (s) => String(s || '').split(' • ')[0].trim();

// YouTube Music already separates title and artist, so no "Artist - Title" parsing is needed.
function musicTrack({ videoId, title, artist, durationText = '' }) {
  if (!videoId || !title) return null;
  return {
    id: videoId,
    title,
    artist,
    rawTitle: artist ? `${artist} - ${title}` : title,
    channel: artist,
    duration: parseDuration(durationText),
    durationText,
    thumbnail: thumb(videoId),
  };
}

// Counts of the renderers YouTube Music responses are parsed from, reported by /api/debug/radio
// so parsing can be fixed from the deployed server's real responses.
function shapeOf(data) {
  const keys = [
    'playlistPanelVideoRenderer',
    'musicResponsiveListItemRenderer',
    'musicTwoRowItemRenderer',
    'musicCarouselShelfRenderer',
    'musicShelfRenderer',
    'musicCardShelfRenderer',
  ];
  return {
    topLevel: Object.keys(data || {}),
    ...Object.fromEntries(keys.map((k) => [k, collect(data, k).length])),
    shelves: collect(data, 'musicCarouselShelfBasicHeaderRenderer').map((h) => text(h.title)),
  };
}

function artistLinks(node) {
  const seen = new Set();
  const out = [];
  for (const run of collect(node, 'runs').flat()) {
    const browse = run?.navigationEndpoint?.browseEndpoint;
    const pageType = browse?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
    const isArtist = pageType ? pageType === 'MUSIC_PAGE_TYPE_ARTIST' : browse?.browseId?.startsWith('UC');
    if (!isArtist || !run.text || seen.has(browse.browseId)) continue;
    seen.add(browse.browseId);
    out.push({ name: run.text, browseId: browse.browseId });
  }
  return out;
}

// "Start radio" on YouTube Music: an endless queue of songs like this one.
async function ytmusicRadio(videoId, seed, trace) {
  const data = await innertube(
    'next',
    {
      videoId,
      playlistId: `RDAMVM${videoId}`,
      isAudioOnly: true,
      enablePersistentPlaylistPanel: true,
      tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
      watchEndpointMusicSupportedConfigs: {
        watchEndpointMusicConfig: { hasPersistentPlaylistPanel: true, musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
      },
    },
    { kind: 'music', timeout: YTMUSIC_TIMEOUT }
  );
  trace?.push({ step: 'radio queue', shape: shapeOf(data) });
  const tracks = collect(data, 'playlistPanelVideoRenderer').map((v) =>
    musicTrack({
      videoId: v.videoId,
      title: text(v.title),
      artist: firstPart(text(v.shortBylineText) || text(v.longBylineText)),
      durationText: text(v.lengthText),
    })
  );
  return dedupe(tracks).filter((t) => t.id !== videoId);
}

const ytmusicBrowse = (browseId) =>
  cached(`ytm:b:${browseId}`, () => innertube('browse', { browseId }, { kind: 'music', timeout: YTMUSIC_TIMEOUT }));

// A song row in a YouTube Music list (artist page top songs, Related tab shelves).
function fromMusicListItem(r, fallbackArtist = '') {
  const columns = (r.flexColumns || []).map((c) => text(c.musicResponsiveListItemFlexColumnRenderer?.text));
  // The second column is "Artist • Album", sometimes prefixed with the item type ("Song • Artist").
  const parts = String(columns[1] || '').split(' • ');
  const byline = (/^(song|video|single|ep)$/i.test(parts[0]) ? parts[1] : parts[0])?.trim();
  return musicTrack({
    videoId: r.playlistItemData?.videoId || collect(r, 'watchEndpoint')[0]?.videoId,
    title: columns[0],
    artist: byline && !/\b(plays|views)\b/i.test(byline) ? byline : fallbackArtist,
    durationText:
      (r.fixedColumns || [])
        .map((c) => text(c.musicResponsiveListItemFixedColumnRenderer?.text))
        .find((t) => /^\d+(:\d{2})+$/.test(t)) || '',
  });
}

// The top songs listed on a YouTube Music artist page.
function topSongs(page, artistName) {
  return collect(collect(page, 'musicShelfRenderer')[0], 'musicResponsiveListItemRenderer')
    .map((r) => fromMusicListItem(r, artistName))
    .filter(Boolean);
}

function similarArtists(page) {
  const shelf = collect(page, 'musicCarouselShelfRenderer').find((s) =>
    /fans might also like|similar artists/i.test(collect(s.header, 'title').map(text).join(' '))
  );
  return shelf ? artistLinks(shelf.contents) : [];
}

// Used when the radio isn't available: the artist's "Fans might also like" artists on YouTube Music,
// two top songs from each, with the artist's own hits mixed in.
async function ytmusicArtistRadio(videoId, seed, trace) {
  const query = `${stripExtras(seed.artist)} ${stripExtras(seed.title)}`.trim();
  if (!query) throw new Error('no artist or title to search for');
  const results = await cached(`ytm:s:${query}`, () =>
    innertube('search', { query }, { kind: 'music', timeout: YTMUSIC_TIMEOUT })
  );
  trace?.push({ step: 'search', shape: shapeOf(results) });

  const artistKey = norm(stripExtras(seed.artist));
  const links = artistLinks(results);
  const artist =
    links.find((a) => {
      const name = norm(a.name);
      return artistKey && name && (name.includes(artistKey) || artistKey.includes(name));
    }) || links[0];
  if (!artist) throw new Error('artist not found on YouTube Music');

  const page = await ytmusicBrowse(artist.browseId);
  trace?.push({ step: `artist page: ${artist.name}`, shape: shapeOf(page) });
  const similar = similarArtists(page).filter((a) => a.browseId !== artist.browseId).slice(0, 8);
  const own = shuffled(topSongs(page, artist.name).filter((t) => t.id !== videoId && !sameSong(t, seed))).slice(0, 4);
  const theirs = await mapLimit(similar, 4, (a) =>
    ytmusicBrowse(a.browseId)
      .then((p) => shuffled(topSongs(p, a.name).slice(0, 5)).slice(0, 2))
      .catch(() => [])
  );
  trace?.push({ step: 'similar artists', artists: similar.map((a) => a.name), songsEach: theirs.map((s) => s.length) });

  const tracks = [];
  theirs.forEach((songs, i) => {
    tracks.push(...songs);
    if (i % 2 === 1 && own.length) tracks.push(own.shift());
  });
  tracks.push(...own);
  return dedupe(tracks);
}

// Artist pages come first: from Render, Google blocks YouTube Music's radio request with its bot
// check, while search and artist pages keep working. Trying the radio first made autoplay wait for
// it to time out every time its cooldown ended.
const YTMUSIC_SOURCES = [
  ['ytmusic-artists', ytmusicArtistRadio],
  ['ytmusic-radio', ytmusicRadio],
];

async function ytmusic(videoId, seed) {
  const { tracks, source, failures } = await firstWorking(YTMUSIC_SOURCES, videoId, seed);
  if (!source) throw new Error(failures.join(' | '));
  return { tracks, source };
}

/* ---------------- YouTube Music "Related" tab (experiment) ---------------- */

// The Related tab's ID ("MPTR…") is only given out in a song's `next` response.
const relatedTabId = (data) =>
  collect(data, 'browseEndpoint')
    .map((b) => b.browseId)
    .find((id) => typeof id === 'string' && id.startsWith('MPTR'));

// Songs from the Related tab's "You might also like" shelf.
function relatedTabSongs(page) {
  const shelf = collect(page, 'musicCarouselShelfRenderer').find((s) =>
    /you might also like/i.test(collect(s.header, 'title').map(text).join(' '))
  );
  return dedupe(collect(shelf?.contents, 'musicResponsiveListItemRenderer').map((r) => fromMusicListItem(r)));
}

/* ---------------- radio ---------------- */

// Words that mark a related video as something other than a song.
const NOT_MUSIC =
  /\b(reaction|reacts?|review|interview|podcast|trailer|documentary|tutorial|lesson|explained|vlog|gameplay|news|episode|behind the scenes|making of|unboxing)\b/i;
const MUSIC_HINT = /official (music )?(video|audio)|lyrics?|visuali[sz]er|\bm\/?v\b|\baudio\b/i;

// A related video is kept only if it looks like a song: song length, not a cover or reaction,
// and from an artist/label channel or titled like a music upload ("Artist - Song").
function looksLikeMusic(t) {
  if (t.duration < 90 || t.duration > 8 * 60) return false;
  if (NOT_MUSIC.test(t.rawTitle) || VARIANT.test(t.rawTitle)) return false;
  return / - Topic$|VEVO$/i.test(t.channel) || MUSIC_HINT.test(t.rawTitle) || /\s[-–—]\s/.test(t.rawTitle);
}

function interleave(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

// Related videos filtered to music, woven together with YouTube's auto-generated Mix for the
// video (which is music-only already).
function relatedMusic(data, videoId) {
  const others = (tracks) => dedupe(tracks).filter((t) => t.id !== videoId);
  const mix = others(collect(data, 'playlistPanelVideoRenderer').map(fromPlaylistPanel));
  const related = others(
    collectMany(data, { compactVideoRenderer: fromVideoRenderer, lockupViewModel: fromLockup })
  ).filter(looksLikeMusic);
  return dedupe(interleave(related, mix));
}

const RADIO_TIMEOUT = 5000;

// "Radio": songs related to videoId — the equivalent of Spotify's autoplay. YouTube's related
// videos are tried first, through three different kinds of request because YouTube sometimes
// refuses one of them from cloud servers. If all fail: other songs by the same artist.
// (The browser normally gets recommendations from Deezer instead; see /api/match.)
const RELATED_SOURCES = [
  ['youtube', (videoId) => innertube('next', { videoId, playlistId: `RD${videoId}` }, { timeout: RADIO_TIMEOUT })],
  ['watch-page', (videoId) => watchPage(videoId)],
].map(([source, fetchData]) => [source, async (videoId) => relatedMusic(await fetchData(videoId), videoId)]);

// A source YouTube refuses from this server is skipped for a while, so later lookups
// go straight to what works instead of waiting on requests that will fail again.
const SOURCE_COOLDOWN = 15 * 60 * 1000;
const sourceCooldown = new Map();

// Tries sources in order and returns the first one with at least 3 songs.
async function firstWorking(sources, videoId, seed) {
  const failures = [];
  for (const [source, run] of sources) {
    if ((sourceCooldown.get(source) || 0) > Date.now()) {
      failures.push(`${source}: skipped, failed recently`);
      continue;
    }
    try {
      const tracks = await run(videoId, seed);
      if (tracks.length >= 3) return { tracks, source, failures };
      failures.push(`${source}: only ${tracks.length} songs`);
    } catch (err) {
      sourceCooldown.set(source, Date.now() + SOURCE_COOLDOWN);
      console.warn(`[autoplay] ${source} unavailable for 15 min: ${err.message}`);
      failures.push(`${source}: ${err.message}`);
    }
  }
  return { tracks: [], source: null, failures };
}

async function radio(videoId, seed) {
  const { tracks, source, failures } = await firstWorking(RELATED_SOURCES, videoId, seed);
  if (source) return { tracks, source };

  if (seed.artist) {
    try {
      const tracks = (await cachedSearch(seed.artist)).tracks.filter(
        (t) => t.id !== videoId && !VARIANT.test(t.rawTitle) && !sameSong(t, seed)
      );
      if (tracks.length) {
        console.warn(`[radio] ${videoId} fell back to artist search -> ${failures.join(' | ')}`);
        return { tracks, source: 'artist-search' };
      }
      failures.push('artist-search: no usable results');
    } catch (err) {
      failures.push(`artist-search: ${err.message}`);
    }
  }
  throw new Error(failures.join(' | '));
}

async function suggest(q) {
  const url = `https://suggestqueries-clients6.youtube.com/complete/search?client=firefox&ds=yt&hl=en&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const body = await res.json();
  return Array.isArray(body?.[1]) ? body[1].slice(0, 8) : [];
}

/* ---------------- HTTP ---------------- */

const app = express();
app.disable('x-powered-by');
app.use(compression());

const seedFrom = (req) => ({
  artist: String(req.query.artist || '').trim().slice(0, 100),
  title: String(req.query.title || '').trim().slice(0, 150),
});

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    console.error(`[${req.path}]`, err.message);
    res.status(502).json({ error: 'YouTube request failed', detail: err.message });
  }
};

app.get(
  '/api/search',
  wrap(async (req) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    const cont = req.query.continuation ? String(req.query.continuation) : null;
    if (!q && !cont) return { tracks: [], continuation: null };
    return cached(`s:${q}:${cont || ''}`, () => search(q, cont));
  })
);

app.get(
  '/api/radio',
  wrap(async (req) => {
    const id = String(req.query.id || '');
    if (!/^[\w-]{11}$/.test(id)) return { tracks: [] };
    return cached(`r:${id}`, () => radio(id, seedFrom(req)));
  })
);

// Song radio from YouTube Music, used first by the browser's autoplay.
app.get(
  '/api/ytmusic/radio',
  wrap(async (req) => {
    const id = String(req.query.id || '');
    if (!/^[\w-]{11}$/.test(id)) return { tracks: [] };
    return cached(`ytm:r:${id}`, () => ytmusic(id, seedFrom(req)));
  })
);

// Matches songs recommended in the browser (artist + title from Deezer) to their official YouTube
// uploads. YouTube search works from this server even when YouTube's other endpoints don't.
app.post(
  '/api/match',
  express.json({ limit: '32kb' }),
  wrap(async (req) => {
    const songs = (Array.isArray(req.body?.songs) ? req.body.songs : []).slice(0, 10).map((s) => ({
      artist: String(s?.artist || '').trim().slice(0, 100),
      title: String(s?.title || '').trim().slice(0, 150),
      duration: Number(s?.duration) || 0,
    }));
    const tracks = await mapLimit(songs, 4, (s) =>
      cached(`m:${s.artist}:${s.title}`, () => findOnYouTube(s.artist, s.title, s.duration)).catch(() => null)
    );
    return { tracks };
  })
);

// Diagnostics: runs every autoplay source for one video from this server and reports what each
// returned or why it failed. Open /api/debug/radio?id=VIDEO_ID&artist=...&title=... on Render.
app.get('/api/debug/radio', async (req, res) => {
  const id = String(req.query.id || '');
  if (!/^[\w-]{11}$/.test(id)) return res.status(400).json({ error: 'Pass ?id= with an 11-character video id' });
  const seed = seedFrom(req);
  const report = [];
  for (const [source, run] of [...YTMUSIC_SOURCES, ...RELATED_SOURCES]) {
    const started = Date.now();
    const trace = [];
    try {
      const tracks = await run(id, seed, trace);
      report.push({
        source,
        ok: true,
        ms: Date.now() - started,
        tracks: tracks.length,
        sample: tracks.slice(0, 5).map((t) => `${t.artist} - ${t.title}`),
        trace,
      });
    } catch (err) {
      report.push({ source, ok: false, ms: Date.now() - started, error: err.message, trace });
    }
  }
  const cooldowns = Object.fromEntries(
    [...sourceCooldown].map(([source, until]) => [source, `${Math.max(0, Math.round((until - Date.now()) / 1000))}s left`])
  );
  res.json({ id, seed, cooldowns, report });
});

app.get(
  '/api/suggest',
  wrap(async (req) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) return { suggestions: [] };
    return { suggestions: await cached(`q:${q}`, () => suggest(q)) };
  })
);

// Experiment: can any YouTube Music client load a song's "Related" tab from this server?
// For each client (website, Android app, iPhone app) it makes the song's `next` request, which
// holds the radio queue and the Related tab's ID, then loads the Related tab with that ID.
// Open /api/debug/related?id=VIDEO_ID on Render.
app.get('/api/debug/related', async (req, res) => {
  const id = String(req.query.id || '');
  if (!/^[\w-]{11}$/.test(id)) return res.status(400).json({ error: 'Pass ?id= with an 11-character video id' });
  const report = [];
  for (const kind of ['music', 'musicAndroid', 'musicIos']) {
    const entry = { client: CLIENTS[kind].client.clientName };
    let started = Date.now();
    try {
      const data = await innertube(
        'next',
        { videoId: id, playlistId: `RDAMVM${id}`, isAudioOnly: true, enablePersistentPlaylistPanel: true },
        { kind, timeout: 8000, fresh: true }
      );
      entry.next = {
        ok: true,
        ms: Date.now() - started,
        radioQueueSongs: collect(data, 'playlistPanelVideoRenderer').length,
        shape: shapeOf(data),
      };
      entry.relatedTabId = relatedTabId(data) || null;
      if (entry.relatedTabId) {
        entry.relatedTab = [];
        for (const browseKind of new Set(['music', kind])) {
          started = Date.now();
          try {
            const page = await innertube('browse', { browseId: entry.relatedTabId }, { kind: browseKind, timeout: 8000 });
            const songs = relatedTabSongs(page);
            entry.relatedTab.push({
              via: CLIENTS[browseKind].client.clientName,
              ok: true,
              ms: Date.now() - started,
              songs: songs.length,
              sample: songs.slice(0, 6).map((s) => `${s.artist} - ${s.title}`),
              shape: shapeOf(page),
            });
          } catch (err) {
            entry.relatedTab.push({ via: CLIENTS[browseKind].client.clientName, ok: false, ms: Date.now() - started, error: err.message });
          }
        }
      }
    } catch (err) {
      entry.next = { ok: false, ms: Date.now() - started, error: err.message };
    }
    report.push(entry);
  }
  res.json({ id, report });
});

app.get('/api/thumb/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[\w-]{11}$/.test(id)) return res.status(400).end();
  const file = req.query.size === 'hq' ? 'hqdefault.jpg' : 'mqdefault.jpg';
  try {
    const upstream = await fetch(`https://i.ytimg.com/vi/${id}/${file}`);
    if (!upstream.ok) return res.status(upstream.status).end();
    res.set({
      'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=604800, immutable',
    });
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.error('[thumb]', err.message);
    res.status(502).end();
  }
});

app.get('/healthz',(_req, res) => res.send('ok'));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Spoti listening on http://localhost:${PORT}`));
