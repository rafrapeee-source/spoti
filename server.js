import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function clientConfig(host, clientName, clientId, clientVersion) {
  return {
    url: `https://${host}/youtubei/v1`,
    client: { clientName, clientVersion, hl: 'en', gl: 'US' },
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      'X-YouTube-Client-Name': clientId,
      'X-YouTube-Client-Version': clientVersion,
      Origin: `https://${host}`,
      Referer: `https://${host}/`,
      // Skips the EU consent interstitial.
      Cookie: 'CONSENT=YES+1; SOCS=CAI',
    },
  };
}

const CLIENTS = {
  web: clientConfig('www.youtube.com', 'WEB', '1', '2.20250910.00.00'),
  music: clientConfig('music.youtube.com', 'WEB_REMIX', '67', '1.20250910.01.00'),
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

async function innertube(endpoint, body, { kind = 'web', timeout = 12000 } = {}) {
  const { url, client, headers } = CLIENTS[kind];
  for (let attempt = 0; ; attempt++) {
    const visitor = visitorData;
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

const ytmusicBrowse = (browseId) =>
  cached(`ytm:b:${browseId}`, () => innertube('browse', { browseId }, { kind: 'music', timeout: YTMUSIC_TIMEOUT }));

// A song row in a YouTube Music list, such as an artist page's top songs.
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

// Main artist of a credit like "The Weeknd, JENNIE & Lily Rose Depp" or "Calvin Harris feat. Rihanna".
const leadArtist = (artist) => norm(String(artist || '').split(/,|&| x | feat\.? | ft\.? | with /i)[0]);

// Orders recommendations like a radio station instead of in artist blocks: the closest artists come
// early, the original artist returns every few songs, wider-genre picks spread through the second
// half, and the same artist never plays twice in a row.
function radioOrder({ own, near, far }) {
  const jitter = (n) => Math.random() * n;
  const order = [
    ...near.map((t, i) => ({ t, at: i * 1.3 + jitter(3) })),
    ...own.map((t, i) => ({ t, at: 2 + i * 4 + jitter(2) })),
    ...far.map((t, i) => ({ t, at: 5 + i * 1.8 + jitter(4) })),
  ]
    .sort((a, b) => a.at - b.at)
    .map((s) => s.t);

  for (let i = 1; i < order.length; i++) {
    const previous = leadArtist(order[i - 1].artist);
    if (leadArtist(order[i].artist) !== previous) continue;
    const j = order.findIndex((t, k) => k > i && leadArtist(t.artist) !== previous);
    if (j > 0) order.splice(i, 0, ...order.splice(j, 1));
  }
  return order;
}

// Autoplay recommendations from YouTube Music, built like Spotify's radio from the artist's
// "Fans might also like" list: one song from each similar artist, a few of the artist's own songs,
// and one song each from artists similar to those, to reach the wider genre. (YouTube Music's song
// radio and song-based Related tab would be better, but Google blocks the request they need from
// cloud servers, for the website and the phone app clients alike.)
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

  // Skips the playing song, other versions of it, and covers, remixes or sped-up edits.
  const usable = (songs) => songs.filter((t) => t.id !== videoId && !VARIANT.test(t.title) && !sameSong(t, seed));
  const pickOne = (artistPage, a) => (artistPage ? shuffled(usable(topSongs(artistPage, a.name)).slice(0, 6))[0] : null);

  const similar = similarArtists(page).filter((a) => a.browseId !== artist.browseId).slice(0, 10);
  const similarPages = await mapLimit(similar, 5, (a) => ytmusicBrowse(a.browseId).catch(() => null));

  // Artists similar to the similar artists, taken from their own "Fans might also like" lists,
  // which came with the pages loaded above.
  const known = new Set([artist.browseId, ...similar.map((a) => a.browseId)]);
  const wider = new Map();
  for (const p of similarPages) {
    for (const a of p ? similarArtists(p) : []) if (!known.has(a.browseId)) wider.set(a.browseId, a);
  }
  const widerArtists = shuffled([...wider.values()]).slice(0, 5);
  const widerPages = await mapLimit(widerArtists, 5, (a) => ytmusicBrowse(a.browseId).catch(() => null));

  // Drops repeats: the same video, or the same song uploaded twice by the same artist.
  const seen = new Set();
  const fresh = (t) => {
    if (!t) return false;
    const key = `${leadArtist(t.artist)}|${songKey(t.title)}`;
    if (seen.has(t.id) || seen.has(key)) return false;
    seen.add(t.id).add(key);
    return true;
  };
  const near = similar.map((a, i) => pickOne(similarPages[i], a)).filter(fresh);
  const own = shuffled(usable(topSongs(page, artist.name))).filter(fresh).slice(0, 4);
  const far = widerArtists.map((a, i) => pickOne(widerPages[i], a)).filter(fresh);
  trace?.push({
    step: 'mix',
    similar: similar.map((a) => a.name),
    widerGenre: widerArtists.map((a) => a.name),
    songs: { own: own.length, near: near.length, far: far.length },
  });
  return radioOrder({ own, near, far });
}

const YTMUSIC_SOURCES = [['ytmusic-artists', ytmusicArtistRadio]];

async function ytmusic(videoId, seed) {
  const { tracks, source, failures } = await firstWorking(YTMUSIC_SOURCES, videoId, seed);
  if (!source) throw new Error(failures.join(' | '));
  return { tracks, source };
}

/* ---------------- autoplay sources ---------------- */

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

// Last resort when neither YouTube Music nor Deezer gave recommendations: other songs by the same
// artist from YouTube search, without covers or the song that's playing.
async function radio(videoId, seed) {
  if (!seed.artist) throw new Error('no artist to search for');
  const tracks = (await cachedSearch(seed.artist)).tracks.filter(
    (t) => t.id !== videoId && !VARIANT.test(t.rawTitle) && !sameSong(t, seed)
  );
  if (!tracks.length) throw new Error('artist search: no usable results');
  console.warn(`[radio] ${videoId} used the artist search fallback`);
  return { tracks, source: 'artist-search' };
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

// Recommendations from YouTube Music artist pages, used first by the browser's autoplay.
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
  for (const [source, run] of YTMUSIC_SOURCES) {
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
