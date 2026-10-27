# Contributing to NetLens

## Quick start

```bash
npm install
npm run dev      # local dev server
npm run build    # type-check + production build (output: dist/)
npm test         # Vitest unit tests (pure logic only, no network)
```

The production build is copied to `docs/` so GitHub Pages can serve it at https://judd69.github.io/netlens/.

## How to contribute

1. Fork, branch from `main`, one focused change per PR.
2. Keep tests pure-logic — no network in the test suite.
3. In the PR, say what changed, how to reproduce/verify it, and include a screenshot for UI changes.
4. Be honest about API limits: NetLens uses keyless public APIs (Google DNS-over-HTTPS, ipwho.is, ipify) and must surface their errors plainly, never fake a record.

## License

MIT — by contributing, you agree your work is released under the MIT license.
