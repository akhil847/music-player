# Echo — your personal music player

An ad-free music player that runs in any browser and installs on your phone like a native app (PWA).
No account, no ads, no tracking — everything you save stays on your device.

## Features

**Listen**
- 🔥 **Trending** charts (this week / month / all time), filterable by 24 genres
- 🔎 **Search** songs and playlists, plus matches from your own library
- 📀 Trending & searchable **playlists**, which you can save as your own group
- 📁 **Your own files** — upload MP3/M4A/FLAC/WAV/OGG (or drag & drop on desktop). Title, artist and cover art are read from the file's tags
- 🔗 **Links** — add any direct audio URL or internet radio stream

**Organise**
- 👥 **Groups** — your own collections with a name, emoji, colour and description. Put *anything* in them: trending songs, search results, your files, links
- Add songs to a group from any song's ⋮ menu, or open a group → **Add songs** and tap ➕ on anything you find
- Reorder, remove, duplicate, and **share/export** a group as a file a friend can import
- ❤️ Liked songs and 🕘 recently played

**Player**
- Play / pause, next / previous, seek, volume & mute
- Shuffle, repeat all / repeat one
- **Queue**: play next, add to queue, reorder, remove, clear
- Full-screen **Now Playing** screen (swipe down to close on phones)
- **Sleep timer** (5 min – 1 hr, or end of song) and **playback speed** (0.5×–2×)
- **Lock-screen / headphone / car controls** via the Media Session API
- Picks up where you left off — queue, song and position are restored after closing
- Keyboard shortcuts on desktop: `Space` play/pause, `←/→` seek, `N`/`P` next/prev, `S` shuffle, `R` repeat, `L` like, `M` mute, `Q` queue, `/` search

**Make it yours**
- Dark, light or auto theme, 10 accent colours plus a custom colour picker
- Your name in the greeting
- Backup / restore all your groups, likes and settings as a JSON file

**Works offline** — the app shell is cached, and songs stored on your device play without a connection.

## Run it locally

It's plain HTML/CSS/JavaScript with no build step. Serve the folder with any static server:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

(Opening `index.html` directly as a file won't work, because browsers block ES modules and service workers on `file://`.)

## Put it online (free) with GitHub Pages

1. Merge this code into the `main` branch.
2. In the repo on GitHub go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The included workflow (`.github/workflows/pages.yml`) deploys on every push to `main`.
   Your player will be at `https://<your-username>.github.io/music-player/`.

## Install on your phone

- **Android (Chrome):** open the site → menu ⋮ → **Install app** / **Add to Home screen** (or Settings → Install app inside Echo).
- **iPhone (Safari):** open the site → Share → **Add to Home Screen**.

It then launches full-screen with its own icon, and keeps playing with the screen locked.

## Where the music comes from

Streaming, trending charts and search use the free, open [Audius](https://audius.co) API — a legal, ad-free
catalogue of independent artists, so there's nothing to pay and no API key needed. Major-label hits that only
live on Spotify/Apple Music aren't on Audius; for those, add your own files or links and put them in your groups.

## Project structure

```
index.html            App shell, icon sprite, player markup
css/styles.css        Theme tokens, desktop + mobile layouts
js/app.js             Routing, views, groups, sheets, shortcuts
js/player.js          Playback engine: queue, shuffle/repeat, media session, sleep timer
js/store.js           Persistent state (likes, groups, settings, session)
js/db.js              IndexedDB wrapper (data + locally stored audio files)
js/audius.js          Audius API client (trending, search, playlists, streams)
js/id3.js             Reads title/artist/cover art from MP3 tags
sw.js                 Service worker (offline app shell)
manifest.webmanifest  PWA manifest (install to home screen)
icons/                App icons
```
