import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_MIN_AGE_MS, FAIL_WARN_THRESHOLD, alertMatch, applyHit, notifyReason, sanitizeAlert, sanitizeImported } from '../src/lib/tracking.ts';
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

test('sanitizeAlert keeps positive bounds in the right order', () => {
  assert.deepEqual(sanitizeAlert({ below: 99 }), { below: 99, above: null });
  assert.deepEqual(sanitizeAlert({ below: 80, above: 120 }), { below: 80, above: 120 });
  assert.equal(sanitizeAlert({ below: 120, above: 80 }), null);
  assert.equal(sanitizeAlert({ below: 100, above: 100 }), null);
  assert.equal(sanitizeAlert({ below: -1, above: 0 }), null);
  assert.equal(sanitizeAlert({ below: '99' }), null);
  assert.equal(sanitizeAlert(null), null);
});

test('alertMatch is inclusive at cent precision', () => {
  const alert = { below: 99, above: 150 };
  assert.equal(alertMatch(alert, 99), 'below');
  assert.equal(alertMatch(alert, 99.004), 'below');
  assert.equal(alertMatch(alert, 99.01), null);
  assert.equal(alertMatch(alert, 150), 'above');
  assert.equal(alertMatch(alert, 149.99), null);
  assert.equal(alertMatch(null, 10), null);
});

test('without an alert the global setting decides', () => {
  assert.equal(notifyReason({}, 100, 90, 'any'), 'change');
  assert.equal(notifyReason({}, 100, 110, 'any'), 'change');
  assert.equal(notifyReason({}, 100, 90, 'drop'), 'change');
  assert.equal(notifyReason({}, 100, 110, 'drop'), null);
});

test('a below alert fires on reaching the target and on further drops only', () => {
  const item = { alert: { below: 100, above: null } };
  assert.equal(notifyReason(item, 120, 110, 'any'), null, 'still above the target');
  assert.equal(notifyReason(item, 110, 100, 'any'), 'below', 'reached exactly');
  assert.equal(notifyReason(item, 120, 95, 'any'), 'below', 'crossed');
  assert.equal(notifyReason(item, 95, 90, 'any'), 'below', 'cheaper still');
  assert.equal(notifyReason(item, 90, 97, 'any'), null, 'rose but still below');
  assert.equal(notifyReason(item, 97, 105, 'any'), null, 'left the range');
  assert.equal(notifyReason(item, 105, 98, 'drop'), 'below', 're-entered');
});

test('an above alert fires even when only drops are notified', () => {
  const item = { alert: { below: null, above: 150 } };
  assert.equal(notifyReason(item, 140, 155, 'drop'), 'above');
  assert.equal(notifyReason(item, 155, 160, 'drop'), 'above');
  assert.equal(notifyReason(item, 160, 152, 'any'), null);
  assert.equal(notifyReason(item, 152, 120, 'any'), null, 'drops do not notify with an above alert');
});

test('a range alert fires on either side', () => {
  const item = { alert: { below: 80, above: 120 } };
  assert.equal(notifyReason(item, 100, 79, 'any'), 'below');
  assert.equal(notifyReason(item, 100, 125, 'any'), 'above');
  assert.equal(notifyReason(item, 100, 110, 'any'), null);
  assert.equal(notifyReason(item, 79, 125, 'any'), 'above', 'jumped across the range');
});

test('an invalid stored alert falls back to the global setting', () => {
  assert.equal(notifyReason({ alert: { below: 120, above: 80 } }, 100, 110, 'any'), 'change');
});

test('sanitizeImported keeps a valid alert and drops a broken one', () => {
  const ok = sanitizeImported({ url: 'https://shop.test/p/1', alert: { below: 50, above: null } })!;
  assert.deepEqual(ok.alert, { below: 50, above: null });
  const bad = sanitizeImported({ url: 'https://shop.test/p/1', alert: { below: 'x' } })!;
  assert.equal(bad.alert, undefined);
});
