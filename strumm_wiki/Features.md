# Strumm Features ✦

Here is a detailed guide to Strumm's key user and technical features:

---

## 1. Persistent Background Playback
* A globally persistent media player that persists across views without interrupting playback.
* Full system lock-screen integration using the browser's native **Media Session API**.
* Synchronized playback states between background engines and the frontend view.

## 2. Fullscreen Lyrics Theatre
* Immersive theater mode displays album artwork alongside real-time karaoke-style lyrics.
* Automatically fetches and parses synchronized `.lrc` files from curation engines.
* Clicking on any lyric line allows users to jump instantly to that timestamp.

## 3. Optional Video Podcast Mode
* Automatically detects video enclosures (`video/mp4`, `video/webm`, `video/quicktime`) within podcast RSS feeds.
* Displays a **"Watch Video"** trigger alongside audio controls when video is available.
* Seamlessly switches between **Audio Mode** and **Video Mode** in fullscreen while preserving the current timestamp.
* Native gesture support on mobile (fullscreen rotation, Picture-in-Picture).
* Integrated fallback screens ("Video unavailable, continue with audio") to protect playback continuity.

## 4. Smart LLM Curation
* Personal curation engine powered by the **Groq API**.
* Instantly generates contextual recommendations based on listening history or specific user mood prompts.
* Includes "Flow" and "Explore Mixes" directly in the navigation menus.

## 5. Playlist Importer
* Drag-and-drop CSV importer or link scanner.
* Resolves Spotify and YouTube Music playlists, matching metadata to free high-fidelity sources automatically.
* Generates user playlists instantly.

## 6. Unrestricted MP3 Downloads
* Download any song or podcast episode directly as a DRM-free high-quality MP3 file.
* Handles file proxies on the server side to bypass CORS policies.
