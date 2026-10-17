import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dmTarget, fetchDmPrice } from '../src/lib/dmstore.ts';

const API = 'https://products.dm.de/product/products/detail/HR/dan/1679755';
// Trimmed copy of a real response.
const PRODUCT = {
  dan: 1679755,
  metadata: { canonical: 'https://www.dm.hr/p/d/1679755/balea-sampon-za-kosu-volumen', currency: 'EUR', price: 0.95 },
  price: { price: { current: { value: '0,95 €' } }, infos: ['0,3 l (3,17 € za 1 l)'] }
};

function stub(response: unknown) {
  const calls: string[] = [];
  return { calls, fetchJson: async (url: string) => { calls.push(url); return response; } };
}

test('dmTarget reads country and article number from the url', () => {
  assert.deepEqual(dmTarget('https://www.dm.hr/p/d/1679755/balea-sampon-za-kosu-volumen'), { country: 'HR', dan: '1679755' });
  assert.deepEqual(dmTarget('https://www.dm.de/p/d/1679755/balea-shampoo-volumen?wt_mc=x'), { country: 'DE', dan: '1679755' });
});

test('dmTarget ignores other pages', () => {
  assert.equal(dmTarget('https://www.dm.hr/marke/balea'), null);
  assert.equal(dmTarget('https://www.dm.hr/balea-sampon-p4066447238877.html'), null);
  assert.equal(dmTarget('https://shop.dm.example/p/d/1679755/x'), null);
  assert.equal(dmTarget('http://www.dm.hr/p/d/1679755/x'), null);
  assert.equal(dmTarget('not a url'), null);
});

test('fetchDmPrice reads the product API', async () => {
  const { calls, fetchJson } = stub(PRODUCT);
  const hit = await fetchDmPrice(dmTarget('https://www.dm.hr/p/d/1679755/x')!, fetchJson);
  assert.deepEqual(hit, { price: 0.95, raw: '0,95 €', currency: 'EUR', source: 'api:dm' });
  assert.deepEqual(calls, [API]);
});

test('fetchDmPrice returns null without a usable price', async () => {
  const target = dmTarget('https://www.dm.hr/p/d/1679755/x')!;
  assert.equal(await fetchDmPrice(target, stub({ metadata: { price: 0 } }).fetchJson), null);
  assert.equal(await fetchDmPrice(target, stub({ error: 'not found' }).fetchJson), null);
  assert.equal(await fetchDmPrice(target, stub(null).fetchJson), null);
});
