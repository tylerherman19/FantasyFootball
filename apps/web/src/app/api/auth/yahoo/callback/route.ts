import { NextResponse, type NextRequest } from 'next/server';
import { exchangeCode } from '@ffe/adapters';
import { FileTokenStore, yahooCredentials } from '@/lib/yahoo';

/**
 * Yahoo redirects here with an authorization code. Verify the state we issued,
 * exchange the code for tokens, store them, and send the user back to the app.
 */
export const GET = async (request: NextRequest) => {
  const credentials = yahooCredentials();
  if (credentials === null) {
    return NextResponse.json({ error: 'Yahoo not configured' }, { status: 500 });
  }

  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const expectedState = request.cookies.get('yahoo_oauth_state')?.value;

  if (code === null) {
    const error = request.nextUrl.searchParams.get('error') ?? 'no code returned';
    return NextResponse.json({ error: `Yahoo denied the request: ${error}` }, { status: 400 });
  }

  // A mismatched or missing state means this callback did not originate from a
  // flow we started. Refuse it rather than binding whatever account sent it.
  if (state === null || expectedState === undefined || state !== expectedState) {
    return NextResponse.json({ error: 'OAuth state mismatch — start the flow again' }, { status: 400 });
  }

  try {
    const tokens = await exchangeCode(credentials, code);
    await new FileTokenStore().write(tokens);
  } catch (error) {
    return NextResponse.json(
      { error: 'Token exchange failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }

  const response = NextResponse.redirect(new URL('/?yahoo=connected', request.nextUrl.origin));
  response.cookies.delete('yahoo_oauth_state');
  return response;
};
