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