# CLAUDE.md

Guidance for working on this repo. Read once at the start of a session.

## What this is

**Price Tracker** — Firefox WebExtension, Manifest V3, TypeScript,
published on AMO:
https://addons.mozilla.org/en-US/firefox/addon/firefox-price-tracker/

Owner: `exzzy`. Add-on ID: `Firefox-Price-Tracker@exzzy22`. Public
GitHub repo. Ships on Firefox desktop and Firefox for Android (Fenix
142+ via `gecko_android` in the manifest).

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
    price.ts                  Price detection + parsing (structured data first)
    kwstore.ts                KW store: prices from its JSON endpoints (page HTML has none)
    dmstore.ts                dm: prices from dm's product API (page HTML has none)
    tracking.ts               Pure bookkeeping: history, pending-price confirm, import validation
    url.ts                    Product identity (productKey) + tracking-param cleanup
    format.ts                 Display helpers: currency formatting, titles, % change, times
    dom.ts                    UI helpers: element builder, inline SVG icons, charts
    types.ts                  Storage + message types
  background.ts               Event page: alarms, fetches, notifications; sole writer of `tracked`
  content_script.ts           Top-frame only: detect + manual-pick picker
  popup.ts + popup.html       Browser-action popup
  details.ts + details.html   Full-page dashboard (list, history, settings, backup)
  styles.css                  Single shared stylesheet
