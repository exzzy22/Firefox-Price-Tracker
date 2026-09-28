import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl, productKey, sameProduct, siteName } from '../src/lib/url.ts';

test('productKey ignores tracking parameters and fragments', () => {
  assert.equal(
    productKey('https://www.shop.test/p/widget?utm_source=mail&utm_medium=x&gclid=1#reviews'),
    productKey('https://shop.test/p/widget/')
  );
});

test('productKey keeps variant parameters', () => {
  assert.notEqual(productKey('https://shop.test/p/shoe?variant=1'), productKey('https://shop.test/p/shoe?variant=2'));
  assert.equal(productKey('https://shop.test/p/shoe?b=2&a=1'), productKey('https://shop.test/p/shoe?a=1&b=2'));
});

test('productKey identifies Amazon products by ASIN', () => {
  const a = 'https://www.amazon.de/-/en/INIU-Cable/dp/B0BR3L78XN/ref=sr_1_4?dib=abc&keywords=usb&qid=1';
  const b = 'https://amazon.de/gp/product/B0BR3L78XN';
  assert.equal(productKey(a), productKey(b));
  assert.equal(productKey(a), 'amazon.de/dp/B0BR3L78XN');
  assert.notEqual(productKey(a), productKey('https://www.amazon.com/dp/B0BR3L78XN'));
});

test('cleanUrl strips tracking but keeps meaningful parts', () => {
  assert.equal(
    cleanUrl('https://www.amazon.com/Anker-Cable/dp/B088NRLMPV/ref=sr_1_3?dib=x&keywords=usb&qid=1&sr=8-3'),
    'https://www.amazon.com/Anker-Cable/dp/B088NRLMPV'
  );
  assert.equal(
    cleanUrl('https://shop.test/p/shoe?variant=42&utm_campaign=x#colour-red'),
    'https://shop.test/p/shoe?variant=42#colour-red'
  );
  assert.equal(cleanUrl('not a url'), 'not a url');
});

test('sameProduct and siteName', () => {
  assert.equal(sameProduct('https://m.shop.test/p/1?fbclid=z', 'https://www.shop.test/p/1'), true);
  assert.equal(sameProduct(null, 'https://shop.test/p/1'), false);
  assert.equal(siteName('https://www.hsnstore.eu/brands/x'), 'hsnstore.eu');
});
