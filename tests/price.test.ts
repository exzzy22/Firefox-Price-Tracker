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

test('findPriceOnPage: Amazon mobile (no #productTitle)', () => {
  const html = `<html><body>
    <h1 id="title"><span>Mobile Product</span></h1>
    <div id="corePriceDisplay_mobile_feature_div">
      <span class="a-price"><span class="a-offscreen">$19.99</span></span>
    </div>
  </body></html>`;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const hit = PL.findPriceOnPage(doc as unknown as Document, { hostname: 'www.amazon.com' });
  assert.ok(hit);
  assert.equal(hit!.price, 19.99);
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

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html') as unknown as Document;

// --- number parsing -------------------------------------------------------

test('cleanNumber treats a lone 3-digit group as thousands', () => {
  assert.equal(PL.cleanNumber('$1,299'), 1299);
  assert.equal(PL.cleanNumber('1.299 €'), 1299);
  assert.equal(PL.cleanNumber('1,234,567.89'), 1234567.89);
  assert.equal(PL.cleanNumber('0,999'), 0.999);
});

test('cleanNumber handles space and apostrophe grouping', () => {
  assert.equal(PL.cleanNumber('1 299,99 kr'), 1299.99);
  assert.equal(PL.cleanNumber('1 299,00 €'), 1299);
  assert.equal(PL.cleanNumber("CHF 1'299.90"), 1299.9);
});

test('cleanNumber reads the first number, not all digits in the text', () => {
  assert.equal(PL.cleanNumber('Rs.1,299'), 1299);
  assert.equal(PL.cleanNumber('19.99 - 29.99'), 19.99);
});

test('parseMachineNumber keeps machine decimals', () => {
  assert.equal(PL.parseMachineNumber('1.299'), 1.299);
  assert.equal(PL.parseMachineNumber(42), 42);
  assert.equal(PL.parseMachineNumber('1.299,00 €'), 1299);
});

test('extractCurrencySnippet understands suffix currencies and codes', () => {
  assert.equal(PL.extractCurrencySnippet('Cena: 12,99 zł brutto'), '12,99 zł');
  assert.equal(PL.extractCurrencySnippet('ab 1.299,00 € inkl. MwSt.'), '1.299,00 €');
  assert.equal(PL.extractCurrencySnippet('Now EUR 11.62'), 'EUR 11.62');
  assert.equal(PL.extractCurrencySnippet('₹139.00'), '₹139.00');
});

test('currency markers must not be part of words', () => {
  assert.equal(PL.hasCurrencyMarker('RTX 5060 Ti'), false);
  assert.equal(PL.hasCurrencyMarker('USDC 5'), false);
  assert.equal(PL.hasCurrencyMarker('129 kr'), true);
});

test('currencyCodeOf maps unambiguous symbols only', () => {
  assert.equal(PL.currencyCodeOf('€12'), 'EUR');
  assert.equal(PL.currencyCodeOf('12,99 zł'), 'PLN');
  assert.equal(PL.currencyCodeOf('CHF 5'), 'CHF');
  assert.equal(PL.currencyCodeOf('$12'), null);
  assert.equal(PL.currencyCodeOf('129 kr'), null);
});

// --- JSON-LD --------------------------------------------------------------

const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

test('JSON-LD: currency is captured', () => {
  const hit = PL.findPriceOnPage(parse(ld({ '@type': 'Product', offers: { price: '24.99', priceCurrency: 'EUR' } })));
  assert.equal(hit?.price, 24.99);
  assert.equal(hit?.currency, 'EUR');
});

test('JSON-LD: ProductGroup takes the first priced variant', () => {
  const doc = parse(ld({
    '@type': 'ProductGroup', name: 'Jogger',
    hasVariant: [
      { '@type': 'Product', sku: 'A', offers: { price: 40, priceCurrency: 'USD' } },
      { '@type': 'Product', sku: 'B', offers: { price: 45, priceCurrency: 'USD' } }
    ]
  }));
  assert.equal(PL.isProductPage(doc), true);
  assert.equal(PL.findPriceOnPage(doc)?.price, 40);
});

test('JSON-LD: ProductGroup picks the variant named in the URL', () => {
  const doc = parse(ld({
    '@type': 'ProductGroup',
    hasVariant: [
      { '@type': 'Product', sku: '111', offers: { price: 105, priceCurrency: 'USD' } },
      { '@type': 'Product', sku: '222', offers: { price: 32, priceCurrency: 'USD' } }
    ]
  }));
  assert.equal(PL.findPriceOnPage(doc, { pageUrl: 'https://shop.test/p/x?skuId=222' })?.price, 32);
});

test('JSON-LD: BuyAction.object and mainEntity are followed', () => {
  assert.equal(PL.findPriceOnPage(parse(ld({ '@type': 'BuyAction', object: { '@type': 'Product', offers: { price: '9.50' } } })))?.price, 9.5);
  assert.equal(PL.findPriceOnPage(parse(ld({ '@type': 'WebPage', mainEntity: { '@type': 'Product', offers: { price: 12 } } })))?.price, 12);
});

test('JSON-LD: strike-through priceSpecification is skipped', () => {
  const doc = parse(ld({
    '@type': 'Product',
    offers: { priceSpecification: [
      { '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/StrikethroughPrice', price: 99 },
      { '@type': 'UnitPriceSpecification', price: 79, priceCurrency: 'GBP' }
    ] }
  }));
  const hit = PL.findPriceOnPage(doc);
  assert.equal(hit?.price, 79);
  assert.equal(hit?.currency, 'GBP');
});

test('JSON-LD: slightly broken JSON is still read', () => {
  const html = `<script type="application/ld+json">{"@type": "Product", "name": "Line
break", "offers": {"price": "15.00",},}</script>`;
  assert.equal(PL.findPriceOnPage(parse(html))?.price, 15);
});

test('JSON-LD: a zero price is not a price', () => {
  assert.equal(PL.findPriceOnPage(parse(ld({ '@type': 'Product', offers: { price: '0.00' } }))), null);
});

test('JSON-LD: ItemList members (category pages) are ignored', () => {
  const doc = parse(ld({ '@type': 'ItemList', itemListElement: [{ '@type': 'Product', offers: { price: 5 } }] }));
  assert.equal(PL.findPriceOnPage(doc), null);
});

// HSN-style page: JSON-LD only has a 108-variant AggregateOffer range, and
// the meta tags carry the shown price plus a time-boxed sale price.
const hsnPage = `<html><head>
  <meta property="og:type" content="article">
  <meta property="product:price:currency" content="EUR">
  <meta property="product:price:amount" content="22.990001">
  <meta property="product:sale_price:currency" content="EUR">
  <meta property="product:sale_price:amount" content="19.701001">
  <meta property="product:sale_price_dates:start" content="2026-09-27 06:00:00">
  <meta property="product:sale_price_dates:end" content="2026-09-28 06:00:00">
  <meta property="product:price:amount" content="19.701001">
  ${ld({ '@type': 'Product', offers: { '@type': 'AggregateOffer', offerCount: 108, priceCurrency: 'EUR', lowPrice: '7.81', highPrice: '98.51' } })}
</head><body>
  <div class="price-box" data-role="priceBox"><span data-price-type="finalPrice" data-price-amount="3.454001">€3.45</span></div>
</body></html>`;

test('HSN: current sale price wins over the AggregateOffer low price', () => {
  const hit = PL.findPriceOnPage(parse(hsnPage), { hostname: 'www.hsnstore.eu', now: Date.parse('2026-09-27T20:00:00') });
  assert.ok(hit);
  assert.ok(Math.abs(hit!.price - 19.70) < 0.005, String(hit!.price));
  assert.equal(hit!.currency, 'EUR');
});

test('HSN: expired sale falls back to the regular price', () => {
  const hit = PL.findPriceOnPage(parse(hsnPage), { hostname: 'www.hsnstore.eu', now: Date.parse('2026-09-29T12:00:00') });
  assert.ok(Math.abs(hit!.price - 22.99) < 0.005, String(hit!.price));
});

test('AggregateOffer range is used only as a last resort', () => {
  const doc = parse(ld({ '@type': 'Product', offers: { '@type': 'AggregateOffer', lowPrice: '10', highPrice: '30', priceCurrency: 'USD' } }));
  const hit = PL.findPriceOnPage(doc);
  assert.equal(hit?.price, 10);
  assert.equal(hit?.source, 'json-ld-range');
});

// --- site rules -----------------------------------------------------------

test('Amazon: carousel prices are ignored when there is no buy box', () => {
  const html = `<html><body>
    <span id="productTitle">Cable</span>
    <div id="outOfStock">This item cannot be shipped to your selected delivery location.</div>
    <ol class="a-carousel"><li><span class="a-price"><span class="a-offscreen">$18.42</span></span></li></ol>
  </body></html>`;
  assert.equal(PL.findPriceOnPage(parse(html), { hostname: 'www.amazon.com' }), null);
});

test('Amazon: price is rebuilt from parts when a-offscreen lacks the decimal', () => {
  const html = `<html><body><span id="productTitle">Cable</span>
    <div id="corePriceDisplay_desktop_feature_div">
      <span class="a-price priceToPay"><span class="a-offscreen">EUR1842</span>
        <span aria-hidden="true"><span class="a-price-symbol">EUR</span><span class="a-price-whole">18<span class="a-price-decimal"></span></span><span class="a-price-fraction">42</span></span></span>
      <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">EUR25.00</span></span>
    </div></body></html>`;
  const hit = PL.findPriceOnPage(parse(html), { hostname: 'www.amazon.com' });
  assert.equal(hit?.price, 18.42);
  assert.equal(hit?.currency, 'EUR');
  assert.equal(hit?.raw, 'EUR18.42');
});

test('Amazon: strike-through list price is skipped', () => {
  const html = `<html><body><span id="productTitle">X</span>
    <div id="corePrice_feature_div">
      <span class="a-price a-text-price"><span class="a-offscreen">$30.00</span></span>
      <span class="a-price"><span class="a-offscreen">$21.00</span></span>
    </div></body></html>`;
  assert.equal(PL.findPriceOnPage(parse(html), { hostname: 'www.amazon.co.uk' })?.price, 21);
});

test('MediaMarkt: the struck-through RRP is excluded', () => {
  const html = `<html><body><div data-test="mms-product-price">
    <span>-31%</span><p data-test="mms-strike-price-type-rrp">UVP 649,– €649,00€</p>
    <span>444,– €</span><span>444,00€</span></div></body></html>`;
  const hit = PL.findPriceOnPage(parse(html), { hostname: 'www.mediamarkt.de' });
  assert.equal(hit?.price, 444);
});

test('Target and Newegg site rules', () => {
  assert.equal(PL.findPriceOnPage(parse('<span data-test="product-price">$19.99</span>'), { hostname: 'www.target.com' })?.price, 19.99);
  const newegg = `<div class="product-pane"><div class="product-price"><span class="price-current"></span><div class="price-current_2026">$220.00</div></div></div>`;
  assert.equal(PL.findPriceOnPage(parse(newegg), { hostname: 'www.newegg.com' })?.price, 220);
});

// --- generic fallback ----------------------------------------------------

test('generic fallback: product page price outside structured data', () => {
  const html = `<html><head><meta property="og:type" content="product"></head><body>
    <div class="product-price"><del>$29.99</del> <span>$19.99</span></div></body></html>`;
  assert.equal(PL.findPriceOnPage(parse(html), { hostname: 'shop.test' })?.price, 19.99);
});

test('generic fallback never runs on non-product pages', () => {
  const html = `<html><body><h1>Deals roundup</h1><div class="product-price">$19.99</div></body></html>`;
  assert.equal(PL.findPriceOnPage(parse(html), { hostname: 'blog.test' }), null);
});

test('generic fallback: Magento data-price-amount', () => {
  const html = `<html><body class="catalog-product-view"><div class="product-info-main">
    <span data-price-type="finalPrice" data-price-amount="89.9">89,90 €</span></div></body></html>`;
  const hit = PL.findPriceOnPage(parse(html), { hostname: 'shop.test' });
  assert.equal(hit?.price, 89.9);
});

// --- title and image -------------------------------------------------------

test('findTitle prefers the JSON-LD product name over og:title', () => {
  const doc = parse(`<html><head><title>Widget | Shop</title><meta property="og:title" content="Widget - Shop">
    ${ld({ '@type': 'Product', name: 'Widget Pro', offers: { price: 1 } })}</head></html>`);
  assert.equal(PL.findTitle(doc), 'Widget Pro');
});

test('findProductImage resolves relative and JSON-LD ImageObject urls', () => {
  const doc = parse(`<html><head>${ld({ '@type': 'Product', image: [{ '@type': 'ImageObject', url: '/img/a.jpg' }], offers: { price: 1 } })}</head></html>`);
  assert.equal(PL.findProductImage(doc, 'https://shop.test/p/1'), 'https://shop.test/img/a.jpg');
});
