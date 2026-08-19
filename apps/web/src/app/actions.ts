'use server';

import { redirect } from 'next/navigation';
import { listLeagues, resolveUser } from '@/lib/league-data';
import { clearSession, defaultSeason, writeSession } from '@/lib/session';

/**
 * Sign in by naming your Sleeper account.
 *
 * Every failure is reported as itself. "No leagues found" and "no such user"
 * look identical from the outside and have completely different fixes, and
 * collapsing them into one message is how a working handle gets mistaken for a
 * broken site.
 */

export interface SignInState {
  readonly error: string | null;
  readonly username?: string;
  readonly season?: number;
}

export const signIn = async (_previous: SignInState, form: FormData): Promise<SignInState> => {
  const username = String(form.get('username') ?? '').trim();
  const season = Number(form.get('season') ?? defaultSeason());

  if (username === '') {
    return { error: 'Enter your Sleeper username.', season };
  }

  const userId = await resolveUser(username);
  if (userId === null) {
    return {
      error: `Sleeper has no account called “${username}”. Check the spelling — it's your username, not your team name.`,
      username,
      season,
    };
  }

  const leagues = await listLeagues(username, season);
  if (leagues.length === 0) {
    return {
      error: `${username} exists, but has no leagues in ${season}. Try another season.`,
      username,
      season,
    };
  }

  await writeSession({ username, userId, season });
  redirect('/');
};

export const signOut = async (): Promise<void> => {
  await clearSession();
  redirect('/');
};

/** Look at a different season without signing out. */
export const switchSeason = async (form: FormData): Promise<void> => {
  const username = String(form.get('username') ?? '');
  const userId = String(form.get('userId') ?? '');
  const season = Number(form.get('season') ?? defaultSeason());

  if (username !== '') await writeSession({ username, userId, season });
  redirect('/');
};
