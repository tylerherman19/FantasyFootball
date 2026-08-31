import { beforeEach, describe, expect, it } from 'vitest';
import { applyAvailability } from '@ffe/core';
import { designationWeek, forgetDesignations, rememberDesignations } from './availability';

const feed = (status: string | null) => ({ star: { injuryStatus: status, team: 'CIN' } });

describe('remembering a designation that was removed', () => {
  beforeEach(forgetDesignations);

  it('reports nothing to remember on a first read', () => {
    const week = designationWeek();
    expect(rememberDesignations(feed('Questionable'), week).star!.clearedFrom).toBeNull();
    expect(rememberDesignations(feed(null), week).star!.clearedFrom).toBe('Questionable');
  });

  it('does not flag a clearance while the tag is still showing', () => {
    const week = designationWeek();
    rememberDesignations(feed('Questionable'), week);
    const current = rememberDesignations(feed('Questionable'), week);

    // Both the play-probability haircut and the production discount would
    // otherwise apply, discounting him twice for one injury.
    expect(current.star!.clearedFrom).toBeNull();
    expect(current.star!.injuryStatus).toBe('Questionable');
  });

  it('remembers the worse designation when it changed during the week', () => {
    const week = designationWeek();
    rememberDesignations(feed('Questionable'), week);
    rememberDesignations(feed('Doubtful'), week);
    expect(rememberDesignations(feed(null), week).star!.clearedFrom).toBe('Doubtful');
  });

  it('forgets last week, so one bad Sunday does not follow a player all season', () => {
    const week = designationWeek();
    rememberDesignations(feed('Questionable'), week);
    expect(rememberDesignations(feed(null), week + 1).star!.clearedFrom).toBeNull();
  });

  it('ignores designations that mean out rather than hurt', () => {
    const week = designationWeek();
    // A player listed Out who is off the report has recovered. He is not
    // playing through anything and must not be discounted.
    rememberDesignations(feed('Out'), week);
    expect(rememberDesignations(feed(null), week).star!.clearedFrom).toBeNull();
  });

  it('rolls the week over on a Tuesday', () => {
    const monday = Date.UTC(2026, 8, 14, 12);
    const tuesday = Date.UTC(2026, 8, 15, 12);
    const sunday = Date.UTC(2026, 8, 13, 12);

    // Sunday and the Monday night game behind it share a week; Tuesday starts
    // the next injury-report cycle.
    expect(designationWeek(sunday)).toBe(designationWeek(monday));
    expect(designationWeek(tuesday)).toBe(designationWeek(monday) + 1);
  });
});

describe('pricing a player who was cleared', () => {
  it('charges the production discount without the availability haircut', () => {
    const midweek = applyAvailability(20, 6, 'Questionable', false);
    const cleared = applyAvailability(20, 6, null, false, 'Questionable');
    const healthy = applyAvailability(20, 6, null, false);

    // Midweek prices both halves: 0.593 to play, 0.774 of himself if he does.
    expect(midweek.mean).toBeCloseTo(20 * 0.593 * 0.774, 3);
    // Once he is active only the second half is still unresolved.
    expect(cleared.mean).toBeCloseTo(20 * 0.774, 3);
    expect(cleared.playProbability).toBe(1);
    // And he is still worth less than the same player in a healthy week, which
    // is the correction — before this he was priced identically to healthy.
    expect(cleared.mean).toBeLessThan(healthy.mean);
    expect(cleared.mean).toBeGreaterThan(midweek.mean);
  });

  it('says why, so the lineup board can show the reason', () => {
    expect(applyAvailability(20, 6, null, false, 'Questionable').note).toMatch(/cleared from/);
  });

  it('leaves a healthy player entirely alone', () => {
    const healthy = applyAvailability(20, 6, null, false, null);
    expect(healthy.mean).toBe(20);
    expect(healthy.sd).toBe(6);
    expect(healthy.note).toBeNull();
  });

  it('does not discount a clearance we have no measurement for', () => {
    // Of 529 Doubtful players, four recorded a stat line. Any ratio from that
    // is one afternoon, so the model declines to invent a number.
    const cleared = applyAvailability(20, 6, null, false, 'Doubtful');
    expect(cleared.mean).toBe(20);
  });

  it('still zeroes a bye, whatever he was cleared from', () => {
    expect(applyAvailability(20, 6, null, true, 'Questionable').mean).toBe(0);
  });
});
