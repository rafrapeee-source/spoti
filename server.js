import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// Everything the app shows comes from Deezer, called from the browser. This server only finds
// each song's upload on YouTube, whose embed plays the audio, and proxies YouTube thumbnails for
// songs saved before the switch to Deezer.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const YOUTUBE = {
  url: 'https://www.youtube.com/youtubei/v1',
  client: { clientName: 'WEB', clientVersion: '2.20250910.00.00', hl: 'en', gl: 'US' },
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'Accept-Language': 'en-US,en;q=0.9',
    'X-YouTube-Client-Name': '1',
    'X-YouTube-Client-Version': '2.20250910.00.00',
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com/',
    // Skips the EU consent interstitial.
    Cookie: 'CONSENT=YES+1; SOCS=CAI',
  },
};

// Reusing the visitor id YouTube hands out makes follow-up requests look like one browser session.
let visitorData = null;

// Search filter: type = video
const VIDEO_FILTER = 'EgIQAQ%3D%3D';

/* ---------------- tiny TTL cache ---------------- */
// Holds parsed results only (never whole YouTube responses), so entries stay small.
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 2000;

function cached(key, fn, ttl = CACHE_TTL) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    // Re-inserting keeps the map in least-recently-used order, so eviction drops the stalest entry.
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }
  const value = fn().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { value, expires: Date.now() + ttl });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

async function innertube(endpoint, body, { timeout = 12000 } = {}) {
  const { url, client, headers } = YOUTUBE;
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
    throw new Error(`YouTube ${endpoint} HTTP ${res.status}${reason ? `: ${reason}` : ''}`);
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

function fromVideoRenderer(v) {
  if (!v?.videoId) return null;
  // Skip live streams (no duration) — they don't behave like songs.
  const durationText = text(v.lengthText);
  if (!durationText) return null;
  return {
    id: v.videoId,
    rawTitle: text(v.title),
    channel: text(v.ownerText || v.longBylineText || v.shortBylineText),
    duration: parseDuration(durationText),
  };
}

async function searchVideos(query) {
  const data = await innertube('search', { query, params: decodeURIComponent(VIDEO_FILTER) });
  const seen = new Set();
  return collect(data, 'videoRenderer')
    .map(fromVideoRenderer)
    .filter((v) => v && !seen.has(v.id) && seen.add(v.id));
}

/* ---------------- matching songs to YouTube uploads ---------------- */

// Covers, karaoke, remixes, live recordings… only right when the song itself is one.
const VARIANT =
  /\b(cover|karaoke|instrumental|reaction|remix|slowed|sped[ -]?up|reverb|8d|nightcore|tutorial|lesson|chords|mashup|live (at|from|in|on)|live performance)\b/i;

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
const stripExtras = (s) =>
  String(s || '')
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+(ft\.?|feat\.?|featuring)\s.*$/i, '')
    .trim();
