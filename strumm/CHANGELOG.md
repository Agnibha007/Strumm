# Changelog

All notable changes to Strumm will be documented in this file.

## [2.1.0] — 2026-07-04

### Added
- Legal pages: Privacy Policy, Terms of Service, Cookie Policy, DMCA Policy, Content Removal Policy
- Trust pages: About, Contact, FAQ, Changelog, Roadmap, Status, Credits, Security, OSS Licenses, Report Bug, Feature Request
- 404, 401, 403, 429, 503, Offline, and Maintenance error pages
- Password reset page with strength meter (4-bar validation)
- Password strength validation on backend (min 8 chars, upper + lower + number)
- Per-endpoint rate limiting (login: 5/min, signup: 3/min, forgot-password: 3/min, search: 30/min, general: 100/10s)
- Skip-to-content accessibility link and semantic `<main>` landmark
- Professional HTML email templates with dark mode support (6 email types)
- JSON-LD schemas: SoftwareApplication + enhanced Organization
- PWA: Offline fallback page with network-first service worker strategy
- Footer with legal/trust links across all pages
- `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `INFRASTRUCTURE.md`

### Changed
- Replaced 24h background stats refresher with live recalculation on each play event
- Upgraded rate limiter from single-threshold to per-endpoint configuration
- Fixed error page CSS tokens for correct dark theme styling
- Enhanced service worker to v4 with offline page support and update messaging

### Fixed
- Sound DNA metrics no longer diluted by simulated playback histories
- SEO canonical meta tag no longer incorrectly points all pages to "/"
- Fullscreen video text cutoff — removed truncation on title/artist
- Footer now responsive and visible on all screen sizes via ConditionalFooter component
- Login page no longer offset by sidebar width via conditional sidebarOffset

## [2.0.0] — 2026-06-15

### Added
- Per-page SEO metadata for song, playlist, public profile, podcast, and podcast episode pages
- Audio quality selector (Data Saver / Balanced / High)
- ConditionalFooter component with dynamic sidebar offset
- `recalculate_user_stats_and_save` function for live stats updates

### Changed
- Replay page now computes stats live from raw playback histories
- Migration from `daily_stats_refresher` (24h) to live event-driven stats recalculation
- Store refactoring: separated radio actions, sleep timer utils, media session utils
- Search service refactored into SearchProvider/YouTubeProvider architecture

### Fixed
- Responsive fullscreen overlay layout (square artwork, better height constraints)
- Player loading state not cleared when player already existed
- 99 lint issues resolved across web app
- Duplicate function calls in backend API

## [1.0.0] — 2026-05-01

### Added
- Initial release of Strumm music ecosystem
- Music streaming via YouTube iframe integration
- Custom theme engine (Obsidian, Black Cherry, Vinyl Classic, Ocean Drive, Monochrome, Aurora, Sunset Blvd, Rose Garden, Cyberpunk)
- User authentication: Email/Password, Google OAuth, OTP verification
- Playlist creation, editing, sharing
- Saved songs / Like system
- Strumm Circle (friend activity, connections, real-time activity via WebSocket)
- Strumm Replay (listening statistics, Sound DNA chart, top songs, top artists)
- Strumm Flow (AI-powered playlist curation via Groq)
- Lyrics display (synced via LRCLIB / YouTube)
- Podcast support (RSS import, episode management)
- Search (YouTube + local)
- Room/co-listening feature
- User profiles (public passport)
- Email system (Resend + SMTP)
- PWA support (manifest, service worker shell cache)
- Responsive design with dark theme
