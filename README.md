# Firefox Price Tracker

Simple Firefox WebExtension that lets you track prices on product pages and receive notifications when they change.

Installation (developer/testing):

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click "Load Temporary Add-on" and choose the `manifest.json` file from this folder.

How it works:
- Open the popup on any product page and click "Track price on this page" to save the current price.
- A background alarm runs every 60 minutes and fetches tracked pages; changes trigger a notification.

Files:
- `manifest.json` — extension manifest
- `popup.html`, `popup.js` — popup UI to track and list items
- `content_script.js` — extracts price and title from the current page
- `background.js` — periodic checks and notifications
- `src/` — main extension source files (`popup.html`, `popup.js`, `background.js`, `content_script.js`, `details.html`, `details.js`)

## License

This project is licensed under the MIT License — see the `LICENSE` file for
details. You are free to use, copy, modify, and distribute this software.

Please retain the copyright and license notice when redistributing or
publishing derivative works, and include a reference (URL or text) to the
original source repository so others can find the original project.

## Releases / Installable XPI

This repository includes a GitHub Actions workflow that packages the extension
as an XPI (Firefox extension archive) and uploads it to a GitHub Release.

How to produce a release artifact on GitHub:

- Create a release tag (for example `v1.0.0`) and push it, or run the
	"Package Firefox extension" workflow manually from the **Actions** tab and
	provide a `tag` value.
- The workflow will create a `FirefoxPriceTracker-<tag>.xpi` release asset.

Installing the XPI locally:

- Download the `.xpi` file from the GitHub Release page.
- In Firefox, open the menu → Add-ons and themes → Install Add-on From File,
	then select the downloaded `.xpi`, or drag the `.xpi` into a Firefox window.

Submitting to addons.mozilla.org (AMO):

- AMO accepts `.xpi` uploads for listing your extension. Use the generated
	`.xpi` from the Release as the file to upload when creating a new listing.
