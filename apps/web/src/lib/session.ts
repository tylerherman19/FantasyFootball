import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Who is looking, and at which season.
 *
 * Sleeper is a public, unauthenticated API: a username is enough to read
 * everything the platform will show anyone, and there is no password to hold.
 * So "signing in" here means naming yourself — we resolve the handle to a
 * platform account id once, and remember it.
 *
 * That distinction matters for the one thing this fixes. Identity used to come
 * from a build-time environment variable, which meant every visitor loaded the
 * same person's leagues and no visitor could ever be found inside them. The
 * page rendered fine and was useless: "your team" resolved to nobody, so start/
 * sit, waivers and trades all had nothing to talk about.
 *
 * The cookie carries no secret and grants no privilege — it is a preference,
 * and it is readable by the client on purpose so the UI can show who you are
 * without a round trip.
 */

const COOKIE = 'ffe_session';
const MAX_AGE = 400 * 24 * 60 * 60; // The longest a browser will keep it.

export interface Session {
  readonly username: string;
  /** Sleeper's account id, resolved once at sign-in. */
  readonly userId: string;
  readonly season: number;
}

/**
 * The season to default to.
 *
 * Sleeper rolls leagues over in the winter, so from January to July the season
 * people mean is usually the one just finished — asking for 2027 leagues in
 * February returns an empty list and reads as "your leagues are gone".
 */
export const defaultSeason = (now: Date = new Date()): number => {
  const configured = Number(process.env.SEASON);
  if (Number.isFinite(configured) && configured > 2000) return configured;

  const year = now.getFullYear();
  return now.getMonth() < 6 ? year - 1 : year;
};

export const readSession = async (): Promise<Session | null> => {
  const raw = (await cookies()).get(COOKIE)?.value;

  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as Partial<Session>;
      if (typeof parsed.username === 'string' && typeof parsed.userId === 'string') {
        return {
          username: parsed.username,
          userId: parsed.userId,
          season: Number(parsed.season) || defaultSeason(),
        };
      }
    } catch {
      // A malformed cookie is the same as no cookie.
    }
  }

  // A single-user deployment can still pin an account without signing in.
  const fallback = process.env.SLEEPER_USERNAME;
  if (fallback !== undefined && fallback !== '') {
    return { username: fallback, userId: '', season: defaultSeason() };
  }

  return null;
};

export const writeSession = async (session: Session): Promise<void> => {
  (await cookies()).set(COOKIE, JSON.stringify(session), {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE,
    path: '/',
  });
};

export const clearSession = async (): Promise<void> => {
  (await cookies()).delete(COOKIE);
};

/**
 * The session, or back to the front door.
 *
 * League pages are meaningless without knowing whose team is whose — the whole
 * product is "what does this do to *your* odds" — so an unidentified visitor is
 * sent to sign in rather than shown a page with every personal answer blanked.
 */
export const requireSession = async (): Promise<Session> => {
  const session = await readSession();
  if (session === null) redirect('/');
  return session;
};
