# Changelog

## 0.1.0 — 2026-11-18

First public release.

- Live GHIN Handicap Index lookups using your own GHIN account. Read-only; no score posting.
- One-time `open-golf-handicap-setup login`: verifies your login with GHIN and saves it in the OS password store (macOS Keychain, Windows DPAPI, Linux Secret Service). The server signs in on demand; nothing has to stay open.
- One-time unofficial-use notice that must be acknowledged before the first live sign-in.
- Conservative request limits: 2-second pacing, 60 lookup requests per session, 200 lookups and 10 sign-ins per 24 hours, at most one retry, persisted 429 cooldowns and 403 stop.
- Encrypted local roster (AES-256-GCM) with its key in the OS password store; shared usage counters across server processes.
- 15 MCP tools: single and batch lookup, name search (last name, first name or both, and US state), roster management with confirmed bulk import and deletion, refresh with change history, export, course handicap calculation, connection status and disconnect.
- macOS, Linux and Windows support (owner-only folders via POSIX modes or Windows ACLs).
- Demo mode with synthetic golfers when no login is saved (or with `--demo`).
- Bundles `@spicygolf/ghin` 0.20.1 with a patched Zod 4.6.7 dependency.
