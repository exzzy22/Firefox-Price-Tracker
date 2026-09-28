// URL identity for tracked products. The same product is reached through
// many URLs (tracking params, Amazon ref paths), so matching uses a key that
// drops those instead of comparing hrefs.

// Query parameters that only carry attribution/analytics. Never variant or
// product ids — stripping one of those would change the page we fetch.
const TRACKING_PARAMS = new Set([
  'gclid', 'gclsrc', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid', 'yclid', 'twclid',
  'ttclid', 'li_fat_id', 'igshid', 'srsltid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi',
  '_ga', '_gl', 'ref', 'ref_', 'referrer', 'spm', 'scm', 'algo_pvid', 'algo_exp_id',
  'pdp_ext_f', 'pdp_npi', 'curpageloguid', 'utparam-url', '_trkparms', '_trksid',
  'athasset', 'athena', 'athcpid', 'athpgid', 'athznid', 'athieid', 'athstid', 'athancid',
  'classtype', 'from', 'rq', 'icid', 'icid2', 'cmp', 'cm_sp', 'cm_mmc', 'cm_re',
  'irclickid', 'clickid', 'sr', 'qid', 'keywords', 'sprefix', 'crid', 'dib', 'dib_tag',
  'content-id', '_encoding', 'recset', 'refccid', 'recalg', 'recidx', 'nnc', 'ctx',
  'snr', 'sc_cid', 'ncid', 'trk', 'trkid', 'mkevt', 'mkcid', 'mkrid',
  'campid', 'toolid', 'customid', 'hash', 'itmmeta', 'itmprp', 'amdata'
]);

function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return TRACKING_PARAMS.has(n) || n.startsWith('utm_') || n.startsWith('pd_rd_')
    || n.startsWith('pf_rd_') || n.startsWith('hsa_') || n.startsWith('_ga_');
}

const AMAZON_HOST = /(^|\.)amazon\.[a-z.]+$/;
const AMAZON_ASIN = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin|o\/asin)\/([A-Z0-9]{10})(?:[/?]|$)/i;

// Query parameters as raw `key=value` parts with decoded keys. Parsed by
// hand: in Firefox content scripts URL objects are Xray-wrapped and the
// iterators from URLSearchParams.entries()/keys() aren't iterable there.
export function queryParts(search: string): Array<{ key: string; part: string }> {
  return search.replace(/^\?/, '').split('&').filter(Boolean).map(part => {
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    let key = rawKey;
    try { key = decodeURIComponent(rawKey.replace(/\+/g, ' ')); } catch { /* keep raw */ }
    return { key, part };
  });
}

function parse(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

// The url with tracking parameters (and Amazon's /ref=... path segment)
// removed. The fragment is kept: some shops route variants through it.
// Unparseable urls are returned unchanged.
export function cleanUrl(url: string): string {
  const u = parse(url);
  if (!u) return url;
  const kept = queryParts(u.search).filter(q => !isTrackingParam(q.key)).map(q => q.part);
  u.search = kept.length ? '?' + kept.join('&') : '';
  if (AMAZON_HOST.test(u.hostname)) u.pathname = u.pathname.replace(/\/ref=[^/]*$/, '');
  return u.href;
}

// Stable identity for "the same product": host without www/m, Amazon by
// ASIN, everything else by path + non-tracking query, sorted.
export function productKey(url: string): string {
  const u = parse(url);
  if (!u) return url.split('#')[0] ?? url;
  const host = u.hostname.toLowerCase().replace(/^(www\d*|m|smile)\./, '');
  if (AMAZON_HOST.test(host)) {
    const asin = u.pathname.match(AMAZON_ASIN)?.[1];
    if (asin) return `${host}/dp/${asin.toUpperCase()}`;
  }
  const params = queryParts(u.search)
    .filter(q => !isTrackingParam(q.key))
    .map(q => q.part)
    .sort();
  const query = params.length ? '?' + params.join('&') : '';
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return `${host}${path}${query}`;
}

export function sameProduct(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return productKey(a) === productKey(b);
}

export function isWebUrl(url: string | null | undefined): boolean {
  return !!url && parse(url) !== null;
}

// "amazon.de", "shop.example.com" — for compact display.
export function siteName(url: string): string {
  const u = parse(url);
  return u ? u.hostname.replace(/^www\d*\./, '') : '';
}
