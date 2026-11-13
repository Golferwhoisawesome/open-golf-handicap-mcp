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
- "Save Alex, GHIN 1234567, to my roster" (or paste a screenshot of a list and let the assistant read it)
- "Refresh everyone on my roster and tell me who changed"
- "What's Alex's course handicap at a 71.4 / 131 course, par 72?"

Your GHIN password stays on your computer. It's typed into a private terminal window, never into the AI chat, and the AI never sees it.

## Requirements

- macOS, Linux or Windows 10/11
- [Node.js](https://nodejs.org) 22 or later
- An MCP client that runs local servers, such as Claude Desktop, Claude Code, Cursor or Codex
- Your own GHIN account (username/email and password) and your GHIN number

## Quick start

### 1. Create your private profile (one time)

Pick a folder for your encrypted profile. The examples use `~/.open-golf-handicap` (on Windows, `%USERPROFILE%\.open-golf-handicap`).

macOS / Linux:

```bash
npx -y -p open-golf-handicap-mcp open-golf-handicap-setup init --profile ~/.open-golf-handicap
```

Windows (PowerShell):

```powershell
npx -y -p open-golf-handicap-mcp open-golf-handicap-setup init --profile "$env:USERPROFILE\.open-golf-handicap"
```

Choose a **vault passphrase**. It encrypts your roster and any saved login on this computer. It is not your GHIN password. There is no way to recover it, so keep it somewhere safe.

### 2. Sign in to GHIN (each time you want to use it)

In a terminal you can leave open:

```bash
npx -y -p open-golf-handicap-mcp open-golf-handicap-setup connect-ghin --profile ~/.open-golf-handicap
```

(On Windows, use the same `--profile "$env:USERPROFILE\.open-golf-handicap"` path.)

The first time, read the notice and type `I UNDERSTAND`. Then enter your vault passphrase, GHIN username, GHIN password and your own GHIN number. Nothing is shown as you type the secrets.

**Leave this window open while you use your assistant.** A session lasts up to one hour. Press Ctrl-C to end it early.

To avoid retyping your GHIN password, add `--remember-login` once. Your login is then kept in the encrypted vault, and later sessions only need:

```bash
npx -y -p open-golf-handicap-mcp open-golf-handicap-setup resume-ghin --profile ~/.open-golf-handicap
```

To remove a saved login: `open-golf-handicap-setup disconnect-ghin --profile ~/.open-golf-handicap`.

### 3. Add it to your AI assistant

Use the **full path** to your profile folder (`~` is not expanded in JSON).

**Claude Desktop:** edit `claude_desktop_config.json` (Settings → Developer → Edit Config).

macOS / Linux:

```json
{
  "mcpServers": {
    "golf-handicap": {
      "command": "npx",
      "args": [
        "-y",
        "open-golf-handicap-mcp",
        "--ghin",
        "--profile",
        "/Users/you/.open-golf-handicap"
      ]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "golf-handicap": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "open-golf-handicap-mcp",
        "--ghin",
        "--profile",
        "C:\\Users\\you\\.open-golf-handicap"
      ]
    }
  }
}
```

Restart Claude Desktop after saving. **Cursor** uses the same `mcpServers` format in `~/.cursor/mcp.json`.

**Claude Code:**

```bash
claude mcp add golf-handicap -- npx -y open-golf-handicap-mcp --ghin --profile /Users/you/.open-golf-handicap
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.golf_handicap]
command = "npx"
args = ["-y", "open-golf-handicap-mcp", "--ghin", "--profile", "/Users/you/.open-golf-handicap"]
```

Start the GHIN session (step 2) **before** opening a new chat, then ask: _"Check my golf handicap connection."_

## Tools

| Tool                                                                | What it does                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `get_golfer_handicap`                                               | One golfer's Handicap Index, with its effective date and when it was retrieved  |
| `get_multiple_handicaps`                                            | Up to 100 golfers at once; each one succeeds or fails on its own                |
| `get_course_handicap`                                               | Course handicap from an index plus course rating, slope and par (9 or 18 holes) |
| `save_golfer` / `save_multiple_golfers`                             | Add golfers to your roster (bulk import asks you to confirm first)              |
| `get_saved_golfers` / `update_saved_golfer` / `remove_saved_golfer` | Manage your roster                                                              |
| `refresh_saved_handicaps`                                           | Re-check everyone (or selected golfers) and show what changed                   |
| `get_handicap_changes`                                              | Changes this tool has observed over a period                                    |
| `export_golfer_roster` / `delete_golfer_roster`                     | Export your roster as JSON / delete it (asks you to confirm)                    |
| `get_connection_status` / `disconnect_provider`                     | Connection details and limits / end the GHIN session                            |
| `get_handicap_history` / `get_recent_scores`                        | Not available with GHIN yet (demo data only)                                    |

Plus indexes are shown with a `+` (for example `+0.9`). A missing value is reported as unavailable, never as zero.

## Built-in limits

This tool deliberately keeps GHIN traffic low. These limits are this project's own choices, not quotas published by GHIN:

- At least 2 seconds between requests to GHIN
- At most 60 GHIN lookup requests per session, and 200 lookups plus 10 sign-ins per rolling 24 hours (one lookup request can cover up to 100 golfers)
- A failed request is retried at most once
- If GHIN says "slow down" (HTTP 429), lookups pause for as long as GHIN asks (at least 1 minute, or 15 minutes if it doesn't say), even across sessions
- If GHIN refuses access (HTTP 403), lookups stop until you sign in again with `connect-ghin`
- Results are cached for 1 hour. Nothing refreshes in the background.

## Privacy and security

- Your GHIN password is entered only in the private terminal. It is never passed through the AI chat, command-line arguments, environment variables or MCP configuration.
- By default your login lives only in memory for the session. `--remember-login` stores it encrypted in your profile vault.
- Your roster is encrypted on disk (AES-256-GCM) in a folder only your user account can access.
- The MCP server process never receives your GHIN credentials. It gets only lookup results, through a private local channel to the setup terminal.
- Nothing is sent anywhere except GHIN's own servers (and Google's Firebase service, which the GHIN app uses during sign-in). There is no telemetry and no central server.
- The AI assistant you use does see the handicap results and roster names you ask about. Its provider's privacy policy applies to that.

More detail is in [SECURITY.md](SECURITY.md) and [docs/security-model.md](docs/security-model.md).

## Try it without a GHIN account

Run the server without `--ghin` to get a demo mode with synthetic golfers `900000001` through `900000005`:

```json
{ "command": "npx", "args": ["-y", "open-golf-handicap-mcp"] }
```

Demo data is fake. Never use it to update a real competition.

## Troubleshooting

| Problem                                                   | Fix                                                                                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assistant says "Unlock the local profile" / auth required | Start `connect-ghin` or `resume-ghin` and keep that window open, then start a new chat or restart the client                                             |
| `PRIVATE_INPUT_REQUIRED`                                  | Run setup in a real terminal window (Terminal, iTerm, Windows Terminal), not from inside an AI tool or an IDE output pane                                |
| `PROFILE_INVALID`                                         | The profile folder's permissions were changed or it is a link. Use a folder inside your home directory that only you can access                          |
| Sign-in fails                                             | Check your GHIN username and password in the GHIN app first. The number you enter must be your own GHIN number                                           |
| `RATE_LIMITED`                                            | You hit this tool's daily limit or GHIN asked it to slow down. Wait and try later                                                                        |
| Session ended after an hour                               | Sessions are capped at one hour. Run `resume-ghin` (if you used `--remember-login`) or `connect-ghin` again                                              |
| Client can't find `npx`                                   | Desktop apps may not see your shell's PATH (common with nvm). Use the full path from `which npx` (macOS/Linux) or `where npx` (Windows) as the `command` |
| Path too long (macOS/Linux)                               | Unix socket paths are limited to about 100 characters. Use a shorter profile path such as `~/.open-golf-handicap`                                        |

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
