# Build instructions (for AMO reviewers)

These steps reproduce the submitted add-on exactly from this source archive.

## Build environment

- **Operating system:** any of Linux, macOS, or Windows. The published build
  is produced on `ubuntu-latest` via GitHub Actions
  (`.github/workflows/release.yml`). Any OS yields identical output.
- **Node.js:** v24.12.0 was used for the submitted build. Any Node >= 20 works.
  Install from <https://nodejs.org/en/download> (or via `nvm install 24`).
- **npm:** 11.6.2. npm ships with Node.js, so installing Node installs npm.
  Verify with `node --version && npm --version`.

No other tools are required. There is no global install step, no compiler
toolchain, and no network access needed beyond `npm ci`.

## Steps

From the root of this source archive:

```bash
npm ci        # install exact dependency versions from package-lock.json
npm run build # run the build script (build.mjs)
```

Use `npm ci` rather than `npm install` — it installs the exact versions pinned
in `package-lock.json`, which is what the submitted build used.

## What the build script does

`npm run build` runs [build.mjs](build.mjs), which performs every technical
step needed:

1. Deletes and recreates `dist/`.
2. Bundles the four TypeScript entry points (`src/background.ts`,
   `src/content_script.ts`, `src/popup.ts`, `src/details.ts`) with esbuild into
   one IIFE file each. Each bundle inlines its imports from `src/lib/`, so the
   add-on ships exactly four JS files. Output is minified; no sourcemaps are
   emitted in production builds.
3. Copies `src/popup.html`, `src/details.html`, `src/styles.css`, and `icons/`
   into `dist/`.
4. Reads the root `manifest.json`, strips the `dist/` path prefixes, and writes
   `dist/manifest.json`.

## Result

`dist/` **is** the add-on root — its contents are exactly the files in the
submitted package. To produce the identical zip:

```bash
npm run package   # -> build/price_tracker-<version>.zip
```

## Verifying the output

After `npm run build`, the files in `dist/` match the submitted add-on
byte-for-byte. To confirm, compare hashes of the built files against the
same files unzipped from the submitted package:

```bash
sha256sum dist/background.js dist/content_script.js \
          dist/details.js dist/popup.js dist/styles.css dist/manifest.json
```

On Windows PowerShell: `Get-FileHash dist\* -Algorithm SHA256`.

Note: `src/styles.css` is copied verbatim into `dist/`, so it must keep its
original LF line endings. If you extract this archive on Windows with a tool
that rewrites line endings, `dist/styles.css` will differ by its CRLF bytes
while remaining identical in content.

## Third-party code

No third-party runtime libraries are bundled into the add-on. `esbuild`,
`tsx`, `happy-dom`, `typescript`, and `web-ext` are `devDependencies`, used
only to build, test, and lint. See `package.json`.

## Optional checks

```bash
npm run typecheck   # tsc --noEmit
npm test            # unit tests for the price parser
npm run lint        # web-ext lint dist/
```
