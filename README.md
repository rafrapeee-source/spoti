# Spoti

A Spotify-style web player. Search results come from YouTube, and songs play through a hidden `youtube-nocookie.com` embed.

## Features

- **Search**: YouTube search with suggestions as you type, a top result, and more results that load as you scroll.
- **Queue**: *Play*, *Add to queue*, *Play next*, and removing or jumping to songs in the queue panel.
- **Autoplay**: when your queue runs out, related songs keep playing, like Spotify's radio: songs by the same artist and similar artists, from Deezer's artist radio. Each song is matched to its official YouTube upload. When recommendations run out, a new radio starts from whatever is playing, so the music drifts naturally. If Deezer can't be reached, the server tries YouTube's related videos instead.
- **Controls**: play/pause, seek (drag or arrow keys), next/previous, shuffle, repeat song, volume and mute.
- **Library**: Liked Songs and Recently played, saved in the browser's localStorage.
- **Mobile layout**: a mini player plus a full-screen player.
- **Keyboard shortcuts**: `Space` play/pause, `←`/`→` seek 5 seconds, `M` mute, `/` or `Ctrl+K` search.

## How it works

```
Browser ──► Render (server.js) ──► YouTube (search, song matching, suggestions, thumbnails)
   │
   ├──► Deezer API (song recommendations, via JSONP)
   │
   └──► youtube-nocookie.com embed (hidden 200×200 iframe = lowest quality / 144p)
```

The browser never contacts `www.youtube.com` or `i.ytimg.com`. Search results and thumbnails go through the server. Recommendations are fetched from Deezer by the browser, because YouTube and Deezer both block most requests from cloud servers like Render (YouTube search is the exception). The player is driven with the embed's postMessage API directly, so the `iframe_api` script isn't needed.

## Deploy to Render

1. Push this folder to a GitHub repository.
2. In Render, choose **New → Blueprint** and select the repository. `render.yaml` sets everything up.
   Or choose **New → Web Service** and use:
   - Build command: `npm install`
   - Start command: `npm start`
3. Open the `.onrender.com` URL.

## Troubleshooting autoplay

Open `https://<your-app>.onrender.com/api/debug/radio?id=VIDEO_ID&artist=ARTIST&title=TITLE`. It runs every autoplay source from the server and shows, for each one, how many songs it returned or why it failed.

## Run locally

```
npm install
npm start          # http://localhost:3000 (set PORT to change it)
```
