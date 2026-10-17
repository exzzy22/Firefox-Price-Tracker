# Changelog

All notable changes to Price Tracker are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Price detection for ekupi.hr, Svijet medija, Emmezeta and ASOS. Emmezeta
  tracks the price everyone pays (regular or clearance), not the login-only
  Klub price.

### Fixed

- KW Automotive store (`store.kwautomotive.de`) and dm (dm.hr, dm.de, …):
  their pages render the price with JavaScript, so background checks always
  failed and the price only updated when the page was opened. Background
  checks now read the price from the shops' own price APIs.
- Newegg: tracking from the popup could save the "Buy Used" price, followed
  by a false "price went up" notification when the next background check
  read the new price.

## [0.4.0] — 2026-09-28

### Added

- Currency-aware prices: every detected price carries its ISO currency where
  the page states it, and prices are shown in your locale's format
  (`$1,299.00`, `1.299,00 €`) instead of bare numbers like `1299.0`.
- Detection for schema.org `ProductGroup` variants (H&M, Zara, Gymshark,
  Sephora…), JSON-LD nested in `BuyAction` / `mainEntity`, sale prices in
  `product:sale_price:*` meta tags, Magento, PrestaShop and Shopify Dawn
  price markup, and site rules for Target, Newegg and MediaMarkt/Saturn.
- Price-change confirmation: a new price is recorded and notified only after
  a second check a few minutes later sees it too. Prices a shop serves for a
  moment (stale caches, flash-sale boundaries) no longer cause false alerts.
- "Notify me: only when a price drops" setting.
- Dashboard: search, sorting, change badges (vs previous price and since
  added), low/high, sparklines, a price-history chart per item, per-item
  "Check", stats, and interval presets from 15 minutes to 24 hours.
- JSON backup export/import (works on Android too).
- The reason an item can't be checked ("Blocked by the site", "HTTP 403",
  "No price in page") is shown next to it.

### Changed

- Redesigned popup and dashboard (same blue palette): product thumbnails,
  clean titles without shop-name suffixes, "Tracked" state for the current
  page, two-step remove, better phone layout.
- The manual picker shows a live price preview, works in a shadow-DOM
  overlay that page styles can't break, saves sturdier selectors, and
  confirms with a toast. On Android the bar moves out of the way of the
  selected price.
- The same product reached through different links (tracking parameters,
  Amazon `/ref=` paths) is recognised as one item; new items are stored
  without tracking parameters.
- Background checks run up to three pages in parallel with a 20s timeout,
  send the shop's cookies so region/currency match your own visits, and
  never overwrite items added or removed while a check is running.

### Fixed

- Amazon: prices were sometimes taken from recommendation carousels when the
  item had no buy box, and hidden prices without a decimal point were read
  as 100× too high ("EUR1842" → €1842 instead of €18.42).
- Prices written with a thousands separator and no decimals were parsed
  1000× too low (`$1,299` → 1.299, `1.299 €` → 1.299). Stored prices are
  re-parsed once on upgrade (`normalizedV3`). Where the improved detector
  reads a different price than 0.3.x stored, the first confirmed reading after
  the update is recorded without a notification.
- Stores whose structured data only lists a range across many variants
  (e.g. HSN) tracked the cheapest variant instead of the shown price.
- Visiting a page could silently overwrite the price while a background
  check disagreed, which produced repeated "price changed" notifications.
- The check interval never went below 60 minutes, and checks could stop
  after a browser restart until the extension was reinstalled.
- Tracked items weren't recognised by the content script on some pages
  (a Firefox content-script quirk with URL iterators).

## [0.3.1] — 2026-07-09

### Changed

- Reverted the interface to the original blue colour scheme. The amber palette
  introduced in 0.3.0 has been removed and `src/styles.css` is byte-identical
  to its 0.2.0 state.

Click-to-open on price-change notifications, added in 0.3.0, is unaffected.

## [0.3.0] — 2026-07-09

### Added

- Clicking a price-change notification now opens the tracked product page in a
  new tab, on both Firefox desktop and Firefox for Android. The product URL is
  encoded in the notification id, so it still resolves after the background
  event page has been suspended and respawned. No new permissions were needed —
  `notifications` and `tabs` were already granted.

### Changed

- Reskinned the popup and details pages to the "Amber" palette: warm neutral
  surfaces, borders and text, with an amber accent (`#d97706` in light mode,
  `#fbbf24` in dark) replacing the previous blue. Markup, layout and behaviour
  are unchanged — every component already read its colours from `:root` tokens.
- Primary buttons now take their label colour from a new `--on-accent` token:
  white on the light-mode orange, near-black on the dark-mode amber. Previously
  the dark-mode "Track price" / "Force Check" labels were white on bright amber,
  which was close to illegible.

## [0.2.0] — 2026-04-21

### Added

- Firefox for Android support (`gecko_android`, Fenix 142+).
- Touch element picker, selected via `matchMedia('(pointer: coarse)')`; desktop
  keeps the hover picker.
- Handling for JS-rendered product pages: the content script caches the tracked
  selector for the current URL and watches DOM mutations for up to 8s after
  load, updating storage once the price appears.
- A `failedChecks` counter, surfaced in the UI after two consecutive failed
  background checks.

## Earlier releases

Versions `v0.1.0` through `v0.1.14` predate this changelog. See the
[git tags](https://github.com/exzzy22/Firefox-Price-Tracker/tags) and
[GitHub releases](https://github.com/exzzy22/Firefox-Price-Tracker/releases)
for that history.
