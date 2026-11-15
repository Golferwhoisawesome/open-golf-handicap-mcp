# Security model

This describes what Open Golf Handicap MCP protects, how, and where that protection ends.

## Pieces

```
open-golf-handicap-setup login ──saves──▶ OS password store (Keychain / DPAPI / Secret Service)
                                                        │ read on demand
AI client ──stdio──▶ MCP server process ────────────────┘
                     ├─ encrypted roster (~/.open-golf-handicap/roster)
                     └─ isolated SDK worker thread ──HTTPS──▶ GHIN
```

- **`login`** runs in your terminal. It shows the unofficial-use notice once, reads your GHIN username, password and number from hidden prompts, verifies them with one GHIN sign-in and one lookup of your own number, then saves them.
- **Saved data** is a single item in your operating system's password store. It contains the GHIN login and the random 256-bit key that encrypts your roster.
  - macOS: login Keychain, written through `/usr/bin/security` with the value passed on standard input, never as an argument.
  - Windows: encrypted with the Data Protection API for your Windows account, stored in the profile folder.
  - Linux: Secret Service via `secret-tool`. Alternatively, an owner-only file when you explicitly set `OGH_CREDENTIAL_STORE=file`.
- **The MCP server**, started by your AI app, reads the saved login only when a lookup needs a GHIN session (and again after the session expires). It passes the login to an isolated worker thread that runs the [`@spicygolf/ghin`](https://www.npmjs.com/package/@spicygolf/ghin) client.
- **The worker** may contact only three fixed endpoints: the GHIN golfer login, the GHIN golfer search, and the Firebase installation that GHIN's sign-in requires. It rejects redirects, bounds response size and structure, and enforces the request limits.

## What is protected

| Data                    | Where it lives                                    | Protection                                                                   |
| ----------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| GHIN username/password  | OS password store; worker memory during a session | Never in chat, argv, environment, MCP config, tool results or logs           |
| GHIN session token      | Worker memory                                     | Discarded when the session ends                                              |
| Roster key              | OS password store                                 | Never written to disk in the clear (except with `OGH_CREDENTIAL_STORE=file`) |
| Roster and history      | `roster/` in the profile folder                   | AES-256-GCM, authenticated per owner                                         |
| Usage counters, consent | `ghin-usage.json` in the profile folder           | Owner-only file; shared by all server processes, so limits add up            |

The profile folder is owner-only: mode 0700 on macOS/Linux, and on Windows a protected ACL that grants only your account, SYSTEM and Administrators. The tool refuses to use a profile whose permissions are looser, or which is a symlink.

## Request limits

Every request to GHIN or Firebase passes through one gateway in the worker:

- requests start at least 2 seconds apart;
- per session: at most 3 sign-ins, 2 Firebase installations and 60 searches;
- per rolling 24 hours (persisted and shared across processes): at most 10 sign-ins and 200 searches;
- a failed request is retried at most once per command;
- HTTP 429 sets a cooldown (Retry-After, at least 1 minute, or 15 minutes if none is given), and the cooldown is persisted;
- HTTP 403 stops all traffic and is persisted until you run `login` again;
- a login GHIN rejects is not retried until the saved login changes.

These limits are this project's own policy. GHIN has not published or approved them.

## Boundaries (what this does not protect against)

- **Your own OS account.** Any program running as you can ask the password store for the saved login (macOS may prompt) and read the roster. Administrators and root can do anything. Treat malware running as your user as game over.
- **Memory.** Owned buffers are wiped. JavaScript strings and intermediate copies cannot be guaranteed erased.
- **The AI provider.** Handicap results, names and GHIN numbers you ask about are sent to your AI client and its model provider.
- **GHIN-side revocation.** `logout` deletes the saved login. It does not revoke tokens on GHIN's side. To be sure, change your GHIN password.
- **The file fallback.** With `OGH_CREDENTIAL_STORE=file`, the login and roster key are protected only by file permissions.
- **The HTTP server** (`npm start`) is a developer/hosting scaffold. It uses demo data only and cannot reach GHIN.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
