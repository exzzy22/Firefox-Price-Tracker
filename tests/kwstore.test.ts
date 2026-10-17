import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchKwPrice, kwTarget } from '../src/lib/kwstore.ts';

const PAGE = 'https://store.kwautomotive.de/de/st/shop?c_make=72&c_model=14059&c_car=112667'
  + '&pgs=162%2C160%2C294%2C361%2C384%2C161%2C293%2C383%2C163&ag=stxtagewindefahrwerk';
const BASE = 'https://store.kwautomotive.de/de/st/';
const productsUrl = (group: number) =>
  `${BASE}fwd_php/couch_adapter/get.php/getProducts?car_id=112667&group_id=${group}&brand_filter=`;
const PRICE_URL = `${BASE}productfinder/ajax/GetProductsPriceAndAvailability`;

// Trimmed copies of real responses.
const GROUP_160 = [
  { group_key: 'stxgewindefahrwerk', products: [{ id: 155139, artikelnr: '13275015' }] },
  { group_key: 'stxtagewindefahrwerk', products: [{ id: 155140, artikelnr: '18275815', price: null }] }
];
const PRICE_155140 = [{ '155140': { price: 1349, price_excl_tax: 1133.6134443782, strike_price: 1349 } }];

interface Call { url: string; init?: RequestInit }

function stub(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchJson = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return url in responses ? responses[url] : [];
  };
  return { calls, fetchJson };
}

test('kwTarget reads the configurator url', () => {
  assert.deepEqual(kwTarget(PAGE), {
    base: BASE,
    carId: '112667',
    groupKey: 'stxtagewindefahrwerk',
    groupIds: ['162', '160', '294', '361', '384', '161', '293', '383', '163']
  });
  assert.equal(kwTarget(PAGE.replace('/de/st/', '/uk/kw/'))?.base, 'https://store.kwautomotive.de/uk/kw/');
});

test('kwTarget ignores other pages', () => {
  assert.equal(kwTarget('https://store.kwautomotive.de/de/st/'), null);
  assert.equal(kwTarget(PAGE.replace('&ag=stxtagewindefahrwerk', '')), null);
  assert.equal(kwTarget(PAGE.replace('c_car=112667', 'c_car=')), null);
  assert.equal(kwTarget(PAGE.replace('/shop?', '/versandkosten?')), null);
  assert.equal(kwTarget(PAGE.replace('store.kwautomotive.de', 'shop.test')), null);
  assert.equal(kwTarget('not a url'), null);
});

test('fetchKwPrice finds the product group, then asks for its price', async () => {
  const { calls, fetchJson } = stub({ [productsUrl(160)]: GROUP_160, [PRICE_URL]: PRICE_155140 });
  const hit = await fetchKwPrice(kwTarget(PAGE)!, fetchJson, 'EUR');
  assert.deepEqual(hit, { price: 1349, raw: 'EUR 1349.00', currency: 'EUR', source: 'api:kwautomotive' });
  // Stops at the group that has the product; later groups aren't fetched.
  assert.deepEqual(calls.map(c => c.url), [productsUrl(162), productsUrl(160), PRICE_URL]);
  const priceCall = calls[2]!.init!;
  assert.equal(priceCall.method, 'POST');
  assert.equal(priceCall.body, 'idarr%5B%5D=155140');
  assert.equal((priceCall.headers as Record<string, string>)['X-Requested-With'], 'XMLHttpRequest');
});

test('fetchKwPrice gives up when the group has several products', async () => {
  const twoProducts = [{ group_key: 'stxtagewindefahrwerk', products: [{ id: 1 }, { id: 2 }] }];
  const { calls, fetchJson } = stub({ [productsUrl(162)]: twoProducts, [PRICE_URL]: PRICE_155140 });
  assert.equal(await fetchKwPrice(kwTarget(PAGE)!, fetchJson, 'EUR'), null);
  assert.equal(calls.length, 1);
});

test('fetchKwPrice returns null for unknown groups and products', async () => {
  const none = stub({});
  assert.equal(await fetchKwPrice(kwTarget(PAGE)!, none.fetchJson, 'EUR'), null);
  assert.equal(none.calls.length, 9);

  const notFound = stub({ [productsUrl(160)]: GROUP_160, [PRICE_URL]: [{ '155140': ['155140 not found.'] }] });
  assert.equal(await fetchKwPrice(kwTarget(PAGE)!, notFound.fetchJson, 'EUR'), null);
});
