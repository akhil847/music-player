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

**🎬 Indian music — Telugu, Tamil, Hindi, Kannada, Malayalam, Punjabi**
- **Latest releases** and **Top charts** per language from Apple Music India (free, no setup) — plays Apple's official **30-second previews**
- **Full songs** after adding a free YouTube key (Settings → Full Indian & film songs): every song plays in full from the labels' **official YouTube uploads**, and you also get **Trending this month** (most-watched new songs) and **Fresh from the labels** (Aditya Music, T-Series, Lahari, Sony Music South, Think Music, Saregama and more)
- Search also finds Indian film songs, plus full YouTube results when a key is set
- Song titles from YouTube are cleaned up (`#Pushpa2 - Peelings Lyrical Video | Allu Arjun …` → **Peelings** · 🎬 Pushpa2)
- Notes: YouTube may show its own ads before some songs; the video stays visible in a small window while it plays (YouTube's rule); YouTube songs usually stop when the phone is locked. The free key allows ~100 song searches a day — songs already found are remembered and cost nothing

**Pictures, automatically**
- When a song has no picture, Echo finds its **album cover or movie poster** by itself (via Apple's free iTunes catalogue, which includes film soundtracks) and shows it on the player, the lock screen and in your lists
- Messy file names like `01 - Naatu Naatu (From RRR) [128 kbps]` or `Srivalli_Lyrical_site.in` are cleaned up, and the proper **song title and artist** are filled in when there's a confident match
- **Group covers build themselves** from the pictures of the songs inside (a 2×2 collage once there are 4), with the group's emoji as a badge
- The player shows **"Playing from <group>"** — tap it to jump to that group

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

Indian film and regional songs come from Apple Music India's free catalogue (charts, posters, 30-second previews)
and, with your own free YouTube key, from the music labels' official YouTube channels.

Other streaming, trending charts and search use the free, open [Audius](https://audius.co) API — a legal, ad-free
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
js/artwork.js         Finds posters/cover art and proper names automatically
js/india.js           Indian music: Apple charts/previews, YouTube trending, label uploads, search
js/youtube.js         YouTube playback engine (same interface as the audio player)
sw.js                 Service worker (offline app shell)
manifest.webmanifest  PWA manifest (install to home screen)
icons/                App icons
```
