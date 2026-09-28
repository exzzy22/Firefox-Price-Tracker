import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeSinceAdded, cleanTitle, formatPrice, lastChange, priceRange } from '../src/lib/format.ts';

test('formatPrice uses the currency code when known', () => {
  const s = formatPrice(1299.5, 'USD', 'USD 1299.50');
  assert.match(s, /1,?299\.50|1[.\s  ]?299,50/);
  assert.match(s, /\$|US/);
});

test('formatPrice falls back to the site text, then a bare number', () => {
  assert.equal(formatPrice(19.99, null, '$19.99'), '$19.99');
  assert.match(formatPrice(449, null, '449.0'), /^449$/);
  assert.equal(formatPrice(null, null, ''), '—');
});

test('cleanTitle drops site suffixes and domain prefixes only', () => {
  assert.equal(cleanTitle('Apple iPhone 12 Mini, 64GB - Unlocked- Refurbished | eBay', 'www.ebay.com'), 'Apple iPhone 12 Mini, 64GB - Unlocked- Refurbished');
  assert.equal(cleanTitle('Amazon.com: Anker USB C Cable', 'www.amazon.com'), 'Anker USB C Cable');
  assert.equal(cleanTitle('Google TV Streamer 4K - JB Hi-Fi', 'www.jbhifi.com.au'), 'Google TV Streamer 4K');
  assert.equal(cleanTitle('Spider-Man 2 - PlayStation 5', 'www.shop.test'), 'Spider-Man 2 - PlayStation 5');
  assert.equal(cleanTitle('Nike Air Max: The Classic', 'www.nike.com'), 'Nike Air Max: The Classic');
});

test('lastChange compares with the previous distinct price', () => {
  const item = { lastPrice: 80, history: [{ ts: 1, price: 100, raw: '' }, { ts: 2, price: 100, raw: '' }, { ts: 3, price: 80, raw: '' }] };
  const ch = lastChange(item)!;
  assert.equal(ch.from, 100);
  assert.equal(Math.round(ch.pct), -20);
  assert.equal(lastChange({ lastPrice: 5, history: [{ ts: 1, price: 5, raw: '' }] }), null);
});

test('changeSinceAdded and priceRange', () => {
  const history = [{ ts: 1, price: 50, raw: '' }, { ts: 2, price: 70, raw: '' }, { ts: 3, price: 60, raw: '' }];
  assert.equal(Math.round(changeSinceAdded({ lastPrice: 60, history })!.pct), 20);
  assert.deepEqual(priceRange(history), { min: 50, max: 70 });
});
