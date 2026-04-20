# Firefox Price Tracker

A Firefox WebExtension that lets you track product prices and notifies you
when they change.

**Published on AMO:**
https://addons.mozilla.org/en-US/firefox/addon/firefox-price-tracker/

## Features

- Click the toolbar icon on any product page — if a price is found it's
  shown inline, one click tracks it.
- Structured-data-only detection (JSON-LD `Product`, microdata,
  OpenGraph `product:price:amount`, site-specific Amazon selectors).
  Pages without a real product price are reported as such instead of
  false-positive matches on any `$…` text.
- Manual element picker for cases the auto-detector doesn't cover.
- Background checks every 60 minutes (configurable). Change →
  notification + toolbar badge.
- Per-item price history.
- No tracking, no analytics, no remote resources.

## Installation

End users: install from the AMO link above.

## Development

Requirements: Node 20+ and a modern Firefox.

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # unit tests (price parsing, no browser needed)
npm run build       # bundle TypeScript → dist/
npm run lint        # web-ext lint dist/
npm start           # build + launch Firefox with the extension loaded
npm run package     # build + produce build/price_tracker-<version>.zip
```

`npm run build:watch` keeps esbuild running on file change — useful
alongside `npm start` when iterating, reloading the extension manually
from `about:debugging`.

For manual testing you can also open `about:debugging#/runtime/this-firefox`
and "Load Temporary Add-on" → pick `dist/manifest.json` after running
`npm run build`.

## Architecture

See [CLAUDE.md](CLAUDE.md) for a full tour. Short version:

```
manifest.json           Source-of-truth manifest (paths prefixed with dist/)
tsconfig.json           Strict TypeScript config (ES2022 + DOM)
build.mjs               esbuild bundler + static-asset copier
src/
  lib/
    price.ts            Price parsing (structured-data only)
    types.ts            Storage + message types
  background.ts         Alarms, fetches, notifications
  content_script.ts     In-page detection + manual-pick overlay
  popup.html + popup.ts Browser-action popup
  details.html + details.ts  Full-page tracked-items view
  styles.css            Single shared stylesheet
tests/price.test.ts     Unit tests (node:test + happy-dom via tsx)
dist/                   Build output — gitignored, what actually ships
```

Storage format, message contract, and release instructions are all
documented in [CLAUDE.md](CLAUDE.md).

## License

MIT — see [LICENSE](LICENSE). Please keep the copyright notice when
redistributing and reference this repository so others can find the
original project.
