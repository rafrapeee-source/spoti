// Time-synced lyrics, like Spotify's: the line being sung lights up word by word, the view follows
// it, and tapping a line jumps the song there. Lyrics come from LRCLIB (lrclib.net), a free, open
// lyrics database that the browser can call directly. Its synced lyrics time each line; a few also
// time each word ("enhanced LRC"), and for the rest the words' timing is estimated from their
// syllables, so the highlight sweeps through the line at about the pace it's sung.

const API = 'https://lrclib.net/api';
// LRCLIB asks apps to say who they are; browsers can't set User-Agent, so this header does it.
const CLIENT = 'Spoti web player';
const FOUND_TTL = 30 * 24 * 3600 * 1000;
const MISSING_TTL = 24 * 3600 * 1000;
const CACHE_MAX = 80;
// Silences at least this long (intros, solos, breaks) show an interlude instead of a lit line.
const GAP_MIN = 5;

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const normKey = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
const stripExtras = (s) =>
  String(s || '')
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mix|live|mono|stereo).*$/i, '')
    .replace(/\s+(ft\.?|feat\.?|featuring)\s.*$/i, '')
    .trim();
const mainArtist = (s) => String(s || '').split(/,|&| x | feat\.? | ft\.? | with /i)[0].trim();

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(`spoti:${key}`);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeStore(key, value) {
  try {
    localStorage.setItem(`spoti:${key}`, JSON.stringify(value));
  } catch {}
}

/* ---------------- fetching ---------------- */

// Lyrics found (or known to be missing) are kept in the browser, so a song is only looked up once.
const saved = readStore('lyrics', {});
const pending = new Map();

function remember(id, data) {
  delete saved[id];
  saved[id] = { at: Date.now(), data };
  const ids = Object.keys(saved);
  for (const old of ids.slice(0, Math.max(0, ids.length - CACHE_MAX))) delete saved[old];
  writeStore('lyrics', saved);
}

async function get(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${API}${path}`, { headers: { 'Lrclib-Client': CLIENT }, signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Lyrics lookup failed (${res.status})`);
    return await res.json();
  } catch (err) {
    throw err.name === 'AbortError' ? new Error('Lyrics lookup timed out') : err;
  } finally {
    clearTimeout(timer);
  }
}

const pick = (r) =>
  r && { synced: r.syncedLyrics || '', plain: r.plainLyrics || '', instrumental: !!r.instrumental };

// The best of LRCLIB's search results: the same song (title and artist), the same length give or
// take a few seconds (so a live or extended version doesn't match), and synced over plain lyrics.
function best(results, track) {
  const title = normKey(stripExtras(track.title));
  const artist = normKey(mainArtist(track.artist));
  let top = null;
  let topScore = -Infinity;
  for (const r of results || []) {
    const name = normKey(stripExtras(r.trackName));
    if (!name || !title || !(name === title || name.includes(title) || title.includes(name))) continue;
    const diff = track.duration && r.duration ? Math.abs(r.duration - track.duration) : 0;
    if (diff > 8) continue;
    let score = (name === title ? 3 : 1) - diff * 0.3;
    if (artist && normKey(r.artistName).includes(artist)) score += 3;
    if (r.syncedLyrics) score += 4;
    else if (r.plainLyrics || r.instrumental) score += 1;
    else continue;
    if (score > topScore) [top, topScore] = [r, score];
  }
  return top;
}

async function lookup(track) {
  let found = null;
  const duration = Math.round(track.duration || 0);
  if (duration && track.artist) {
    const q = new URLSearchParams({
      artist_name: track.artist,
      track_name: track.title,
      album_name: track.album || '',
      duration: String(duration),
    });
    found = pick(await get(`/get?${q}`));
    if (found?.synced || found?.instrumental) return found;
  }
  const q = new URLSearchParams({ track_name: stripExtras(track.title) || track.title });
  if (track.artist) q.set('artist_name', mainArtist(track.artist));
  const match = pick(best(await get(`/search?${q}`), track));
  // Plain lyrics from an exact match beat nothing, but synced ones from a close match beat both.
  return match?.synced ? match : found || match;
}

// { synced, plain, instrumental }, or null when LRCLIB has nothing for the song.
export function loadLyrics(track) {
  const hit = saved[track.id];
  if (hit && Date.now() - hit.at < (hit.data ? FOUND_TTL : MISSING_TTL)) return Promise.resolve(hit.data);
  if (pending.has(track.id)) return pending.get(track.id);
  const promise = lookup(track)
    .then((data) => {
      remember(track.id, data);
      return data;
    })
    .finally(() => pending.delete(track.id));
  pending.set(track.id, promise);
  return promise;
}

