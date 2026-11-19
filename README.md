# Open Golf Handicap MCP

Ask your AI assistant for golf handicaps. This is an [MCP](https://modelcontextprotocol.io) server that signs in to GHIN with **your own account** and looks up Handicap Indexes for you and your friends. It also keeps a private, encrypted roster of the golfers you play with and calculates course handicaps.

> [!WARNING]
> **Unofficial. Not affiliated with, endorsed by or supported by the USGA or GHIN.**
>
> - This tool signs in to GHIN the way the GHIN mobile app does, using the GHIN username and password you enter. The [GHIN Terms of Service](https://www.usga.org/content/usga/home-page/Handicap-ghin/ghin-terms-of-service.html) restrict automated access. **Using this tool may violate them, and GHIN could suspend or close your account.**
> - It only _reads_ handicap data. It never posts scores or changes anything in GHIN.
> - Only look up golfers you have a reason to look up, and respect their privacy.
> - **You use it entirely at your own risk.** The software is provided "as is", without warranty of any kind (see [LICENSE](LICENSE)). The authors are not responsible for any consequences of its use, including account suspension.
>
> The first time you connect, the setup program shows this notice and asks you to type `I UNDERSTAND`.

USGA, GHIN and Handicap Index are trademarks of the United States Golf Association. They are used here only to describe what the software is compatible with.

## What it can do

- "What's my handicap?" / "Look up handicaps for 1234567 and 7654321"
- "Find Alex Smith in North Carolina and add them to my roster"
- "Save Alex, GHIN 1234567, to my roster" (or paste a screenshot of a list and let the assistant read it)
- "Refresh everyone on my roster and tell me who changed"
- "What's Alex's course handicap at a 71.4 / 131 course, par 72?"

Your GHIN password stays on your computer. It's typed into a private terminal window, never into the AI chat, and the AI never sees it.

## Requirements

- macOS, Linux or Windows 10/11
- [Node.js](https://nodejs.org) 22 or later
- An MCP client that runs local servers, such as Claude Desktop, Claude Code, Cursor or Codex
- Your own GHIN account (username/email and password)

## Setup (about two minutes)

### 1. Sign in once

Open a terminal (Terminal on macOS, PowerShell or Windows Terminal on Windows) and run:

```bash
npx -y -p open-golf-handicap-mcp open-golf-handicap-setup login
```

The first time, it shows the notice above and asks you to type `I UNDERSTAND`. Then it asks for your GHIN username and password (nothing appears as you type them). Your GHIN number comes from GHIN's sign-in, so you don't need to enter it. It checks them with GHIN once, then saves them in your computer's own password store:

| System  | Where your login is kept                                                                            |
| ------- | --------------------------------------------------------------------------------------------------- |
| macOS   | Keychain                                                                                            |
| Windows | Encrypted with your Windows account (Data Protection API)                                           |
| Linux   | Your desktop keyring via `secret-tool` (or see [Linux without a keyring](#linux-without-a-keyring)) |

You don't need to do this again unless your GHIN password changes.

### 2. Add it to your AI app

**Claude Code:**

```bash
claude mcp add golf-handicap -- npx -y open-golf-handicap-mcp
```

**Claude Desktop:** Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "golf-handicap": {
      "command": "npx",
      "args": ["-y", "open-golf-handicap-mcp"]
    }
  }
}
```

On Windows use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "open-golf-handicap-mcp"]`. Restart Claude Desktop after saving. **Cursor** uses the same `mcpServers` format in `~/.cursor/mcp.json`.

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.golf_handicap]
command = "npx"
args = ["-y", "open-golf-handicap-mcp"]
```

### 3. Ask

_"What's my golf handicap?"_ The server signs in to GHIN by itself the first time a lookup needs it. There's nothing to keep open.

### Other commands

```bash
npx -y -p open-golf-handicap-mcp open-golf-handicap-setup status        # what's saved, lookups left today
npx -y -p open-golf-handicap-mcp open-golf-handicap-setup logout        # remove your GHIN login (keeps your roster)
npx -y -p open-golf-handicap-mcp open-golf-handicap-setup logout --all  # also forget your roster
```

Your roster and settings live in `~/.open-golf-handicap` (`%USERPROFILE%\.open-golf-handicap` on Windows). Add `--profile DIR` to any command (and to the server's `args`) to use a different folder.

## Tools

| Tool                                                                | What it does                                                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `get_golfer_handicap`                                               | One golfer's Handicap Index, with its effective date and when it was retrieved     |
| `search_golfers`                                                    | Find golfers by last name, first name or both (plus US state) to get a GHIN number |
| `get_multiple_handicaps`                                            | Up to 100 golfers at once; each one succeeds or fails on its own                   |
| `get_course_handicap`                                               | Course handicap from an index plus course rating, slope and par (9 or 18 holes)    |
| `save_golfer` / `save_multiple_golfers`                             | Add golfers to your roster (bulk import asks you to confirm first)                 |
| `get_saved_golfers` / `update_saved_golfer` / `remove_saved_golfer` | Manage your roster                                                                 |
| `refresh_saved_handicaps`                                           | Re-check everyone (or selected golfers) and show what changed                      |
| `get_handicap_changes`                                              | Changes this tool has observed over a period                                       |
| `export_golfer_roster` / `delete_golfer_roster`                     | Export your roster as JSON / delete it (asks you to confirm)                       |
| `get_connection_status` / `disconnect_provider`                     | Connection details and limits / end the GHIN session                               |

Plus indexes are shown with a `+` (for example `+0.9`). A missing value is reported as unavailable, never as zero.

## Built-in limits

This tool deliberately keeps GHIN traffic low. These limits are this project's own choices, not quotas published by GHIN:

- At least 2 seconds between requests to GHIN
- At most 60 GHIN lookup requests per session, and 200 lookups plus 10 sign-ins per rolling 24 hours (one lookup request can cover up to 100 golfers)
- A failed request is retried at most once
- If GHIN says "slow down" (HTTP 429), lookups pause for as long as GHIN asks (at least 1 minute, or 15 minutes if it doesn't say), even across sessions
- If GHIN refuses access (HTTP 403), lookups stop until you sign in again with `login`
- Results are cached for 1 hour. Nothing refreshes in the background.

## Privacy and security

- Your GHIN password is typed only into the setup command in your terminal. It is never passed through the AI chat, command-line arguments, environment variables or the AI app's config.
- It is stored in your operating system's password store (see the table above), together with the key that encrypts your roster.
- Your roster is encrypted on disk (AES-256-GCM) in a folder only your user account can access.
- Nothing is sent anywhere except GHIN's own servers (and Google's Firebase service, which the GHIN app uses during sign-in). There is no telemetry and no central server.
- The AI app you use does see the handicap results and roster names you ask about. Its provider's privacy policy applies to that.

More detail is in [SECURITY.md](SECURITY.md) and [docs/security-model.md](docs/security-model.md).

## Try it without a GHIN account

Without a saved login, the server runs in demo mode with synthetic golfers `900000001` through `900000005`. Add `--demo` to the server's `args` to force demo mode. Demo data is fake; never use it for a real competition.

## Troubleshooting

| Problem                                         | Fix                                                                                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assistant says GHIN sign-in is needed           | Run the `login` command in a terminal, then restart your AI app                                                                                          |
| Assistant only shows demo golfers               | No login was found when the AI app started. Run `login`, then restart the AI app                                                                         |
| `PRIVATE_INPUT_REQUIRED`                        | Run `login` in a real terminal window (Terminal, iTerm, Windows Terminal), not inside an AI tool or an IDE output pane                                   |
| Sign-in fails                                   | Check your username and password in the GHIN app first.                                                                                                  |
| `RATE_LIMITED`                                  | You reached this tool's daily limit, or GHIN asked it to slow down. `status` shows when it resets                                                        |
| macOS asks to allow access to the Keychain item | Click **Always Allow** so the server can read your saved login                                                                                           |
| Client can't find `npx`                         | Desktop apps may not see your shell's PATH (common with nvm). Use the full path from `which npx` (macOS/Linux) or `where npx` (Windows) as the `command` |
| `PROFILE_INVALID`                               | The profile folder's permissions were changed or it is a link. Use a folder inside your home directory that only you can access                          |

### Linux without a keyring

On a server or minimal desktop without `secret-tool`, set `OGH_CREDENTIAL_STORE=file` for both the `login` command and the server (in your AI app's config `env`). The login is then kept in `~/.open-golf-handicap/credentials.json`, readable only by your account.

## Development

```bash
npm ci --ignore-scripts
npm run check          # typecheck, tests, build
npm run test:package   # install the packed package in a clean directory and smoke-test it
```

Tests never contact GHIN. They use synthetic credentials and intercepted HTTP responses. See [CONTRIBUTING.md](CONTRIBUTING.md).

This project uses the MIT-licensed [@spicygolf/ghin](https://www.npmjs.com/package/@spicygolf/ghin) client (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## License

[MIT](LICENSE). The license covers this code only. It does not grant any right to access GHIN.
