# CLAUDE.md

Guidance for working on this repo. Read once at the start of a session.

## What this is

**Price Tracker** — Firefox WebExtension, Manifest V3, TypeScript,
published on AMO:
https://addons.mozilla.org/en-US/firefox/addon/firefox-price-tracker/

Owner: `exzzy`. Add-on ID: `Firefox-Price-Tracker@exzzy22`. Public
GitHub repo.

It detects a product price on the current page, lets the user track it,
and notifies them when the price changes.

## Ground rules for changes

- **This is a published add-on.** Every change has to land on users as a
  silent upgrade. Assume users have data in `browser.storage.local`.
  - Never break the storage schema (see `TrackedItem` in
    [src/lib/types.ts](src/lib/types.ts)). Add fields, don't rename or
    drop.
  - For unavoidable schema changes, write a one-shot migration keyed by
    a new flag (see `MIGRATION_FLAG` in
    [src/background.ts](src/background.ts) for the pattern).
- **Don't add new permissions unless required.** New permissions trigger
  a scary upgrade prompt and may require AMO re-review. Current set is
  intentionally minimal.
- **No remote assets.** No CDN fonts/CSS/scripts. AMO review frowns on
  them and they break under strict CSP.
- **No telemetry / analytics.** The manifest declares
  `data_collection_permissions.required: ["none"]` — keep that true.
- **Don't broaden content script scope** (e.g. `all_frames: true`,
  `run_at: "document_start"`). It runs on every page the user visits.
- **Public repo.** No secrets, no PII, no hardcoded identifiers beyond
  what's already in the public `manifest.json`.

## Repository layout

```
manifest.json                 Source-of-truth manifest (paths prefixed with dist/)
tsconfig.json                 Strict TS, targets ES2022 + DOM
build.mjs                     esbuild bundler + static-asset copier
package.json                  Scripts + devDependencies
src/
  lib/
    price.ts                  Price parsing (structured-data only)
    types.ts                  Storage + message types
  background.ts               Event-page: alarms, fetches, notifications
  content_script.ts           Top-frame only: detect + manual-pick picker
  popup.ts + popup.html       Browser-action popup
  details.ts + details.html   Full-page tracked-items view
  styles.css                  Single shared stylesheet
icons/                        Extension icons
tests/price.test.ts           Unit tests (node:test + happy-dom via tsx)
dist/                         Build output — gitignored, what actually ships
build/                        web-ext packaged zip — gitignored
.github/workflows/release.yml GitHub Release pipeline (no AMO step)
```

### Build model

Nothing at repo root is shipped to the browser. `npm run build` runs
[build.mjs](build.mjs) which:

1. Cleans and recreates `dist/`.
2. Bundles each TS entry point (`background`, `content_script`, `popup`,
   `details`) to a single IIFE JS file via esbuild. Each bundle inlines
   its imports from `src/lib/` so the extension ships exactly four
   JS files.
3. Copies `src/*.html`, `src/styles.css`, and `icons/` into `dist/`.
4. Reads the root `manifest.json`, strips `dist/` prefixes, and writes
   `dist/manifest.json`. That's the manifest the browser loads.

`web-ext run|build|lint --source-dir dist` treats `dist/` as the
extension root.

## Key invariants

### Price detection is structured-data-only

The content script (and the background HTML parser) only accept a price
when at least one of these signals exists on the page:

1. An explicit user-picked selector (`TrackedItem.selector`).
2. A known Amazon product container + Amazon selectors.
3. JSON-LD with `Product` / `Offer`.
4. Microdata inside an `itemscope itemtype*="Product"` scope.
5. `<meta property="product:price:amount">` or equivalent.
6. `[itemprop=price]` **plus** a page-level product signal from
   `isProductPage`.

There is **no body-text currency fallback**. If you add one you will
reintroduce the news-article false-positive bug that this rewrite
deliberately removed. The regression test is in
[tests/price.test.ts](tests/price.test.ts) — "findPriceOnPage: returns
null for a non-product page with currency text".

### Storage schema (`browser.storage.local`)

See [src/lib/types.ts](src/lib/types.ts) for the canonical types. Summary:

- `tracked: TrackedItem[]` — the user's watched products
- `checkIntervalMinutes: number` — global, default 60
- `badgeCount: number` — unread price-change notifications
- `normalizedV2: boolean` — migration flag; do not reuse this key
- `lastDetected: LastDetected` — written by content script on product pages only

### Message contract (`browser.runtime.sendMessage`)

The `Message` discriminated union in [src/lib/types.ts](src/lib/types.ts)
is the source of truth. Adding a new action: add a variant there, then
handle it in background/content script.

## Dev workflow

```
npm install          # once, or after changing devDependencies
npm run typecheck    # tsc --noEmit
npm test             # node:test + tsx, exercises price.ts end-to-end
npm run build        # esbuild → dist/
npm run lint         # web-ext lint dist/
npm start            # build + web-ext run — opens a Firefox profile
npm run package      # build + produce build/price_tracker-<version>.zip
```

`npm run build:watch` keeps esbuild running on file change (useful with
`npm start` in another terminal, reloading the extension manually).

## Release

CI in [.github/workflows/release.yml](.github/workflows/release.yml)
runs typecheck + tests + lint + build, then attaches the zip to a
GitHub release. **AMO submission is manual** — upload the zip from the
GitHub release through https://addons.mozilla.org/developers/ so each
version gets an explicit listing review.

Triggers:
- push a `v*` tag → release fires automatically
- `workflow_dispatch` with a `tag` input → manual run from the Actions
  tab

Bump both `manifest.json` version **and** `package.json` version
together before tagging. AMO rejects re-uploads with the same version.

## Conventions

- TypeScript, strict mode. No frameworks, no runtime deps — just
  esbuild/tsx/happy-dom in `devDependencies`.
- Single stylesheet. Design tokens live in `:root`; dark mode via
  `prefers-color-scheme`. No inline styles in TS beyond
  `element.hidden`.
- Don't swallow errors silently. Either handle them or let them throw;
  only catch when you can produce a better outcome than "crash".
- Keep the content script cheap. It runs on every page.
