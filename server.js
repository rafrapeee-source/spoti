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
  const res = await fetch(`${url}/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: visitorData ? { ...headers, 'X-Goog-Visitor-Id': visitorData } : headers,
    body: JSON.stringify({ context: { client: visitorData ? { ...client, visitorData } : client }, ...body }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    visitorData = null;
    const raw = await res.text().catch(() => '');
    let reason = raw.slice(0, 160);
    try {
      reason = JSON.parse(raw).error?.message || reason;
    } catch {}
    throw new Error(`${kind} ${endpoint} HTTP ${res.status}${reason ? `: ${reason}` : ''}`);
  }
  const data = await res.json();
  if (data?.responseContext?.visitorData) visitorData = data.responseContext.visitorData;
  return data;
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

function parseNext(data, videoId) {
  return dedupe([
    ...collect(data, 'playlistPanelVideoRenderer').map(fromPlaylistPanel),
    ...collect(data, 'compactVideoRenderer').map(fromVideoRenderer),
    ...collect(data, 'lockupViewModel').map(fromLockup),
  ]).filter((t) => t.id !== videoId);
}

// "Radio": songs similar to videoId (same artist / genre) — the equivalent of Spotify's autoplay.
// Sources are tried in order because YouTube sometimes rejects one of them from cloud servers:
// the YouTube Mix, YouTube Music's song radio, related videos, then a search for the artist.
const RADIO_TIMEOUT = 6000;
// A source YouTube refuses from this server is skipped for a while, so later lookups
// go straight to what works instead of waiting on requests that will fail again.
const SOURCE_COOLDOWN = 15 * 60 * 1000;
const sourceCooldown = new Map();

async function radio(videoId, hint) {
  const timeout = RADIO_TIMEOUT;
  const attempts = [
    ['mix', () => innertube('next', { videoId, playlistId: `RD${videoId}` }, { timeout })],
    ['music', () => innertube('next', { videoId, playlistId: `RDAMVM${videoId}` }, { kind: 'music', timeout })],
    ['related', () => innertube('next', { videoId }, { timeout })],
  ];
  const failures = [];
  for (const [source, run] of attempts) {
    if ((sourceCooldown.get(source) || 0) > Date.now()) {
      failures.push(`${source}: skipped, failed recently`);
      continue;
    }
    try {
      const tracks = parseNext(await run(), videoId);
      if (tracks.length >= 3) return { tracks, source };
      failures.push(`${source}: only ${tracks.length} tracks`);
    } catch (err) {
      sourceCooldown.set(source, Date.now() + SOURCE_COOLDOWN);
      failures.push(`${source}: ${err.message}`);
    }
  }
  if (hint) {
    try {
      const tracks = (await search(hint)).tracks.filter((t) => t.id !== videoId);
      if (tracks.length) {
        console.warn(`[radio] ${videoId} fell back to search -> ${failures.join(' | ')}`);
        return { tracks, source: 'search' };
      }
      failures.push('search: no results');
    } catch (err) {
      failures.push(`search: ${err.message}`);
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
    const hint = String(req.query.hint || '').trim().slice(0, 100);
    return cached(`r:${id}`, () => radio(id, hint));
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