export function prefetchLyrics(track) {
  if (track) loadLyrics(track).catch(() => {});
}

/* ---------------- parsing ---------------- */

const stamp = (m, s) => Number(m) * 60 + Number(String(s).replace(':', '.'));
const LINE_TAGS = /^((?:\s*\[\d+:\d+(?:[.:]\d+)?\])+)(.*)$/;
const WORD_TAG = /<(\d+):(\d+(?:[.:]\d+)?)>/g;

// "[00:12.30]Some words" lines, in time order. A line may carry several timestamps (a repeated
// chorus), and enhanced LRC times each word too: "[00:12.30]<00:12.30>Some <00:12.80>words".
export function parseLrc(text) {
  const entries = [];
  let offset = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) offset = Number(off[1]) / 1000;
    const m = raw.match(LINE_TAGS);
    if (!m) continue;
    const times = [...m[1].matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)].map((t) => stamp(t[1], t[2]));
    const body = m[2];
    let words = null;
    if (times.length === 1 && WORD_TAG.test(body)) {
      WORD_TAG.lastIndex = 0;
      const parts = [...body.matchAll(/<(\d+):(\d+(?:[.:]\d+)?)>([^<]*)/g)].map((p) => ({
        time: stamp(p[1], p[2]),
        text: p[3],
      }));
      words = [];
      parts.forEach((p, i) => {
        if (!p.text.trim()) return;
        words.push({ text: p.text, start: p.time, end: parts[i + 1]?.time ?? null });
      });
    }
    const line = body.replace(WORD_TAG, '').replace(/\s+/g, ' ').trim();
    for (const time of times) entries.push({ time, text: line, words: words?.length ? words : null });
  }
  // A positive offset means the lyrics should show up sooner.
  for (const e of entries) {
    e.time -= offset;
    e.words?.forEach((w) => {
      w.start -= offset;
      if (w.end != null) w.end -= offset;
    });
  }
  return entries.sort((a, b) => a.time - b.time);
}

// Blank lines and "♪" lines mark music without singing.
const isBreak = (text) => !/[\p{L}\p{N}]/u.test(text);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

// How long a word takes to sing, in rough syllables: vowel groups (minus a silent final "e"), one
// per Chinese or Japanese character, and a breath after punctuation.
function weight(word) {
  const letters = word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let n = 0;
  const cjk = letters.match(new RegExp(CJK.source, 'gu'));
  if (cjk) n += cjk.length;
  const latin = letters.replace(new RegExp(CJK.source, 'gu'), '');
  let vowels = (latin.match(/[aeiouy]+/g) || []).length;
  if (vowels > 1 && /[^l]e\W*$/.test(latin)) vowels--;
  if (vowels) n += vowels;
  else if (!cjk && /[\p{L}\p{N}]/u.test(latin)) n += Math.max(1, latin.replace(/[^\p{L}\p{N}]/gu, '').length / 3);
  if (!n) n = 0.2;
  if (/[,.;:!?…]\s*$/.test(word)) n += 0.35;
  return n + 0.15;
}

// Splits a line into words (each Chinese or Japanese character on its own, since those lines have
// no spaces) and spreads them over the time the line is likely sung: about 0.28s a syllable, slowed
// down for ballads with time to spare, but never past the next line.
function estimateWords(text, start, interval) {
  const parts = [];
  for (const piece of text.match(/\S+\s*/g) || [text]) {
    if (CJK.test(piece)) parts.push(...piece.match(/[\s\S][\s,.!?、。，！？]*/gu));
    else parts.push(piece);
  }
  const weights = parts.map(weight);
  const total = weights.reduce((a, b) => a + b, 0);
  const natural = 0.25 + total * 0.28;
  const room = Math.max(0.3, interval - 0.15);
  const sung = Math.min(room, Math.max(natural, Math.min(interval * 0.75, natural * 2)));
  let at = 0;
  return parts.map((t, i) => {
    const w = { text: t, start: start + (at / total) * sung };
    at += weights[i];
    w.end = start + (at / total) * sung;
    return w;
  });
}

