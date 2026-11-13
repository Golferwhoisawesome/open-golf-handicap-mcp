# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button on this repository's Security tab. Do not open a public issue for security problems.

Never include passwords, tokens, GHIN numbers or other real golfer information in reports, issues or pull requests. Synthetic reproductions are fine.

## Supported versions

Only the latest published version receives fixes.

## Scope

In scope: credential handling, the private terminal prompts, the profile vault and roster encryption, the local session channel (Unix socket / Windows named pipe), the SDK worker's endpoint allowlist and request limits, and MCP tool input handling.

Out of scope: whether using GHIN through this tool is permitted (see the warning in the [README](README.md)), vulnerabilities in GHIN itself, and attacks that need code already running as your OS user.

The design and its limits are described in [docs/security-model.md](docs/security-model.md).
