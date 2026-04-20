// @ts-check
// Build script: compile TypeScript entry points with esbuild into dist/,
// then copy static assets (HTML, CSS, icons, manifest) alongside them so
// that `web-ext run|build` can treat dist/ as the extension root.
import { build, context } from 'esbuild';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DIST = resolve(ROOT, 'dist');

const WATCH = process.argv.includes('--watch');

const ENTRY_POINTS = {
  background: resolve(ROOT, 'src/background.ts'),
  content_script: resolve(ROOT, 'src/content_script.ts'),
  popup: resolve(ROOT, 'src/popup.ts'),
  details: resolve(ROOT, 'src/details.ts')
};

const STATIC_ASSETS = [
  { from: 'src/popup.html', to: 'dist/popup.html' },
  { from: 'src/details.html', to: 'dist/details.html' },
  { from: 'src/styles.css', to: 'dist/styles.css' },
  { from: 'icons', to: 'dist/icons' }
];

async function clean() {
  if (existsSync(DIST)) await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
}

async function copyStatics() {
  for (const { from, to } of STATIC_ASSETS) {
    const src = resolve(ROOT, from);
    const dst = resolve(ROOT, to);
    await cp(src, dst, { recursive: true });
  }
}

// The repo-root manifest targets the built JS/HTML files in dist/. Since
// we ship dist/ as the extension root we rewrite the `dist/` prefixes to
// be relative to dist/ itself.
async function writeManifest() {
  const raw = await readFile(resolve(ROOT, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw);

  const strip = p => (typeof p === 'string' ? p.replace(/^dist\//, '') : p);
  const stripAll = arr => (Array.isArray(arr) ? arr.map(strip) : arr);

  if (manifest.background?.scripts) {
    manifest.background.scripts = stripAll(manifest.background.scripts);
  }
  if (Array.isArray(manifest.content_scripts)) {
    for (const cs of manifest.content_scripts) {
      if (cs.js) cs.js = stripAll(cs.js);
    }
  }
  if (manifest.action?.default_popup) {
    manifest.action.default_popup = strip(manifest.action.default_popup);
  }

  await writeFile(
    resolve(DIST, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
}

/** @type {import('esbuild').BuildOptions} */
const sharedOptions = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'firefox128',
  sourcemap: WATCH ? 'inline' : false,
  minify: !WATCH,
  logLevel: 'info'
};

async function runBuild() {
  await clean();
  await copyStatics();
  await writeManifest();
  const tasks = Object.entries(ENTRY_POINTS).map(([name, entry]) =>
    build({
      ...sharedOptions,
      entryPoints: [entry],
      outfile: resolve(DIST, `${name}.js`)
    })
  );
  await Promise.all(tasks);
  console.log('Built dist/ at', new Date().toLocaleTimeString());
}

async function runWatch() {
  await clean();
  await copyStatics();
  await writeManifest();
  const ctxs = await Promise.all(
    Object.entries(ENTRY_POINTS).map(([name, entry]) =>
      context({
        ...sharedOptions,
        entryPoints: [entry],
        outfile: resolve(DIST, `${name}.js`)
      })
    )
  );
  await Promise.all(ctxs.map(c => c.watch()));
  console.log('Watching for changes…');
}

if (WATCH) await runWatch();
else await runBuild();
