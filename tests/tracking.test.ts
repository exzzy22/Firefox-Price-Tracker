import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_MIN_AGE_MS, FAIL_WARN_THRESHOLD, applyHit, sanitizeImported } from '../src/lib/tracking.ts';
import type { TrackedItem } from '../src/lib/types.ts';

const T0 = 1_700_000_000_000;
const make = (price: number, extra: Partial<TrackedItem> = {}): TrackedItem => ({
  url: 'https://shop.test/p/1', title: 'X', lastPrice: price, lastRaw: `€${price}`, selector: null,
  updatedAt: T0, lastChecked: T0, currency: 'EUR', history: [{ ts: T0, price, raw: `€${price}` }], ...extra
});
const hit = (price: number) => ({ price, raw: `EUR ${price}`, currency: 'EUR' });

test('a new price is held as pending, not recorded', () => {
  const item = make(22.99);
  const r = applyHit(item, hit(7.81), 'check', T0 + 1000);
  assert.equal(r.pending, true);
  assert.equal(r.notify, null);
  assert.equal(item.lastPrice, 22.99);
  assert.equal(item.pending?.price, 7.81);
  assert.equal(item.history.length, 1);
});

test('a blip that reverts is dropped silently', () => {
  const item = make(22.99);
  applyHit(item, hit(7.81), 'check', T0 + 1000);
  const r = applyHit(item, hit(22.99), 'check', T0 + CONFIRM_MIN_AGE_MS + 5000);
  assert.equal(r.changed, false);
  assert.equal(item.pending, null);
  assert.equal(item.history.length, 1);
});

test('the same new price seen again later is committed and notified', () => {
  const item = make(22.99);
  applyHit(item, hit(19.70), 'check', T0);
  const early = applyHit(item, hit(19.70), 'check', T0 + 10_000);
  assert.equal(early.changed, false, 'too soon to confirm');
  const r = applyHit(item, hit(19.70), 'check', T0 + CONFIRM_MIN_AGE_MS);
  assert.equal(r.changed, true);
  assert.deepEqual(r.notify, { prev: 22.99, prevRaw: '€22.99' });
  assert.equal(item.lastPrice, 19.70);
  assert.equal(item.history.length, 2);
});

test('sub-cent differences are the same price', () => {
  const item = make(19.70);
  const r = applyHit(item, hit(19.701001), 'check', T0 + 1);
  assert.equal(r.pending, false);
  assert.equal(item.pending ?? null, null);
});

test('visit-originated changes commit without a notification', () => {
  const item = make(50);
  applyHit(item, hit(45), 'visit', T0);
  const r = applyHit(item, hit(45), 'check', T0 + CONFIRM_MIN_AGE_MS);
  assert.equal(r.changed, true);
  assert.equal(r.notify, null);
});

test('visits update items the background cannot read', () => {
  const item = make(50, { failedChecks: FAIL_WARN_THRESHOLD });
  const r = applyHit(item, hit(45), 'visit', T0);
  assert.equal(r.changed, true);
  assert.equal(item.lastPrice, 45);
});

test('first price for an item without one is committed directly', () => {
  const item = make(0, { lastPrice: null, history: [] });
  const r = applyHit(item, hit(10), 'check', T0);
  assert.equal(r.changed, true);
  assert.equal(r.notify, null);
  assert.equal(item.lastPrice, 10);
});

test('sanitizeImported rejects non-web urls and cleans fields', () => {
  assert.equal(sanitizeImported({ url: 'javascript:alert(1)' }), null);
  assert.equal(sanitizeImported('nope'), null);
  const item = sanitizeImported({ url: 'https://shop.test/p/1', lastPrice: '12', image: 'data:image/png;base64,xx', currency: 'eur', history: [{ ts: 1, price: 5 }, { bad: true }] })!;
  assert.equal(item.lastPrice, null);
  assert.equal(item.image, null);
  assert.equal(item.currency, 'EUR');
  assert.equal(item.history.length, 1);
});

test('after the upgrade, the first confirmed change is recorded quietly', () => {
  const item = make(7.81, { quietNextChange: true });
  applyHit(item, hit(19.70), 'check', T0);
  const r = applyHit(item, hit(19.70), 'check', T0 + CONFIRM_MIN_AGE_MS);
  assert.equal(r.changed, true);
  assert.equal(r.notify, null);
  assert.equal(item.quietNextChange, undefined);
  applyHit(item, hit(17.50), 'check', T0 + CONFIRM_MIN_AGE_MS + 1000);
  const next = applyHit(item, hit(17.50), 'check', T0 + 2 * CONFIRM_MIN_AGE_MS + 1000);
  assert.deepEqual(next.notify, { prev: 19.70, prevRaw: 'EUR 19.7' });
});

test('an unchanged price clears the upgrade flag', () => {
  const item = make(20, { quietNextChange: true });
  applyHit(item, hit(20), 'check', T0);
  assert.equal(item.quietNextChange, undefined);
});