// Lines and interludes in play order, each with its start and end in seconds.
export function buildTimeline(entries, duration = 0) {
  const lines = [];
  entries.forEach((e, i) => {
    if (isBreak(e.text)) return;
    const next = entries[i + 1]?.time ?? (duration > e.time ? duration : e.time + 6);
    const interval = Math.max(0.3, next - e.time);
    let words = e.words;
    if (words) {
      words.forEach((w, k) => (w.end ??= words[k + 1]?.start ?? Math.min(next, w.start + 1)));
    } else {
      words = estimateWords(e.text, e.time, interval);
    }
    // A blank entry right after the line marks where its singing stops.
    const breakAfter = entries[i + 1] && isBreak(entries[i + 1].text) ? entries[i + 1].time : null;
    lines.push({ type: 'line', start: e.time, end: words.at(-1).end, breakAfter, words, text: e.text });
  });

  const items = [];
  if (lines.length && lines[0].start >= GAP_MIN) items.push({ type: 'gap', start: 0, end: lines[0].start });
  lines.forEach((line, i) => {
    items.push(line);
    const next = lines[i + 1];
    if (!next) return;
    // Without a blank entry to say where the break starts, assume a little after the words end.
    const from = line.breakAfter ?? line.end + 1.5;
    if (next.start - from >= GAP_MIN) items.push({ type: 'gap', start: from, end: next.start });
  });
  return { items, wordSynced: entries.some((e) => e.words) };
}

/* ---------------- album colour ---------------- */

// A deep, saturated colour from the cover art for the lyrics background (Spotify does the same).
const colors = new Map();
function artColor(url) {
  if (!url) return Promise.resolve(null);
  if (colors.has(url)) return colors.get(url);
  const promise = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const px = ctx.getImageData(0, 0, size, size).data;
        // Pixels are sorted into 12 hue buckets (vivid ones counting most) plus one for greys; the
        // heaviest hue's average is the cover's main colour. (Averaging every pixel would mix, say,
        // red and blue into a muddy brown.)
        const buckets = Array.from({ length: 13 }, () => ({ r: 0, g: 0, b: 0, w: 0 }));
        for (let i = 0; i < px.length; i += 4) {
          const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = (max - min) / 255;
          let bucket = 12; // greys
          if (sat > 0.12 && max > 40) {
            const d = max - min;
            let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            bucket = Math.floor(((h + 6) % 6) * 2);
          }
          const w = bucket === 12 ? 1 : sat * sat * (max / 255);
          const into = buckets[bucket];
          into.r += r * w;
          into.g += g * w;
          into.b += b * w;
          into.w += w;
        }
        // Greys only when the cover has next to no colour (black and white photos).
        const grey = buckets.pop();
        const vivid = buckets.reduce((a, c) => (c.w > a.w ? c : a));
        const top = vivid.w > 0.3 ? vivid : grey;
        resolve(top.w ? toBackground(top.r / top.w, top.g / top.w, top.b / top.w) : null);
      } catch {
        resolve(null); // the image doesn't allow reading its pixels
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  colors.set(url, promise);
  return promise;
}

// The colour's hue, dark enough for white text to read well on it.
function toBackground(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = Math.round(h * 60 + 360) % 360;
  const l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return `hsl(${h} ${Math.round(Math.min(0.62, s * 1.1) * 100)}% ${Math.round(Math.min(0.3, Math.max(0.2, l * 0.6)) * 100)}%)`;
}

