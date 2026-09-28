// Shared types for storage, messages, and parsed prices.

export interface PriceHit {
  price: number;
  raw: string;
  // ISO 4217 code when known (structured data, or an unambiguous symbol).
  currency?: string | null;
  // Which detector matched, e.g. "json-ld", "meta", "site:amazon". Debug aid.
  source?: string;
}

export interface NormalizedPrice {
  raw: string;
  price: number | null;
  currencySymbol: string | null;
}

export interface HistoryEntry {
  ts: number;
  price: number | null;
  raw: string;
}

// A changed price seen once but not yet confirmed by a second observation.
// Guards against sites that briefly serve a wrong price (cache flips,
// flash-sale boundaries), which used to cause false notifications.
export interface PendingPrice {
  price: number;
  raw: string;
  currency?: string | null;
  firstSeen: number;
  // 'visit' when first seen by the content script; those commit silently.
  source?: 'check' | 'visit';
}

export interface TrackedItem {
  url: string;
  title: string;
  lastPrice: number | null;
  lastRaw: string;
  selector: string | null;
  image?: string | null;
  updatedAt: number;
  lastChecked: number;
  history: HistoryEntry[];
  // Consecutive background-check failures. Reset to 0 when a price is found.
  // When >= FAIL_WARN_THRESHOLD, the UI surfaces a warning so the user knows
  // the item can't be auto-checked (typically a JS-rendered page).
  failedChecks?: number;
  // ISO 4217 code for lastPrice, when known.
  currency?: string | null;
  // Why the last background check failed ("HTTP 403", "No price found", ...).
  lastError?: string | null;
  // When the item was first tracked.
  addedAt?: number;
  pending?: PendingPrice | null;
  // Set once by the v0.4 upgrade migration. The first price change after the
  // upgrade may only reflect the improved detector (e.g. the shown price
  // instead of the cheapest variant), so it is recorded without notifying.
  quietNextChange?: boolean;
}

export interface LastDetected {
  url: string;
  price: number;
  raw: string;
  title: string | null;
  image?: string | null;
  currency?: string | null;
  updatedAt: number;
}

export type NotifyOn = 'any' | 'drop';

export interface StorageShape {
  tracked?: TrackedItem[];
  checkIntervalMinutes?: number;
  badgeCount?: number;
  normalizedV2?: boolean;
  normalizedV3?: boolean;
  lastDetected?: LastDetected;
  notifyOn?: NotifyOn;
  lastRunAt?: number;
}

// Message contract between UI/content/background. Discriminated by `action`.
// The background is the only writer of `tracked`; everything else asks it.

export interface GetPriceMessage { action: 'getPrice'; }
export interface StartSelectMessage { action: 'startSelect'; }
export interface IsProductPageMessage { action: 'isProductPage'; }
export interface RunCheckMessage { action: 'runCheck'; force?: boolean; url?: string; }
export interface ClearBadgeMessage { action: 'clearBadge'; }

export interface PickedItem {
  url: string;
  selector: string | null;
  raw: string;
  price: number | null;
  title: string | null;
  image?: string | null;
  currency?: string | null;
}

export interface ManualSelectResultMessage {
  action: 'manualSelectResult';
  item: PickedItem;
}
export interface TrackItemMessage { action: 'trackItem'; item: PickedItem; }
export interface RemoveItemMessage { action: 'removeItem'; url: string; }
export interface VisitUpdateMessage {
  action: 'visitUpdate';
  url: string;
  price: number;
  raw: string;
  currency?: string | null;
  image?: string | null;
}
export interface ImportItemsMessage { action: 'importItems'; items: unknown[]; }

export type Message =
  | GetPriceMessage
  | StartSelectMessage
  | IsProductPageMessage
  | RunCheckMessage
  | ClearBadgeMessage
  | ManualSelectResultMessage
  | TrackItemMessage
  | RemoveItemMessage
  | VisitUpdateMessage
  | ImportItemsMessage;

export interface GetPriceResponse {
  price?: number;
  raw?: string;
  title?: string | null;
  image?: string | null;
  currency?: string | null;
}

export interface StartSelectResponse {
  selector?: string | null;
  raw?: string;
  price?: number | null;
  title?: string | null;
}

export interface RunCheckResponse {
  checked: number;
  skipped: number;
  changed?: number;
  failed?: number;
  durationMs: number;
}

export interface ImportResponse {
  added: number;
  updated: number;
  skipped: number;
}

export interface FindPriceOptions {
  hostname?: string;
  preferredSelector?: string | null;
  // Page URL, used to pick the matching variant of a schema.org ProductGroup.
  pageUrl?: string;
  // Clock for sale-date checks (tests).
  now?: number;
}
