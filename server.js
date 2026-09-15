import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const YT_BASE = 'https://www.youtube.com/youtubei/v1';
const CLIENT = {
  clientName: 'WEB',
  clientVersion: '2.20250910.00.00',
  hl: 'en',
  gl: 'US',
};
const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-YouTube-Client-Name': '1',
  'X-YouTube-Client-Version': CLIENT.clientVersion,
  Origin: 'https://www.youtube.com',
  Referer: 'https://www.youtube.com/',
  // Skips the EU consent interstitial.
  Cookie: 'CONSENT=YES+1; SOCS=CAI',
};

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

async function innertube(endpoint, body) {
  const res = await fetch(`${YT_BASE}/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ context: { client: CLIENT }, ...body }),
  });
  if (!res.ok) throw new Error(`YouTube ${endpoint} responded ${res.status}`);
  return res.json();
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

// "Radio": YouTube's auto-generated Mix (playlist RD<videoId>) is built from the
// same artist and similar songs — the closest equivalent of Spotify's autoplay.
async function radio(videoId) {
  const data = await innertube('next', { videoId, playlistId: `RD${videoId}` });
  let tracks = dedupe(collect(data, 'playlistPanelVideoRenderer').map(fromPlaylistPanel));

  if (tracks.length < 3) {
    // Fallback: related videos from the watch page sidebar.
    const related = [
      ...collect(data, 'compactVideoRenderer').map(fromVideoRenderer),
      ...collect(data, 'lockupViewModel').map(fromLockup),
    ];
    tracks = dedupe([...tracks, ...related]);
  }
  return tracks.filter((t) => t.id !== videoId);
}

async function suggest(q) {
  const url = `https://suggestqueries-clients6.youtube.com/complete/search?client=firefox&ds=yt&hl=en&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
  if (!res.ok) return [];
  const body = await res.json();
  return Array.isArray(body?.[1]) ? body[1].slice(0, 8) : [];
}

/* ---------------- HTTP ---------------- */

const app = express();
app.disable('x-powered-by');
app.use(compression());

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    console.error(`[${req.path}]`, err.message);
    res.status(502).json({ error: 'Could not reach YouTube. Try again.' });
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
    return { tracks: await cached(`r:${id}`, () => radio(id)) };
  })
);

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