icons/                        Extension icons
screenshots/                  README images; screenshots/amo/ = 1280x800 store images
tests/*.test.ts               Unit tests (node:test + happy-dom via tsx)
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

### Price detection is structured-data-first

`findPriceOnPage` in [src/lib/price.ts](src/lib/price.ts) only accepts a
price from these sources, in this order:

1. An explicit user-picked selector (`TrackedItem.selector`).
2. A site rule (`SITE_RULES`): Amazon, Target, Newegg, MediaMarkt/Saturn,
   ekupi.hr, Svijet medija, Emmezeta, ASOS.
   Each rule is gated on hostname **and** a page signal. Amazon reads only
   the buy box (`AMAZON_SELECTORS`) — never a bare `.a-price`, which also
   matches recommendation carousels — and builds the value from
   `.a-price-whole`/`.a-price-fraction` because `.a-offscreen` sometimes
   drops the decimal point ("EUR1842" for €18.42). Site rules run on both
   the raw HTML (background) and the rendered DOM (content script), so they
   must pick the same price in both: Newegg inserts a collapsed "Buy Used"
   pane after load, and Emmezeta's JSON-LD (also added after load) reports
   the login-only Klub price — the rules skip both. A rule may use
   `extract(doc, pageUrl)` instead of selectors when the price only exists
   in inline script data (ASOS: `stockPriceResponse`).
3. JSON-LD `Product`/`ProductGroup` (via `@graph`, `mainEntity`,
   `BuyAction.object`; `ProductGroup.hasVariant` picks the variant in the
   URL). `ItemList` members are ignored (category pages).
4. Microdata inside an `itemscope itemtype*="Product"` scope.
5. Meta tags: `product:sale_price:amount` while its sale dates are
   current, then `product:price:amount` / `og:price:amount`.
6. WooCommerce: `form.cart` **plus** `.woocommerce-Price-amount`.
7. Generic DOM selectors (`GENERIC_PRICE_SELECTORS`: `[itemprop=price]`,
   Magento `data-price-amount`, PrestaShop, Shopify Dawn, `data-test*=
   product-price`, …) — only when `isProductPage` is true, only with a
   currency marker in the text, and **not** when a site rule matched.
8. Last resort: a JSON-LD `AggregateOffer` **range** (`lowPrice` of many
   variants). HSN publishes the cheapest of 100+ variants here, which is not
   the price on the page, so it must never beat sources 4–7.

There is **no body-text currency fallback**. If you add one you will
reintroduce the news-article false-positive bug. The regression tests are in
[tests/price.test.ts](tests/price.test.ts) ("returns null for a non-product
page with currency text", "generic fallback never runs on non-product
pages").

Every hit carries `currency` (ISO 4217) when known — from structured data or
an unambiguous symbol (`€`, `£`, `zł`, …; never `$`, `¥`, `kr`). The UI
formats with `Intl.NumberFormat` when the currency is known and falls back to
the site's own text otherwise ([src/lib/format.ts](src/lib/format.ts)).

Number parsing (`cleanNumber`) treats a lone separator followed by exactly
three digits as a thousands separator ("$1,299" → 1299, "1.299 €" → 1299).
Machine values from structured data go through `parseMachineNumber`, which
keeps "1.299" as 1.299.

### Price changes are confirmed before they are recorded

A background check that sees a new price stores it in `TrackedItem.pending`
instead of committing it, and schedules the `confirmPrices` alarm. Only when a
later check (at least `CONFIRM_MIN_AGE_MS` after the first sighting) sees the
same price is it committed to history and notified. If the old price comes
back, the pending value is dropped silently. This exists because some shops
briefly serve wrong prices (CDN caches a few minutes stale, daily flash-sale
boundaries at HSN), which used to produce false notifications. The logic is
pure and unit-tested in [src/lib/tracking.ts](src/lib/tracking.ts) /
[tests/tracking.test.ts](tests/tracking.test.ts).

Prices are compared at cent precision (`PRICE_EPSILON = 0.005`), so
"19.701001" and "19.70" are the same price.

### JS-rendered pages

Some sites render prices client-side; the background `fetch()` only sees
the raw HTML. `findPriceInHtml` returns null in that case and
[src/background.ts](src/background.ts) increments `failedChecks` and records
`lastError` ("No price in page", "Blocked by the site", "HTTP 403", …). Two
consecutive failures surface as a warning with that reason in the popup and
dashboard.

The content script compensates: on product pages (or pages with a tracked
selector) it watches DOM mutations for up to 8s, waits until the detected
price has been **stable for 1.5s**, and sends a `visitUpdate` message. The
background treats it like an observation: for items it can't read itself
(`failedChecks >= 2`) it commits directly; otherwise it goes through the
pending/confirm path. Visit-originated changes never notify.

A shop whose pages never carry the price in their HTML can get a site
resolver that asks the shop's own JSON endpoints instead:
[src/lib/kwstore.ts](src/lib/kwstore.ts) for the KW store's configurator
(`store.kwautomotive.de/<store-view>/shop?c_car=…&pgs=…&ag=…`) and
[src/lib/dmstore.ts](src/lib/dmstore.ts) for dm (`dm.<tld>/p/d/<dan>/…`).
`apiReader()` in the background routes matching URLs there and skips the
HTML fetch. Resolvers take an injected `fetchJson` so they're unit-testable
without a browser. A generic fallback (re-rendering pages in a background
tab) was considered and rejected: visible tab flashes, history entries, and
full page loads with trackers on every check.

Before adding a resolver, test it from a real extension in Firefox, not just
curl: Firefox sends `Origin: moz-extension://…` on the extension's POST
requests (not on GETs), and some APIs reject that origin (dm's does; it is
only usable because the resolver GETs). Some shops (Kaufland, Alza) answer
the background's fetch with 403 even right after the user visited them;
those stay visit-updated.

### The background is the only writer of `tracked`

Popup, dashboard and content script send messages (`trackItem`,
`removeItem`, `visitUpdate`, `manualSelectResult`, `importItems`) instead of
writing storage. The background serializes every read-modify-write through
`withTracked()`, and `checkAll` fetches outside the lock and applies results
to a fresh copy, so a slow check can't resurrect a removed item or drop one
added meanwhile. Settings (`checkIntervalMinutes`, `notifyOn`) are still
written directly by the dashboard; the background reacts via
`storage.onChanged`.

Background fetches use `credentials: 'include'` so the shop sees the same
session/region/currency preferences as the user's own visits (Amazon shows a
different currency otherwise), plus a 20s timeout and `cache: 'no-cache'`.

`ensureAlarm()` runs on every wake-up: alarms aren't guaranteed to survive a
browser restart, and the period must follow the user's interval (capped at
60 min; items are still skipped until due).

### Content scripts see page objects through Xray wrappers

In Firefox content scripts, iterators returned by page objects such as
`URLSearchParams.entries()` are **not iterable** ("… is not iterable"). Parse
query strings by hand (`queryParts` in [src/lib/url.ts](src/lib/url.ts)) and
copy DOM collections with `Array.prototype.slice.call`. Unit tests run in
Node and can't catch this — test content-script paths in a real Firefox.

### Storage schema (`browser.storage.local`)

See [src/lib/types.ts](src/lib/types.ts) for the canonical types. Summary:

- `tracked: TrackedItem[]` — the user's watched products (includes
  optional `image`, `failedChecks`, `currency`, `lastError`, `addedAt`,
  `pending`, `quietNextChange` — set by the v0.4 migration so the first
  post-upgrade re-reading doesn't notify)
- `checkIntervalMinutes: number` — global, default 60
- `notifyOn: 'any' | 'drop'` — notification filter, default `'any'`
- `badgeCount: number` — unread price-change notifications
- `lastRunAt: number` — end of the last background check (UI "checked …")
- `normalizedV2: boolean` — migration flag; do not reuse this key
- `normalizedV3: boolean` — migration flag (thousands-separator re-parse +
  currency backfill); do not reuse this key
- `lastDetected: LastDetected` — written by content script on product pages only

Storage is **device-local** (not synced across Firefox accounts). Adding
sync would require fitting in `storage.sync`'s 100 KB / 8 KB-per-key
quota; price history makes that hard, so we intentionally don't. The
dashboard's Export/Import (JSON backup, validated by `sanitizeImported`) is
the way to move data between devices.

### Message contract (`browser.runtime.sendMessage`)

The `Message` discriminated union in [src/lib/types.ts](src/lib/types.ts)
is the source of truth. Adding a new action: add a variant there, then
handle it in background/content script. Anything that changes `tracked`
must be a background message (see above).

## Dev workflow

```
npm install          # once, or after changing devDependencies
npm run typecheck    # tsc --noEmit
npm test             # node:test + tsx: detection, url, format, tracking logic
npm run build        # esbuild → dist/
npm run lint         # web-ext lint dist/
npm start            # build + web-ext run — opens a Firefox profile
npm run package      # build + produce build/price_tracker-<version>.zip
```

`npm run build:watch` keeps esbuild running on file change (useful with
`npm start` in another terminal, reloading the extension manually).

### Testing on Android

1. Enable USB debugging + "Remote debugging via USB" in Firefox Android
   (Settings → Advanced).
2. Connect over ADB (USB or Wi-Fi): `adb connect <ip>:<port>`.
3. Run:
   ```
   npx web-ext run --target=firefox-android \
     --adb-device <id> --firefox-apk org.mozilla.firefox \
     --source-dir dist
   ```
4. From desktop `about:debugging` → the phone → Inspect the extension for
   a remote console on the background event page.

The picker (`startPicker` in [src/content_script.ts](src/content_script.ts))
switches to tap-then-confirm via `matchMedia('(pointer: coarse)')`; desktop
uses hover + click. Its UI lives in a closed shadow root so page CSS can't
touch it.

Use a separate add-on id for device testing (edit the id in a scratch copy
of `dist/manifest.json`): a temporary install with the published id shares
`storage.local` with the user's real data. Firefox for Android blocks
screenshots of private tabs unless "Allow screenshots in private browsing"
is on, and price notifications need Android's notification permission for
Firefox.

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
  `element.hidden` (a global `[hidden] { display: none !important }` keeps
  component `display` rules from overriding it). The one exception is the
  content-script picker overlay, which positions its highlight box inline
  inside its own shadow root.
- No `innerHTML` in extension pages; build DOM with `h()` from
  [src/lib/dom.ts](src/lib/dom.ts). Icons are inline SVG paths there.
- Don't swallow errors silently. Either handle them or let them throw;
  only catch when you can produce a better outcome than "crash".
- Keep the content script cheap. It runs on every page.
