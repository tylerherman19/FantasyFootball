import { AdapterError } from '../platform-adapter.js';
import { isExpired, refreshTokens, type YahooCredentials, type YahooTokens } from './oauth.js';

/**
 * Yahoo Fantasy API client.
 *
 * Two things make this messier than Sleeper, and both are absorbed here so the
 * adapter above stays readable:
 *
 * 1. The API is XML-first. `?format=json` works, but the JSON is a transliteration
 *    of the XML rather than a designed shape — collections arrive as objects
 *    keyed by numeric strings with a `count` sibling, and entities arrive as
 *    arrays whose elements are heterogeneous fragments to be merged.
 * 2. Access tokens expire hourly, so every call may need a refresh first.
 */

const BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';

/** Persist tokens between processes; a personal tool still shouldn't re-auth hourly. */
export interface TokenStore {
  read(): Promise<YahooTokens | null>;
  write(tokens: YahooTokens): Promise<void>;
}

export class YahooClient {
  #tokens: YahooTokens | null = null;

  constructor(
    private readonly credentials: YahooCredentials,
    private readonly store: TokenStore,
  ) {}

  async #accessToken(): Promise<string> {
    this.#tokens ??= await this.store.read();
    if (this.#tokens === null) {
      throw new AdapterError('Yahoo not connected — authorize the app first');
    }

    if (isExpired(this.#tokens)) {
      this.#tokens = await refreshTokens(this.credentials, this.#tokens.refreshToken);
      await this.store.write(this.#tokens);
    }

    return this.#tokens.accessToken;
  }

  async get<T = unknown>(path: string): Promise<T> {
    const token = await this.#accessToken();
    const separator = path.includes('?') ? '&' : '?';

    const response = await fetch(`${BASE}${path}${separator}format=json`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });

    if (!response.ok) {
      throw new AdapterError('Yahoo API request failed', {
        path,
        status: response.status,
        detail: (await response.text()).slice(0, 300),
      });
    }

    return (await response.json()) as T;
  }
}

/**
 * Yahoo returns collections as `{ "0": {...}, "1": {...}, count: 2 }`.
 * Turn that into an array, dropping the count and anything non-numeric.
 */
export const collection = (node: unknown): unknown[] => {
  if (node === null || typeof node !== 'object') return [];

  const record = node as Record<string, unknown>;
  const out: unknown[] = [];

  for (const [key, value] of Object.entries(record)) {
    if (!/^\d+$/.test(key)) continue;
    out.push(value);
  }

  return out;
};

/**
 * Entities arrive as arrays of partial objects — `[{team_key}, {name}, ...]` —
 * that have to be merged to recover the whole thing. Nested arrays occur too,
 * so merging recurses one level.
 */
export const mergeFragments = (node: unknown): Record<string, unknown> => {
  const merged: Record<string, unknown> = {};

  const absorb = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) absorb(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      Object.assign(merged, value as Record<string, unknown>);
    }
  };

  absorb(node);
  return merged;
};

export const asNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value);
