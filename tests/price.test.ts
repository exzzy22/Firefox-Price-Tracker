import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

// happy-dom gives us a DOMParser-capable Document for the DOM traversal tests.
const window = new Window({ url: 'https://example.test/' });
(globalThis as unknown as { window: unknown }).window = window;
(globalThis as unknown as { document: unknown }).document = window.document;
(globalThis as unknown as { DOMParser: unknown }).DOMParser = window.DOMParser;

const PL = await import('../src/lib/price.ts');

test('cleanNumber handles dot decimals', () => {
  assert.equal(PL.cleanNumber('$1,299.99'), 1299.99);
  assert.equal(PL.cleanNumber('USD 49.50'), 49.5);
});

test('cleanNumber handles comma decimals', () => {
  assert.equal(PL.cleanNumber('€1.299,99'), 1299.99);
  assert.equal(PL.cleanNumber('29,90'), 29.9);
});

test('cleanNumber rejects garbage', () => {
  assert.equal(PL.cleanNumber(''), null);
  assert.equal(PL.cleanNumber(null), null);
  assert.equal(PL.cleanNumber('abc'), null);
});

test('extractCurrencySnippet prefers first currency match', () => {
  assert.equal(PL.extractCurrencySnippet('$19.99 / was $29.99'), '$19.99');
  assert.equal(PL.extractCurrencySnippet('Now €26.51€26.51'), '€26.51');
  assert.equal(PL.extractCurrencySnippet('   £ 42  '), '£ 42');
});

test('extractCurrencySnippet collapses whitespace when no currency', () => {
  assert.equal(PL.extractCurrencySnippet('  hello\n\tworld '), 'hello world');
});

test('normalizeRaw returns snippet + numeric price', () => {
  const n = PL.normalizeRaw('  Sale: $1,234.56 today ');
  assert.equal(n.raw, '$1,234.56');
  assert.equal(n.price, 1234.56);
  assert.equal(n.currencySymbol, '$');
});

test('canonicalForCompare normalizes equivalent prices', () => {
  assert.equal(PL.canonicalForCompare('$1,234.56'), PL.canonicalForCompare('  USD 1234.56'));
  assert.equal(PL.canonicalForCompare('€26.51'), PL.canonicalForCompare('€ 26.51'));
});

test('canonicalForCompare differs for different prices', () => {
  assert.notEqual(PL.canonicalForCompare('$10'), PL.canonicalForCompare('$11'));
});

test('pickLdPrice reads offers.price', () => {
  assert.equal(PL.pickLdPrice({ offers: { price: '49.99' } }), '49.99');
  assert.equal(PL.pickLdPrice({ price: 9 }), 9);
  assert.equal(PL.pickLdPrice({ offers: { lowPrice: '19.00' } }), '19.00');
});

test('pickLdPrice walks @graph', () => {
  const obj = { '@graph': [{ foo: 1 }, { offers: { price: 42 } }] };
  assert.equal(PL.pickLdPrice(obj), 42);
});

test('pickLdPrice returns null for non-objects', () => {
  assert.equal(PL.pickLdPrice(null), null);
  assert.equal(PL.pickLdPrice('string'), null);
  assert.equal(PL.pickLdPrice({}), null);
});

test('isProductPage: true for JSON-LD Product', () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product","name":"X","offers":{"price":"9.99"}}
  </script></head><body></body></html>`;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  assert.equal(PL.isProductPage(doc as unknown as Document), true);
});

test('isProductPage: true for og:type=product', () => {
  const html = `<html><head><meta property="og:type" content="product" /></head><body></body></html>`;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  assert.equal(PL.isProductPage(doc as unknown as Document), true);
});

test('isProductPage: false for news article with currency text', () => {
  const html = `<html><body>
    <article>Apple reported revenue of $89.5 billion today.</article>
  </body></html>`;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  assert.equal(PL.isProductPage(doc as unknown as Document), false);
});

test('findPriceOnPage: JSON-LD product', () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product","offers":{"price":"24.99","priceCurrency":"USD"}}
  </script></head><body></body></html>`;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const hit = PL.findPriceOnPage(doc as unknown as Document, { hostname: 'shop.test' });
  assert.ok(hit);
  assert.equal(hit!.price, 24.99);
});

