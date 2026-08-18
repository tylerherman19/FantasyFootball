import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { authorizeUrl } from '@ffe/adapters';
import { yahooCredentials } from '@/lib/yahoo';

/**
 * Start the Yahoo consent flow.
 *
 * The `state` value is stored in an httpOnly cookie and checked on the way back.
 * Without it, anyone could hand us a callback we never initiated and bind their
 * Yahoo account to this session.
 */
export const GET = async () => {
  const credentials = yahooCredentials();
  if (credentials === null) {
    return NextResponse.json(
      { error: 'Yahoo not configured — set YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET and YAHOO_REDIRECT_URI' },
      { status: 500 },
    );
  }

  const state = randomBytes(16).toString('hex');
  const response = NextResponse.redirect(authorizeUrl(credentials, state));

  response.cookies.set('yahoo_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    maxAge: 600,
    path: '/',
  });

  return response;
};
