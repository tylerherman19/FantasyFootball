import { AdapterError } from '../platform-adapter.js';

/**
 * Yahoo OAuth2, authorization-code flow.
 *
 * Yahoo is the only platform here that needs consent: Sleeper's data is public,
 * Yahoo's is not. The flow is the standard three-legged dance — send the user to
 * Yahoo, receive a code on the redirect, exchange it for tokens, then refresh
 * the access token forever using the long-lived refresh token.
 *
 * Yahoo requires an HTTPS redirect URI, including in development, which is why
 * the dev server runs with a certificate.
 */

const AUTHORIZE_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';

export interface YahooCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface YahooTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds. Refresh slightly early rather than racing expiry. */
  readonly expiresAt: number;
}

/**
 * Where to send the user.
 *
 * `state` is not decoration — it is what stops a third party from feeding us a
 * callback we never initiated, so the caller must generate it unpredictably and
 * verify it on return.
 */
export const authorizeUrl = (credentials: YahooCredentials, state: string): string => {
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: credentials.redirectUri,
    response_type: 'code',
    state,
    // Fantasy read scope. Yahoo grants it implicitly for approved apps, but
    // asking explicitly makes the consent screen honest about what we want.
    scope: 'fspt-r',
  });

  return `${AUTHORIZE_URL}?${params.toString()}`;
};

const basicAuth = (credentials: YahooCredentials): string =>
  Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
}

const requestTokens = async (
  credentials: YahooCredentials,
  body: URLSearchParams,
): Promise<YahooTokens> => {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basicAuth(credentials)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    throw new AdapterError('Yahoo token request failed', {
      status: response.status,
      detail: (await response.text()).slice(0, 300),
    });
  }

  const payload = (await response.json()) as TokenResponse;

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    // Expire a minute early so a request never starts with a token that dies
    // mid-flight.
    expiresAt: Date.now() + (payload.expires_in - 60) * 1000,
  };
};

export const exchangeCode = (credentials: YahooCredentials, code: string): Promise<YahooTokens> =>
  requestTokens(
    credentials,
    new URLSearchParams({
      grant_type: 'authorization_code',
      redirect_uri: credentials.redirectUri,
      code,
    }),
  );

export const refreshTokens = (
  credentials: YahooCredentials,
  refreshToken: string,
): Promise<YahooTokens> =>
  requestTokens(
    credentials,
    new URLSearchParams({
      grant_type: 'refresh_token',
      redirect_uri: credentials.redirectUri,
      refresh_token: refreshToken,
    }),
  );

export const isExpired = (tokens: YahooTokens): boolean => Date.now() >= tokens.expiresAt;
