// Tiny DOM helpers for the popup and details page: an element builder, the
// inline SVG icon set, and price-history charts. No innerHTML anywhere.
import type { HistoryEntry } from './types.js';

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2), v);
    } else if (k === 'className') {
      el.className = String(v);
    } else if (k === 'hidden') {
      el.hidden = Boolean(v);
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(c);
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// 24x24 stroke icons (Lucide-style geometry, drawn here so nothing is fetched).
const ICONS: Record<string, string[]> = {
  refresh: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
  expand: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
  external: ['M14 3h7v7', 'M10 14 21 3', 'M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  target: ['M12 3v3', 'M12 18v3', 'M3 12h3', 'M18 12h3', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  plus: ['M12 5v14', 'M5 12h14'],
  check: ['M20 6 9 17l-5-5'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  clock: ['M12 7v5l3 2', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
  chart: ['M3 3v18h18', 'M7 15l4-4 3 3 5-6'],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
  upload: ['M12 21V9', 'M7 14l5-5 5 5', 'M5 3h14'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M21 21l-4.35-4.35'],
  tag: ['M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z', 'M7.5 7.5h.01']
};

export function icon(name: keyof typeof ICONS | string, size = 18): SVGSVGElement {
  const root = svg('svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    class: 'icon'
  });
  for (const d of ICONS[name] ?? []) root.append(svg('path', { d }));
  return root;
}

interface Point { x: number; y: number; }

function pricedEntries(history: HistoryEntry[]): Array<{ ts: number; price: number }> {
  return history
    .filter((e): e is HistoryEntry & { price: number } => typeof e.price === 'number' && Number.isFinite(e.price))
    .map(e => ({ ts: e.ts, price: e.price }))
    .sort((a, b) => a.ts - b.ts);
}

// Prices hold until they change, so charts are drawn as steps, extended to
// `now` so the current price has visible width. Plots into the box
// [x0, x0 + w] x [y0, y0 + hgt].
interface Box { x0: number; y0: number; w: number; hgt: number; }

function stepPoints(entries: Array<{ ts: number; price: number }>, box: Box, now: number): Point[] {
  const t0 = entries[0]!.ts;
  const t1 = Math.max(now, entries[entries.length - 1]!.ts + 1);
  const prices = entries.map(e => e.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const x = (t: number) => box.x0 + ((t - t0) / (t1 - t0)) * box.w;
  const y = (p: number) => max === min ? box.y0 + box.hgt / 2 : box.y0 + (1 - (p - min) / span) * box.hgt;
  const pts: Point[] = [];
  entries.forEach((e, i) => {
    if (i > 0) pts.push({ x: x(e.ts), y: y(entries[i - 1]!.price) });
    pts.push({ x: x(e.ts), y: y(e.price) });
  });
  pts.push({ x: box.x0 + box.w, y: y(entries[entries.length - 1]!.price) });
  return pts;
}

const fmtPts = (pts: Point[]) => pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

// Compact trend line for list rows. Returns null with fewer than two prices.
export function sparkline(history: HistoryEntry[], trend: 'down' | 'up' | 'flat', now = Date.now()): SVGSVGElement | null {
  const entries = pricedEntries(history);
  if (entries.length < 2) return null;
  const w = 120;
  const hgt = 32;
  const pts = stepPoints(entries, { x0: 0, y0: 4, w, hgt: hgt - 8 }, now);
  const root = svg('svg', { viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none', class: `spark spark-${trend}`, 'aria-hidden': 'true' });
  root.append(
    svg('polygon', { points: `0,${hgt} ${fmtPts(pts)} ${w},${hgt}`, class: 'spark-area' }),
    svg('polyline', { points: fmtPts(pts), class: 'spark-line', 'vector-effect': 'non-scaling-stroke' })
  );
  return root;
}

// Larger history chart: price axis labels in a left gutter, dates below.
// `width` should be the rendered width in CSS px so labels stay 12px on
// phones instead of shrinking with the viewBox.
export function historyChart(
  history: HistoryEntry[],
  formatValue: (n: number) => string,
  formatDate: (ts: number) => string,
  width = 640,
  now = Date.now()
): SVGSVGElement | null {
  const entries = pricedEntries(history);
  if (entries.length < 2) return null;
  const w = Math.max(280, Math.round(width));
  const hgt = w < 480 ? 150 : 180;
  const gutter = w < 480 ? 70 : 84;
  const box: Box = { x0: gutter, y0: 12, w: w - gutter - 4, hgt: hgt - 12 - 30 };
  const pts = stepPoints(entries, box, now);
  const prices = entries.map(e => e.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const bottom = box.y0 + box.hgt;
  const root = svg('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'chart', role: 'img', 'aria-label': `Price history from ${formatValue(min)} to ${formatValue(max)}` });
  const label = (text: string, x: number, y: number, anchor: string, cls: string) => {
    const t = svg('text', { x, y, 'text-anchor': anchor, 'dominant-baseline': 'middle', class: cls });
    t.textContent = text;
    return t;
  };
  const yMax = max === min ? box.y0 + box.hgt / 2 : box.y0;
  root.append(
    svg('polygon', { points: `${box.x0},${bottom} ${fmtPts(pts)} ${box.x0 + box.w},${bottom}`, class: 'chart-area' }),
    svg('line', { x1: box.x0, x2: box.x0 + box.w, y1: yMax, y2: yMax, class: 'chart-guide' }),
    svg('polyline', { points: fmtPts(pts), class: 'chart-line', 'vector-effect': 'non-scaling-stroke' }),
    label(formatValue(max), box.x0 - 10, yMax, 'end', 'chart-label')
  );
  if (max !== min) {
    root.append(
      svg('line', { x1: box.x0, x2: box.x0 + box.w, y1: bottom, y2: bottom, class: 'chart-guide' }),
      label(formatValue(min), box.x0 - 10, bottom, 'end', 'chart-label'));
  }
  root.append(
    label(formatDate(entries[0]!.ts), box.x0, hgt - 10, 'start', 'chart-label chart-date'),
    label(formatDate(now), box.x0 + box.w, hgt - 10, 'end', 'chart-label chart-date'));
  return root;
}
