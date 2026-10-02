// Deezer's public API: everything the app shows (search, artists, albums, charts, genres and
// autoplay recommendations). It's called from the browser with JSONP, since Deezer sends no CORS
// headers and blocks requests from cloud servers like Render. Deezer only has 30-second previews,
// so the audio comes from YouTube, matched song by song by our server.

const API = 'https://api.deezer.com';
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 300;
// Error code Deezer returns past its limit of 50 requests per 5 seconds.
const QUOTA_EXCEEDED = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;

let seq = 0;
function jsonp(path) {
  return new Promise((resolve, reject) => {
    const callback = `__deezer${++seq}`;
    const script = document.createElement('script');
    const finish = (err, data) => {
      clearTimeout(timer);
      window[callback] = () => {}; // a response arriving after the timeout must not throw
      script.remove();
      if (err) return reject(err);
      if (data?.error) {
        const error = new Error(`Deezer: ${data.error.message || data.error.type}`);
        error.code = data.error.code;
        return reject(error);
      }
      resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('Deezer timed out')), 10000);
    window[callback] = (data) => finish(null, data);
    script.onerror = () => finish(new Error('Deezer is unreachable'));
    script.src = `${API}${path}${path.includes('?') ? '&' : '?'}output=jsonp&callback=${callback}`;
    document.head.append(script);
  });
}

