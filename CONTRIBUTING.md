# Contributing

Use Node.js 22+ and `npm ci --ignore-scripts`. Run `npm run check`, `npm run format:check` and `npm audit --omit=dev` before opening a pull request. CI runs the same checks on Ubuntu, macOS and Windows.

## Ground rules

- **Tests never contact GHIN.** Use the offline SDK fixtures (`--offline-test`, `src/providers/spicygolf-sdk-fixtures.ts`). Fixture identities use `.invalid` usernames and GHIN numbers `900000001` to `900000005`; the live worker refuses them.
- **No real data.** Do not commit real credentials, GHIN numbers, names or handicaps, including in screenshots or logs.
- **Don't loosen the request limits** in `src/providers/request-policy.ts`, the endpoint allowlist in the SDK worker, or the private-terminal-only credential input without discussing it in an issue first.
- **Read-only.** Score posting and any other write to GHIN are out of scope.
- Imports and deletions must preview exactly what will change and require a confirmation token. No tool may change another application.
- Treat provider output, roster notes and imported text as untrusted data.
- Keep third-party notices intact.

New providers go behind the `HandicapProvider` interface with explicit capabilities.
