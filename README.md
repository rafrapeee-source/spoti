# Spoti

A Spotify-style web player. Everything you see (songs, artists, albums, charts, cover art) comes from Deezer's free API. Deezer only offers 30-second previews, so each song plays from its upload on YouTube, through a hidden `youtube-nocookie.com` embed.

## Features

- **Search**: songs, artists and albums from Deezer, with instant results as you type (pick an artist to open their page, or a song to play it), a top result, and more songs that load as you scroll.
- **Artist pages**: popular songs, discography and "Fans also like".
- **Album pages** and **genre charts**, plus the top songs, artists and albums right now on Home.
- **Queue**: *Play*, *Add to queue*, *Play next*, *Go to artist/album*, and removing or jumping to songs in the queue panel.
- **Autoplay**: when your queue runs out, related songs keep playing, like Spotify's radio. They come from Deezer's artist radio (the artist's songs and similar artists'), mixed with the artist's own hits and, for later refills, a related artist's radio. Like Spotify:
  - it's ordered like a radio station: sometimes a short run of 2–3 songs by one artist, but an artist never comes back within 3 songs by accident, and shuffle doesn't scramble it;
  - it stays close to what you started from: refills alternate between the song (or list) you started with and songs you've since played to the end or saved;
  - it learns: skipping a recommendation in its first 30 seconds means less of that artist (none after a second skip), and finishing songs or saving them counts for the artist, remembered between visits;
  - it mixes in your Liked Songs now and then, when their artist is part of the mix.
- **Lyrics**, synced like Spotify's: press the microphone button (or `L`) and the line being sung lights up word by word as the view follows along. Tap a line to jump there. Instrumental breaks show three dots that fill until the singing comes back. The background takes its colour from the album art, and if you scroll away, the view returns to the current line after a few seconds (or right away with *Back to current line*).
  - **Sync**: if a song's YouTube upload has an intro the album version doesn't, its lyrics run late. *−* and *+* move them a quarter second at a time, and the setting is remembered for that upload. When the upload's length is noticeably different from the song's, the lyrics say so.
  - Lyrics come from [LRCLIB](https://lrclib.net), a free lyrics library. It times each line; for the few songs where it also times each word, those timings are used, and otherwise each word's timing is estimated from its syllables. Songs with only plain lyrics show them unsynced. Lyrics are kept in the browser, and the next song's are fetched ahead while the lyrics are open.
- **Picks up where you left off**: what's playing, the queue and Next up are saved in the browser and restored (paused) on reload.
- **Controls**: play/pause, seek (drag or arrow keys), next/previous, shuffle, repeat song, volume and mute.
- **Library**: Liked Songs, saved in the browser's localStorage.
- **Mobile layout**: a mini player plus a full-screen player.
- **Keyboard shortcuts**: `Space` play/pause, `←`/`→` seek 5 seconds, `M` mute, `L` lyrics, `/` or `Ctrl+K` search.

## How it works

```
Browser ──► Deezer API, via JSONP (search, artists, albums, charts, recommendations)
   │        + Deezer's image CDN (cover art, artist photos)
   │
   ├──► lrclib.net (lyrics, called from the browser)
   │
   ├──► Render (server.js) ──► YouTube search (finds each song's upload)
   │
   └──► youtube-nocookie.com embed (hidden 200×200 iframe = lowest quality / 144p)
```

Deezer is called from the browser because it blocks requests from cloud servers like Render (and sends no CORS headers, hence JSONP).

When a song is about to play, the server searches YouTube for it and picks the official upload: the artist's name in the title or channel, the same title (or exactly the same length, for translated titles), preferring auto-generated "Topic" channels and VEVO, and never covers, karaoke or remixes unless the song is one. The browser remembers each match, and looks up the next song while the current one plays, so there's no pause between songs. If a video can't be played outside YouTube, the next-best upload is tried.

The browser never contacts `www.youtube.com` or `i.ytimg.com`. The player is driven with the embed's postMessage API directly, so the `iframe_api` script isn't needed. Songs liked before the switch to Deezer are YouTube videos, and still play and show their thumbnails (through the server).

## Deploy to Render

1. Push this folder to a GitHub repository.
2. In Render, choose **New → Blueprint** and select the repository. `render.yaml` sets everything up.
   Or choose **New → Web Service** and use:
   - Build command: `npm install`
   - Start command: `npm start`
3. Open the `.onrender.com` URL.

## Troubleshooting playback

If a song plays the wrong version or gets skipped, open `https://<your-app>.onrender.com/api/debug/match?artist=ARTIST&title=TITLE&duration=SECONDS`. It shows the YouTube results for that song and how each one was scored.

## Run locally

```
npm install
npm start          # http://localhost:3000 (set PORT to change it)
```
