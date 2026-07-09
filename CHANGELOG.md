# Changelog

All notable changes to Price Tracker are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