/* ---------------- view ---------------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// After scrolling the lyrics yourself, they stop following the song for this long.
const MANUAL_SCROLL_MS = 5000;
// How far the timing control moves the lyrics per click, in seconds.
const DELAY_STEP = 0.25;

// Lyrics timing adjustments, per YouTube video: an upload with an intro the album version doesn't
// have plays everything a few seconds late.
const delays = readStore('lyricsDelay', {});

export class LyricsView {
  #root;
  #body;
  #scroller;
  #resync;
  #delayEl;
  #opts;
  #track = null;
  #open = false;
  #token = 0;
  #items = null;
  #els = [];
  #wordEls = [];
  #active = -2;
  #raf = 0;
  #manualUntil = 0;
  #following = true;
  #mismatchChecked = false;
  #lastP = new Map();

  // opts: time() and duration() of the playing video, videoId(), and seek(seconds).
  constructor(root, opts) {
    this.#root = root;
    this.#opts = opts;
    this.#body = root.querySelector('.lyr-body');
    this.#scroller = root.querySelector('.lyr-scroll');
    this.#resync = root.querySelector('.lyr-resync');
    this.#delayEl = root.querySelector('.lyr-delay');

    root.addEventListener('click', (e) => this.#onClick(e));
    const manual = () => this.#scrolledByHand();
    this.#scroller.addEventListener('wheel', manual, { passive: true });
    this.#scroller.addEventListener('touchmove', manual, { passive: true });
    this.#scroller.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) manual();
    });
    // Dragging the scrollbar: a press on the scroller itself rather than on a line.
    this.#scroller.addEventListener('pointerdown', (e) => e.target === this.#scroller && manual());
    new ResizeObserver(() => this.#open && this.#scrollToActive(true)).observe(this.#scroller);
    document.addEventListener('visibilitychange', () => this.#loop());
  }

  get isOpen() {
    return this.#open;
  }

  setOpen(open) {
    this.#open = open;
    if (open) this.#render();
    this.#loop();
  }

  setTrack(track) {
    if (track?.id === this.#track?.id) return;
    this.#track = track;
    this.#items = null;
    if (this.#open) this.#render();
  }

  get #delay() {
    return delays[this.#opts.videoId()] || 0;
  }

  #setDelay(value) {
    const id = this.#opts.videoId();
    if (!id) return;
    const v = Math.round(value * 100) / 100;
    delete delays[id];
    if (Math.abs(v) >= 0.01) delays[id] = Math.max(-30, Math.min(30, v));
    const ids = Object.keys(delays);
    if (ids.length > 300) delete delays[ids[0]];
    writeStore('lyricsDelay', delays);
    this.#paintDelay();
    this.#active = -2;
  }

  #paintDelay() {
    const d = this.#delay;
    this.#delayEl.textContent = d ? `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}s` : 'Sync';
    this.#delayEl.classList.toggle('on', !!d);
  }

  async #render() {
    const track = this.#track;
    const token = ++this.#token;
    this.#items = null;
    this.#els = [];
    this.#active = -2;
    this.#root.classList.remove('synced');
    this.#scroller.scrollTop = 0;
    this.#resume();
    this.#paintDelay();

    if (!track) {
      this.#root.style.removeProperty('--lyr-bg');
      this.#body.innerHTML = this.#status('Play a song to see its lyrics here.');
      return;
    }
    artColor(track.thumbnail?.small).then((c) => {
      if (token !== this.#token) return;
      if (c) this.#root.style.setProperty('--lyr-bg', c);
      else this.#root.style.removeProperty('--lyr-bg');
    });
    this.#body.innerHTML = `<div class="lyr-skel">${'<i></i>'.repeat(7)}</div>`;

    let data;
    try {
      data = await loadLyrics(track);
    } catch {
      if (token !== this.#token) return;
      this.#body.innerHTML = this.#status(
        "Couldn't load lyrics.",
        'Check your connection, or LRCLIB may be down.',
        '<button class="pill" data-lyr="retry">Try again</button>'
      );
      return;
    }
    if (token !== this.#token) return;

    if (data?.synced) {
      const { items, wordSynced } = buildTimeline(parseLrc(data.synced), track.duration || this.#opts.duration());
      if (items.length) return this.#renderSynced(items, wordSynced);
    }
    if (data?.instrumental) {
      this.#body.innerHTML = this.#status('♪', 'This one’s an instrumental. Enjoy the music.');
    } else if (data?.plain) {
      this.#body.innerHTML = `
        <p class="lyr-note">These lyrics aren’t synced to the song yet.</p>
        ${data.plain
          .split(/\r?\n/)
          .map((l) => (l.trim() ? `<p class="lyr-line past">${esc(l)}</p>` : '<p class="lyr-space"></p>'))
          .join('')}
        <p class="lyr-credit">Lyrics from LRCLIB</p>`;
    } else {
      this.#body.innerHTML = this.#status(
        'Lyrics aren’t available for this song',
        'LRCLIB, the free lyrics library this app uses, doesn’t have them yet.'
      );
    }
  }

  #status(title, text = '', extra = '') {
    return `<div class="lyr-status"><h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}${extra}</div>`;
  }

  #renderSynced(items, wordSynced) {
    this.#body.innerHTML = `
      ${items
        .map((it, i) =>
          it.type === 'gap'
            ? `<div class="lyr-gap" data-i="${i}" aria-hidden="true"><i></i><i></i><i></i></div>`
            : `<p class="lyr-line" data-i="${i}">${it.words.map((w) => `<span class="w">${esc(w.text)}</span>`).join('')}</p>`
        )
        .join('')}
      <p class="lyr-credit">Lyrics from LRCLIB${wordSynced ? '' : ' · word timing estimated'}</p>`;
    this.#items = items;
    this.#els = [...this.#body.querySelectorAll('[data-i]')];
    this.#wordEls = this.#els.map((el) => [...el.querySelectorAll('.w')]);
    this.#root.classList.add('synced');
    this.#lastP.clear();
    this.#active = -2;
    this.#mismatchChecked = false;
    this.#update();
    this.#loop();
  }

  // Once the video's length is known: a YouTube upload noticeably longer or shorter than the album
  // version (a music video's intro, say) probably throws the lyrics off, so say how to fix that.
  #checkMismatch() {
    if (this.#mismatchChecked) return;
    const video = this.#opts.duration();
    const song = this.#track?.duration;
    if (!video) return;
    this.#mismatchChecked = true;
    if (!song || Math.abs(video - song) < 4 || this.#delay) return;
    const diff = Math.round(Math.abs(video - song));
    this.#body.insertAdjacentHTML(
      'afterbegin',
      `<p class="lyr-note">This upload is ${diff} seconds ${video > song ? 'longer' : 'shorter'} than the album version, so the lyrics may be out of time. Use <b>Sync</b> above to move them.</p>`
    );
  }

  #loop() {
    const run = this.#open && this.#items && document.visibilityState === 'visible';
    if (run && !this.#raf) {
      const frame = () => {
        this.#raf = 0;
        if (!this.#open || !this.#items) return;
        this.#update();
        this.#raf = requestAnimationFrame(frame);
      };
      this.#raf = requestAnimationFrame(frame);
    } else if (!run && this.#raf) {
      cancelAnimationFrame(this.#raf);
      this.#raf = 0;
    }
  }

  #update() {
    const items = this.#items;
    if (!items) return;
    this.#checkMismatch();
    const t = this.#opts.time() - this.#delay;

    // The last item that has started; a line stays lit until the next one begins.
    let lo = 0;
    let hi = items.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].start <= t) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }

    if (idx !== this.#active) {
      const first = this.#active === -2;
      this.#active = idx;
      this.#els.forEach((el, i) => {
        el.classList.toggle('past', i < idx);
        el.classList.toggle('active', i === idx);
      });
      this.#scrollToActive(first);
    }
    if (this.#manualUntil && performance.now() > this.#manualUntil) this.#resume(true);

    const item = items[idx];
    if (!item) return;
    if (item.type === 'gap') {
      this.#setP(this.#els[idx], clamp01((t - item.start) / (item.end - item.start)));
    } else {
      const spans = this.#wordEls[idx];
      item.words.forEach((w, k) => this.#setP(spans[k], clamp01((t - w.start) / Math.max(0.05, w.end - w.start))));
    }
  }

  #setP(el, p) {
    if (!el) return;
    const v = Math.round(p * 500) / 500;
    if (this.#lastP.get(el) === v) return;
    this.#lastP.set(el, v);
    el.style.setProperty('--p', v);
  }

  #scrollToActive(instant = false) {
    if (!this.#following || !this.#items) return;
    const el = this.#els[Math.max(0, this.#active)];
    if (!el) return;
    const top = el.offsetTop - this.#scroller.clientHeight * 0.36 + el.offsetHeight / 2;
    this.#scroller.scrollTo({ top: Math.max(0, top), behavior: instant ? 'auto' : 'smooth' });
  }

  #scrolledByHand() {
    if (!this.#items) return;
    this.#following = false;
    this.#manualUntil = performance.now() + MANUAL_SCROLL_MS;
    this.#resync.hidden = false;
  }

  #resume(scroll = false) {
    this.#following = true;
    this.#manualUntil = 0;
    this.#resync.hidden = true;
    if (scroll) this.#scrollToActive();
  }

  #onClick(e) {
    const btn = e.target.closest('[data-lyr]');
    if (btn) {
      switch (btn.dataset.lyr) {
        case 'retry':
          return this.#render();
        case 'resync':
          return this.#resume(true);
        case 'earlier':
          return this.#setDelay(this.#delay - DELAY_STEP);
        case 'later':
          return this.#setDelay(this.#delay + DELAY_STEP);
        case 'reset':
          return this.#setDelay(0);
      }
    }
    // Tapping a line plays the song from there.
    const line = e.target.closest('.lyr-line[data-i]');
    if (line && this.#items && !getSelection()?.toString()) {
      const item = this.#items[Number(line.dataset.i)];
      this.#opts.seek(Math.max(0, item.start + this.#delay));
      this.#resume(true);
    }
  }
}
