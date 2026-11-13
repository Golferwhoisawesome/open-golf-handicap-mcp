# Changelog

## 0.1.0 — Unreleased

First public release.

- Live GHIN Handicap Index lookups using your own GHIN sign-in, entered in a private terminal. Read-only; no score posting.
- One-time unofficial-use notice that must be acknowledged before the first live sign-in.
- Conservative request limits: 2-second pacing, 60 lookup requests per session, 200 lookups and 10 sign-ins per 24 hours, at most one retry, persisted 429 cooldowns and 403 stop.
- Encrypted local profile: roster (AES-256-GCM), optional remembered login (`--remember-login`), usage counters.
- 16 MCP tools: single and batch lookup, roster management with confirmed bulk import and deletion, refresh with change history, export, course handicap calculation, connection status and disconnect.
- macOS, Linux and Windows support (Unix socket or named-pipe session broker; POSIX modes or Windows ACLs).
- Demo mode with synthetic golfers when run without `--ghin`.
- Bundles `@spicygolf/ghin` 0.20.1 with a patched Zod 4.6.7 dependency.