// "Song (feat. X)" -> "Song", keeping versions like "(Live)" or "(Remix)" that change the recording.
const stripFeat = (s) =>
  String(s || '')
    .replace(/\s*[([](ft\.?|feat\.?|featuring|with)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+(ft\.?|feat\.?|featuring)\s.*$/i, '')
    .trim();

// How likely a video is to be the song: the artist (in the title or channel) and the title, or
// failing that the exact length, a translated title being common. Then the official upload (an
// auto-generated "Topic" channel or VEVO) and the length Deezer gives. null rules a video out:
// a cover by someone else is never better than skipping the song.
function scoreVideo(video, { artist, title, duration }) {
  const raw = norm(video.rawTitle);
  const artistKey = norm(artist);
  const titleMatch = raw.includes(norm(stripExtras(title)));
  const artistMatch = norm(video.channel).includes(artistKey) || raw.includes(artistKey);
  const diff = duration ? Math.abs(video.duration - duration) : Infinity;
  if (!artistMatch || (!titleMatch && diff > 3)) return null;
  let score = titleMatch ? 5 : 2;
  if (/ - Topic$|VEVO$/i.test(video.channel)) score += 1;
  if (/official/i.test(video.rawTitle)) score += 1;
  if (VARIANT.test(video.rawTitle) && !VARIANT.test(title)) score -= 4;
  if (video.duration < 30 || video.duration > 900) score -= 4;
  if (diff <= 3) score += 3;
  else if (diff <= 20) score += 1;
  else if (diff > 90 && duration) score -= 2;
  return score;
}

// Which upload is a song rarely changes, so matches are kept for a day.
const MATCH_TTL = 24 * 60 * 60 * 1000;

// The candidates for one song, best first. `exclude` skips videos that already failed to play.
async function matchSong({ artist, title, duration, exclude = [] }) {
  if (!norm(artist) || !norm(stripExtras(title))) return [];
  const query = `${artist} ${stripFeat(title)}`;
  const videos = await cached(`s:${query}`, () => searchVideos(query), MATCH_TTL);
  return videos
    .slice(0, 8)
    .filter((v) => !exclude.includes(v.id))
    .map((video) => ({ video, score: scoreVideo(video, { artist, title, duration }) }))
    .filter((c) => c.score != null && c.score > 0)
    .sort((a, b) => b.score - a.score);
}

const findVideo = (song) =>
  cached(
    `m:${song.artist}:${song.title}:${song.duration}:${song.exclude.join(',')}`,
    async () => (await matchSong(song))[0]?.video.id || null,
    MATCH_TTL
  );

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

/* ---------------- HTTP ---------------- */

const app = express();
app.disable('x-powered-by');
app.use(compression());

const VIDEO_ID = /^[\w-]{11}$/;

const songFrom = (s) => ({
  artist: String(s?.artist || '').trim().slice(0, 100),
  title: String(s?.title || '').trim().slice(0, 150),
  duration: Number(s?.duration) || 0,
  exclude: (Array.isArray(s?.exclude) ? s.exclude : []).map(String).filter((id) => VIDEO_ID.test(id)).slice(0, 5),
});

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    console.error(`[${req.path}]`, err.message);
    res.status(502).json({ error: 'YouTube request failed', detail: err.message });
  }
};

// Finds the YouTube upload of each song (artist, title and length from Deezer): `videos[i]` is a
// video id, or null when YouTube has nothing that matches.
app.post(
  '/api/match',
  express.json({ limit: '32kb' }),
  wrap(async (req) => {
    const songs = (Array.isArray(req.body?.songs) ? req.body.songs : []).slice(0, 10).map(songFrom);
    const videos = await mapLimit(songs, 4, (s) => findVideo(s).catch(() => null));
    return { videos };
  })
);

// Diagnostics: shows how the YouTube results for one song were scored. Open
// /api/debug/match?artist=ARTIST&title=TITLE&duration=SECONDS on Render.
app.get(
  '/api/debug/match',
  wrap(async (req) => {
    const song = songFrom(req.query);
    const candidates = await matchSong(song);
    return {
      song,
      candidates: candidates.map(({ video, score }) => ({ score, ...video })),
    };
  })
);

// Streams the first image that loads, so the server never holds a whole image in memory.
async function sendImage(res, urls) {
  let status = 502;
  for (const url of urls) {
    try {
      const upstream = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!upstream.ok || !upstream.body) {
        status = upstream.status;
        continue;
      }
      res.set({
        'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=604800, immutable',
      });
      await pipeline(Readable.fromWeb(upstream.body), res);
      return;
    } catch (err) {
      if (res.headersSent) return res.destroy();
      console.error('[image]', err.message);
    }
  }
  res.status(status).end();
}

// Thumbnails of songs saved before the switch to Deezer, which are YouTube videos.
app.get('/api/thumb/:id', (req, res) => {
  const { id } = req.params;
  if (!VIDEO_ID.test(id)) return res.status(400).end();
  const file = req.query.size === 'hq' ? 'hqdefault.jpg' : 'mqdefault.jpg';
  sendImage(res, [`https://i.ytimg.com/vi/${id}/${file}`]);
});

// Album art of songs saved from YouTube Music before the switch to Deezer, falling back to the
// video thumbnail. Only lh3.googleusercontent.com images can be requested: not an open proxy.
app.get('/api/art/:id', (req, res) => {
  const { id } = req.params;
  const src = String(req.query.src || '');
  if (!VIDEO_ID.test(id)) return res.status(400).end();
  const size = req.query.size === 'hq' ? 544 : 120;
  const urls = [`https://i.ytimg.com/vi/${id}/mqdefault.jpg`];
  if (/^[\w\-/.]{1,400}$/.test(src) && !src.includes('..')) {
    urls.unshift(`https://lh3.googleusercontent.com/${src}=w${size}-h${size}-l90-rj`);
  }
  sendImage(res, urls);
});

app.get('/healthz', (_req, res) => res.send('ok'));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Spoti listening on http://localhost:${PORT}`));