// Responses are kept for a few minutes, so going back to a page doesn't ask Deezer again.
const cache = new Map();
export function deezer(path) {
  const hit = cache.get(path);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = jsonp(path).catch(async (err) => {
    if (err.code !== QUOTA_EXCEEDED) throw err;
    await sleep(1500);
    return jsonp(path);
  });
  value.catch(() => cache.delete(path));
  cache.set(path, { value, expires: Date.now() + CACHE_TTL });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

/* ---------------- data ---------------- */

// Deezer's image CDN serves any square size of a cover or artist picture.
const image = (kind, md5, size) =>
  md5 ? `https://cdn-images.dzcdn.net/images/${kind}/${md5}/${size}x${size}-000000-80-0-0.jpg` : '';

function fmt(total) {
  const t = Math.max(0, Math.floor(total || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

// `id` is Deezer's track id, as a string. `artistId` and `albumId` link to their pages.
export function toTrack(d, album = d?.album) {
  if (!d?.id || !d.title) return null;
  const artist = d.artist?.name || '';
  const md5 = d.md5_image || album?.md5_image;
  return {
    id: String(d.id),
    dz: d.id,
    title: d.title,
    artist,
    artistId: d.artist?.id || null,
    album: album?.title || '',
    albumId: album?.id || null,
    rawTitle: `${artist} - ${d.title}`,
    duration: d.duration || 0,
    durationText: d.duration ? fmt(d.duration) : '',
    thumbnail: { small: image('cover', md5, 120), large: image('cover', md5, 1000), square: true },
  };
}

// `hasPicture` is false for artists Deezer has no photo of (their picture URLs have no image id).
export const toArtist = (a) =>
  a?.id
    ? {
        id: a.id,
        name: a.name,
        fans: a.nb_fan || 0,
        hasPicture: !/\/images\/artist\/\//.test(a.picture_medium || ''),
        picture: { small: a.picture_medium || '', large: a.picture_xl || a.picture_big || '' },
      }
    : null;

export const toAlbum = (a, artist = a?.artist) =>
  a?.id
    ? {
        id: a.id,
        title: a.title,
        artist: artist?.name || '',
        artistId: artist?.id || null,
        type: a.record_type || 'album',
        year: String(a.release_date || '').slice(0, 4),
        cover: { small: image('cover', a.md5_image, 250), large: image('cover', a.md5_image, 1000) },
      }
    : null;

const list = (items, fn) => (items || []).map((x) => fn(x)).filter(Boolean);

/* ---------------- search ---------------- */

const PAGE = 25;

export async function search(q) {
  const [tracks, artists, albums] = await Promise.all([
    deezer(`/search?q=${enc(q)}&limit=${PAGE}`),
    deezer(`/search/artist?q=${enc(q)}&limit=8`).catch(() => ({})),
    deezer(`/search/album?q=${enc(q)}&limit=8`).catch(() => ({})),
  ]);
  return {
    tracks: list(tracks.data, toTrack),
    next: tracks.next ? PAGE : null,
    artists: list(artists.data, toArtist),
    albums: list(albums.data, toAlbum),
  };
}

export async function searchMore(q, index) {
  const res = await deezer(`/search?q=${enc(q)}&limit=${PAGE}&index=${index}`);
  return { tracks: list(res.data, toTrack), next: res.next ? index + PAGE : null };
}

// Results as you type: a couple of artists and a few songs.
export async function instant(q) {
  const [tracks, artists] = await Promise.all([
    deezer(`/search?q=${enc(q)}&limit=5`),
    deezer(`/search/artist?q=${enc(q)}&limit=2`).catch(() => ({})),
  ]);
  return { tracks: list(tracks.data, toTrack), artists: list(artists.data, toArtist) };
}

/* ---------------- pages ---------------- */

export async function artistPage(id) {
  const [artist, top, albums, related] = await Promise.all([
    deezer(`/artist/${id}`),
    deezer(`/artist/${id}/top?limit=10`),
    deezer(`/artist/${id}/albums?limit=50`).catch(() => ({})),
    deezer(`/artist/${id}/related?limit=12`).catch(() => ({})),
  ]);
  // Deezer lists explicit and clean editions of an album separately.
  const seen = new Set();
  const discography = list(albums.data, (a) => toAlbum(a, artist)).filter(
    (a) => !seen.has(a.title.toLowerCase()) && seen.add(a.title.toLowerCase())
  );
  return { artist: toArtist(artist), top: list(top.data, toTrack), albums: discography, related: list(related.data, toArtist) };
}

export async function albumPage(id) {
  const a = await deezer(`/album/${id}`);
  return {
    album: { ...toAlbum(a), label: a.label || '', duration: a.duration || 0 },
    tracks: list(a.tracks?.data, (t) => toTrack(t, a)),
  };
}

// The top songs, albums and artists on Deezer right now, overall (genre 0) or in one genre.
export async function charts(genreId = 0) {
  const [tracks, albums, artists] = await Promise.all([
    deezer(`/chart/${genreId}/tracks?limit=50`),
    deezer(`/chart/${genreId}/albums?limit=12`).catch(() => ({})),
    deezer(`/chart/${genreId}/artists?limit=12`).catch(() => ({})),
  ]);
  return { tracks: list(tracks.data, toTrack), albums: list(albums.data, toAlbum), artists: list(artists.data, toArtist) };
}

export async function genres() {
  const { data = [] } = await deezer('/genre');
  return data.filter((g) => g.id).map((g) => ({ id: g.id, name: g.name, picture: g.picture_medium }));
}

export async function genre(id) {
  if (!Number(id)) return { id: 0, name: 'Top charts', picture: '' };
  const g = await deezer(`/genre/${id}`);
  return { id: g.id, name: g.name, picture: g.picture_medium };
}

/* ---------------- autoplay ---------------- */

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

function shuffled(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A song on Deezer from its artist and title, for songs saved before the switch to Deezer.
export async function findTrack(track) {
  const strip = (s) => String(s || '').replace(/\s*[([].*?[)\]]/g, '').trim();
  const artistKey = norm(strip(track.artist));
  for (const q of new Set([`${strip(track.artist)} ${strip(track.title)}`.trim(), strip(track.title)])) {
    if (!q) continue;
    const { data = [] } = await deezer(`/search?q=${enc(q)}&limit=10`);
    const sameArtist = data.find((d) => {
      const a = norm(d.artist?.name);
      return artistKey && a && (a.includes(artistKey) || artistKey.includes(a));
    });
    if (sameArtist || data[0]) return toTrack(sameArtist || data[0]);
  }
  return null;
}

// Songs for autoplay from one seed song, put together like a radio station: Deezer's radio for
// the artist (their songs and similar artists'), one song per artist and two for about a third of
// them, with 0-3 of the artist's own hits to open and two more later on. `variant` > 0 asks for
// another mix from a seed used before: it also reaches further out, through the radio of one of
// the artist's related artists. The app then spaces artists out and mixes in Liked Songs.
export async function radioMix(seed, { variant = 0 } = {}) {
  const artistId = seed.artistId || (await findTrack(seed))?.artistId;
  if (!artistId) throw new Error('artist not found on Deezer');
  const [radio, top, related] = await Promise.all([
    deezer(`/artist/${artistId}/radio?limit=50`),
    deezer(`/artist/${artistId}/top?limit=10`).catch(() => ({})),
    variant ? deezer(`/artist/${artistId}/related?limit=15`).catch(() => ({})) : {},
  ]);
  const relatedArtists = related.data || [];
  const wide = relatedArtists.length
    ? await deezer(`/artist/${shuffled(relatedArtists)[0].id}/radio?limit=25`).catch(() => ({}))
    : {};

  // The artist's own songs: popular ones, in a random order.
  const own = shuffled(list(top.data, toTrack).filter((t) => t.artistId === artistId && t.id !== seed.id));
  const opening = own.splice(0, [0, 1, 1, 2, 2, 3][Math.floor(Math.random() * 6)]);

  // Other artists' songs, grouped by artist in the order the radio gave them.
  const groups = (tracks) => {
    const byArtist = new Map();
    for (const t of tracks) {
      if (!t.artistId || t.artistId === artistId) continue;
      if (!byArtist.has(t.artistId)) byArtist.set(t.artistId, []);
      byArtist.get(t.artistId).push(t);
    }
    return [...byArtist.values()];
  };
  const near = groups(list(radio.data, toTrack)).map((songs) => shuffled(songs).slice(0, Math.random() < 0.3 ? 2 : 1));
  const nearArtists = new Set(near.map((songs) => songs[0].artistId));
  const far = groups(list(wide.data, toTrack))
    .filter((songs) => !nearArtists.has(songs[0].artistId))
    .slice(0, 6)
    .map((songs) => [songs[0]]);

  // Close artists come first, the artist's own songs return now and then, and the wider picks are
  // spread through the second half.
  const jitter = (n) => Math.random() * n;
  const blocks = [
    ...near.map((songs, i) => ({ songs, at: i * 1.3 + jitter(3) })),
    ...own.slice(0, 2).map((song, i) => ({ songs: [song], at: 4 + i * 5 + jitter(3) })),
    ...far.map((songs, i) => ({ songs, at: 5 + i * 1.8 + jitter(4) })),
  ]
    .sort((a, b) => a.at - b.at)
    .map((b) => b.songs);
  return [...opening, ...blocks.flat()];
}