test('findPriceOnPage: microdata Product scope', () => {
  const html = `<html><body>
    <div itemscope itemtype="https://schema.org/Product">
      <h1 itemprop="name">Widget</h1>
      <span itemprop="price" content="12.49">$12.49</span>
    </div>
  </body></html>`;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const hit = PL.findPriceOnPage(doc as unknown as Document, { hostname: 'shop.test' });
  assert.ok(hit);
  assert.equal(hit!.price, 12.49);
});

test('findPriceOnPage: meta product:price:amount', () => {
  const html = `<html><head>
    <meta property="product:price:amount" content="79.95" />
    <meta property="og:type" content="product" />
  </head><body></body></html>`;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const hit = PL.findPriceOnPage(doc as unknown as Document, { hostname: 'shop.test' });
  assert.ok(hit);
  assert.equal(hit!.price, 79.95);
});

test('findPriceOnPage: returns null for a non-product page with currency text', () => {
  const html = `<html><body>
    <h1>Market update</h1>
    <p>Stocks rose by $5 today. Analysts estimate a $1,000 target.</p>
  </body></html>`;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const hit = PL.findPriceOnPage(doc as unknown as Document, { hostname: 'news.test' });
  assert.equal(hit, null);
});

test('findPriceOnPage: preferred selector wins', () => {
  const html = `<html><body>
    <span id="my-price" content="42.00">Old $99</span>
    <div itemscope itemtype="https://schema.org/Product">
      <span itemprop="price" content="10.00">$10</span>
    </div>
  </body></html>`;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const hit = PL.findPriceOnPage(doc as unknown as Document, { preferredSelector: '#my-price' });
  assert.equal(hit!.price, 42);
});

test('findPriceOnPage: WooCommerce product page', () => {
  const html = `<html><body>
    <p class="price"><span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol">€</span>1,395.00</bdi></span></p>
    <form class="cart" method="post"><button type="submit">Add to cart</button></form>
  </body></html>`;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const hit = PL.findPriceOnPage(doc as unknown as Document, { hostname: 'shop.test' });
  assert.ok(hit);
  assert.equal(hit!.price, 1395);
});

test('findPriceOnPage: WooCommerce sale price prefers ins over del', () => {
  const html = `<html><body>
    <p class="price">
      <del><span class="woocommerce-Price-amount amount"><bdi>€2,000.00</bdi></span></del>
      <ins><span class="woocommerce-Price-amount amount"><bdi>€1,395.00</bdi></span></ins>
    </p>
    <form class="cart" method="post"><button>Add to cart</button></form>
  </body></html>`;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const hit = PL.findPriceOnPage(doc as unknown as Document, { hostname: 'shop.test' });
  assert.ok(hit);
  assert.equal(hit!.price, 1395);
});

test('findPriceOnPage: WooCommerce selector ignored without form.cart', () => {
  const html = `<html><body>
    <span class="woocommerce-Price-amount"><bdi>€1,395.00</bdi></span>
  </body></html>`;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const hit = PL.findPriceOnPage(doc as unknown as Document, { hostname: 'shop.test' });
  assert.equal(hit, null);
});

test('findPriceInHtml: parses full HTML string', () => {
  const html = `<!doctype html><html><body>
    <div itemscope itemtype="https://schema.org/Product">
      <meta itemprop="price" content="59.00" />
    </div>
  </body></html>`;
  const hit = PL.findPriceInHtml(html, { hostname: 'shop.test' });
  assert.ok(hit);
  assert.equal(hit!.price, 59);
});
