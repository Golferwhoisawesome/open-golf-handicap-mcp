# Third-party notices

Open Golf Handicap MCP is independent and unofficial; it is not endorsed by USGA or GHIN. It includes `@spicygolf/ghin` 0.20.1 by Nate Clark and Brad Anderson, https://github.com/boorad/ghin. Its MIT license does not authorize GHIN access or data collection. Live GHIN activation remains disabled; the SDK is currently exercised with synthetic intercepted transport.

The distributed SDK uses a local compatibility adjustment to its package metadata: its Zod dependency is pinned to 4.6.7, and the tested runtime dependency closure is bundled. `scripts/prepare-spicygolf.mjs` verifies the original upstream compiled ESM/CJS SHA-256 hashes before packaging; those compiled files are unchanged. The upstream MIT license is retained. Development prompts, research, examples and environment files are removed from the distributed SDK directory. This project supplies its own provider, transport, lifecycle and response-mapping code; it does not represent those controls as upstream features.

The pinned LICENSE lists Nate Clark; the project README additionally lists Brad Anderson. Both notices are retained below.

MIT License

Copyright (c) 2023 Nate Clark
Copyright (c) 2025 Brad Anderson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Other installed dependencies retain their respective licenses in their npm packages. Review the lockfile and dependency notices before distribution.
