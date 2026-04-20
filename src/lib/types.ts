// Shared types for storage, messages, and parsed prices.

export interface PriceHit {
  price: number;
  raw: string;
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
}

export interface LastDetected {
  url: string;
  price: number;
  raw: string;
  title: string | null;
  image?: string | null;
  updatedAt: number;
}

export interface StorageShape {
  tracked?: TrackedItem[];
  checkIntervalMinutes?: number;
  badgeCount?: number;
  normalizedV2?: boolean;
  lastDetected?: LastDetected;
}

// Message contract between UI/content/background. Discriminated by `action`.

export interface GetPriceMessage { action: 'getPrice'; }
export interface StartSelectMessage { action: 'startSelect'; }
export interface IsProductPageMessage { action: 'isProductPage'; }
export interface RunCheckMessage { action: 'runCheck'; force?: boolean; }
export interface NormalizePriceMessage { action: 'normalizePrice'; raw: string; }
export interface ClearBadgeMessage { action: 'clearBadge'; }
export interface ManualSelectResultMessage {
  action: 'manualSelectResult';
  item: {
    url: string;
    selector: string | null;
    raw: string;
    price: number | null;
    title: string | null;
    image?: string | null;
  };
}

export type Message =
  | GetPriceMessage
  | StartSelectMessage
  | IsProductPageMessage
  | RunCheckMessage
  | NormalizePriceMessage
  | ClearBadgeMessage
  | ManualSelectResultMessage;

export interface GetPriceResponse {
  price?: number;
  raw?: string;
  title?: string | null;
  image?: string | null;
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
  durationMs: number;
}

export interface FindPriceOptions {
  hostname?: string;
  preferredSelector?: string | null;
}
