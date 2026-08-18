import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  YahooAdapter,
  YahooClient,
  type TokenStore,
  type YahooCredentials,
  type YahooTokens,
} from '@ffe/adapters';

/**
 * Yahoo wiring for a personal tool.
 *
 * Tokens live in a gitignored file next to the repo rather than a database.
 * That is the right call for one user on one machine — a Postgres round trip
 * buys nothing here — and it is a single swap to a Supabase-backed store if
 * this ever serves more than one person.
 */

const TOKEN_PATH = join(process.cwd(), '..', '..', '.yahoo-tokens.json');

export class FileTokenStore implements TokenStore {
  async read(): Promise<YahooTokens | null> {
    try {
      return JSON.parse(await readFile(TOKEN_PATH, 'utf8')) as YahooTokens;
    } catch {
      return null;
    }
  }

  async write(tokens: YahooTokens): Promise<void> {
    await mkdir(dirname(TOKEN_PATH), { recursive: true });
    await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
  }
}

export const yahooCredentials = (): YahooCredentials | null => {
  const clientId = process.env.YAHOO_CLIENT_ID;
  const clientSecret = process.env.YAHOO_CLIENT_SECRET;
  const redirectUri = process.env.YAHOO_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
};

export const yahooAdapter = (): YahooAdapter | null => {
  const credentials = yahooCredentials();
  if (credentials === null) return null;
  return new YahooAdapter(new YahooClient(credentials, new FileTokenStore()));
};

export const isYahooConnected = async (): Promise<boolean> =>
  (await new FileTokenStore().read()) !== null;
