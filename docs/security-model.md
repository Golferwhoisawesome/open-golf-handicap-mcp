# Security model

This describes what Open Golf Handicap MCP protects, how, and where its protection ends.

## Pieces

```
AI client ──stdio──▶ MCP server process ──private local channel──▶ setup terminal (session broker)
                     (roster, lookups)                              ├─ encrypted profile vault
                                                                    └─ isolated SDK worker ──HTTPS──▶ GHIN
```

- **Setup terminal** (`open-golf-handicap-setup connect-ghin`). Unlocks the profile vault with your passphrase, prompts for GHIN credentials and runs the session broker for up to one hour.
- **SDK worker.** A worker thread inside the setup process that runs the [`@spicygolf/ghin`](https://www.npmjs.com/package/@spicygolf/ghin) client. It holds the GHIN password and token. It may contact only three fixed endpoints: the GHIN golfer login, the GHIN golfer search, and Firebase installation (which the GHIN app's sign-in requires). It rejects redirects, bounds response size and structure, and enforces the request limits.
- **MCP server** (`open-golf-handicap-mcp --ghin --profile DIR`). Started by your AI client. It receives the roster encryption key and normalized lookup results from the broker. It never receives GHIN credentials or tokens.
- **Private local channel.** On macOS/Linux, a Unix socket (mode 0600) inside the profile directory (mode 0700). On Windows, a named pipe with a random name, recorded in a file inside the ACL-protected profile directory, so other accounts can neither find the pipe nor create it first.

## What is protected

| Data                    | Where it lives                                                    | Protection                                                            |
| ----------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| Vault passphrase        | Typed into the private terminal only                              | Never stored; derives the vault key                                   |
| GHIN username/password  | Worker memory for the session; vault only with `--remember-login` | Encrypted vault; never in chat, argv, env, MCP config or tool results |
| GHIN session token      | Worker memory                                                     | Discarded when the session ends                                       |
| Roster and history      | `roster/` in the profile                                          | AES-256-GCM with a random key; the key is wrapped by the vault        |
| Usage counters, consent | Vault                                                             | Encrypted; cannot be reset by starting a new session                  |

Profile directories are owner-only: mode 0700 on POSIX, and on Windows a protected ACL granting only your account, SYSTEM and Administrators. The tool refuses to use a profile whose permissions are looser, or which is a symlink.

## Request limits

Every request to GHIN or Firebase passes through one gateway in the worker:

- requests start at least 2 seconds apart;
- per session: at most 3 sign-ins, 2 Firebase installations and 60 searches;
- per rolling 24 hours (persisted): at most 10 sign-ins and 200 searches;
- a failed request is retried at most once per command;
- HTTP 429 sets a cooldown (Retry-After, at least 1 minute, or 15 minutes if none is given), and the cooldown is persisted;
- HTTP 403 stops all traffic in that worker and is persisted until you run `connect-ghin` again.

These limits are this project's own policy. GHIN has not published or approved them.

## Boundaries (what this does not protect against)

- **Your own OS account.** Any program running as you can talk to an unlocked session and read the roster key while it is unlocked. Administrators and root can do anything. Treat malware running as your user as game over.
- **Memory.** Owned buffers are wiped. JavaScript strings and intermediate copies cannot be guaranteed erased.
- **The AI provider.** Handicap results, names and GHIN numbers you ask about are sent to your AI client and its model provider.
- **GHIN-side revocation.** Disconnecting deletes the local login and ends the session. It does not revoke tokens on GHIN's side.
- **Lost passphrase.** There is no recovery. Losing the passphrase loses the roster.
- **OS keychains.** Credentials are stored in this project's own encrypted file vault, not in macOS Keychain, Windows Credential Manager or Secret Service.
- **The HTTP server** (`npm start`) is a developer/hosting scaffold. It uses demo data only and cannot reach GHIN.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
