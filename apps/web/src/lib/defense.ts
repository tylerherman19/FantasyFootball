import { readArtifactFile } from './projections';

/**
 * What the defense on the other side does to your players.
 *
 * A projection says a receiver will catch five for sixty. It does not say that
 * he is facing the defense that has allowed the fewest deep shots in football,
 * and that most of his sixty is priced on throws that defense does not permit.
 * That gap is what this closes.
 *
 * The profiles come from `model/export_defense.py`, which measures consequences
 * from play-by-play rather than reading coverage labels off charting data —
 * see that file for why. The translation from "what a defense does" to "what it
 * does to a fantasy position" is here, and it rests on one structural fact
 * about football that shows up cleanly in the numbers:
 *
 *   **A defense cannot take away the deep ball and the run at the same time.**
 *
 * Two safeties deep means one fewer defender in the box. Everything follows
 * from that trade. A defense playing it high and soft holds the ceiling down on
 * outside receivers and quarterbacks — nothing is thrown far, so yards come
 * after the catch — while handing volume to tight ends and backs underneath and
 * giving up yards on the ground. A defense playing single-high with a loaded
 * box does the exact opposite: it strangles the run and concedes shots.
 *
 * Neither is "good" or "bad" in the abstract. They are opposite bets, and which
 * one your opponent is making decides which of your players it hurts. In this
 * league's data the spread is not subtle: the softest defense allows tight ends
 * 31% of targets, the hardest 20%.
 */

export interface DefenseProfile {
  readonly team: string;
  readonly games: number;
  readonly dropbacks: number;
  /** Average depth of target allowed, in yards past the line. */
  readonly adotAllowed: number;
  /** Share of attempts thrown 20+ yards downfield. */
  readonly deepRateAllowed: number;
  readonly completionRateAllowed: number;
  readonly ypaAllowed: number;
  /** Share of receiving yards earned after the catch rather than in the air. */
  readonly yacShareAllowed: number;
  readonly explosivePassRateAllowed: number;
  readonly sackRate: number;
  readonly qbHitRate: number;
  readonly intRate: number;
  readonly ypcAllowed: number;
  readonly explosiveRushRateAllowed: number;
  readonly targetShareAllowed: Readonly<Record<string, number>>;
  /** Opponent-adjusted, in the metric's own units. Negative favours the defense. */
  readonly adotAdjusted: number;
  readonly passEpaAdjusted: number;
  readonly rushEpaAdjusted: number;
  /** Positive = keeps everything in front. Negative = single-high, loaded box. */
  readonly shellIndex: number;
  readonly pressureIndex: number;
}

export interface DefenseArtifact {
  readonly modelVersion: string;
  readonly generatedAt: string;
  readonly seasons: readonly number[];
  readonly teamCount: number;
  readonly leagueAverage: Readonly<Record<string, number>>;
  readonly teams: Readonly<Record<string, DefenseProfile>>;
}

let cache: DefenseArtifact | null | undefined;

export const loadDefenses = async (): Promise<DefenseArtifact | null> => {
  if (cache !== undefined) return cache;

  const raw = await readArtifactFile('defense-scheme.json');
  try {
    cache = raw === null ? null : (JSON.parse(raw) as DefenseArtifact);
  } catch {
    cache = null;
  }
  return cache;
};

/**
 * Who a player faces this week, read out of the game id.
 *
 * The projection artifact stamps each player with the NFL game he appears in,
 * formatted `2026_01_WAS_PHI` — away then home. His opponent is whichever of
 * the two isn't his own team, which means the matchup comes free with data the
 * page already has rather than needing a schedule lookup.
 */
export const opponentFrom = (gameId: string, team: string): string | null => {
  const parts = gameId.split('_');
  if (parts.length < 4) return null;

  const away = parts[2] ?? '';
  const home = parts[3] ?? '';
  if (team === home) return away;
  if (team === away) return home;
  return null;
};

/** How a defensive tendency lands on one fantasy position. */
export interface MatchupEffect {
  /** -1 (hostile) to +1 (favourable), for colouring. */
  readonly score: number;
  readonly headline: string;
  readonly detail: string;
}

const clamp = (value: number): number => Math.max(-1, Math.min(1, value));

const rank = (
  profiles: readonly DefenseProfile[],
  team: string,
  of: (profile: DefenseProfile) => number,
  ascending = true,
): number => {
  const mine = profiles.find((profile) => profile.team === team);
  if (mine === undefined) return 0;
  const value = of(mine);
  return profiles.filter((profile) => (ascending ? of(profile) < value : of(profile) > value)).length + 1;
};

const ordinal = (n: number): string => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
};

/**
 * The scheme read, per position.
 *
 * Each is a claim that can be checked against the numbers next to it, which is
 * the point — a matchup rating nobody can audit is just a vibe with a colour.
 */
export const matchupFor = (
  position: string,
  defense: DefenseProfile,
  all: readonly DefenseProfile[],
): MatchupEffect => {
  const average = (of: (profile: DefenseProfile) => number): number =>
    all.reduce((sum, profile) => sum + of(profile), 0) / Math.max(all.length, 1);

  const shell = defense.shellIndex;
  const teams = all.length;

  switch (position) {
    case 'QB': {
      // Two things move a quarterback, and they are separate: whether the deep
      // shot exists, and whether he is allowed to stand up long enough to take
      // it. A soft shell with no pass rush is a completion-percentage day with
      // a low ceiling; a loaded box with pressure is the boom-or-bust one.
      const pressureRank = rank(all, defense.team, (p) => p.sackRate + p.qbHitRate, false);
      const epaRank = rank(all, defense.team, (p) => p.passEpaAdjusted);

      const score = clamp(defense.passEpaAdjusted * 6 - defense.pressureIndex * 0.25);
      const deepRead =
        shell > 0.4
          ? 'Ceiling capped — they take the deep ball away'
          : shell < -0.4
            ? 'Shots are available downfield'
            : 'Balanced coverage look';

      return {
        score,
        headline: deepRead,
        detail: `${defense.adotAllowed.toFixed(1)} yd average depth allowed (league ${average((p) => p.adotAllowed).toFixed(1)}), ${(defense.deepRateAllowed * 100).toFixed(1)}% of throws 20+ downfield. ${ordinal(pressureRank)} of ${teams} in pressure — ${(defense.sackRate * 100).toFixed(1)}% sack rate. ${ordinal(epaRank)} toughest by adjusted EPA per dropback.`,
      };
    }

    case 'WR': {
      // Receivers are the position two-high hurts most, and it hurts them twice:
      // the throws get shorter *and* there are fewer of them, because the ball
      // goes underneath to somebody else.
      const share = defense.targetShareAllowed.WR ?? 0;
      const shareAverage = average((p) => p.targetShareAllowed.WR ?? 0);
      const explosiveRank = rank(all, defense.team, (p) => p.explosivePassRateAllowed);

      const score = clamp(-shell * 0.45 + (share - shareAverage) * 6 + defense.passEpaAdjusted * 3);

      return {
        score,
        headline:
          shell > 0.4
            ? 'Squeezed — everything underneath'
            : shell < -0.4
              ? 'Room to run past them'
              : 'Neutral for outside receivers',
        detail: `Receivers take ${(share * 100).toFixed(0)}% of targets against them (league ${(shareAverage * 100).toFixed(0)}%). ${(defense.yacShareAllowed * 100).toFixed(0)}% of receiving yards allowed come after the catch, so production needs to be earned rather than thrown. ${ordinal(explosiveRank)} of ${teams} at preventing 20+ yard catches.`,
      };
    }

    case 'TE': {
      // The mirror of the receiver read. Everything two-high takes from the
      // outside has to go somewhere, and the tight end is usually where.
      const share = defense.targetShareAllowed.TE ?? 0;
      const shareAverage = average((p) => p.targetShareAllowed.TE ?? 0);
      const shareRank = rank(all, defense.team, (p) => p.targetShareAllowed.TE ?? 0, false);

      const score = clamp((share - shareAverage) * 14 + shell * 0.2);

      return {
        score,
        headline:
          share > shareAverage * 1.12
            ? 'Volume gets funnelled here'
            : share < shareAverage * 0.88
              ? 'They take the tight end away'
              : 'Ordinary tight end matchup',
        detail: `Tight ends see ${(share * 100).toFixed(0)}% of targets against them — ${ordinal(shareRank)} most of ${teams}, against a league average of ${(shareAverage * 100).toFixed(0)}%. When the deep ball is covered the ball goes to the middle, and this is where it lands.`,
      };
    }

    case 'RB': {
      // The other half of the trade. A light box is a light box whether or not
      // anyone charts it, and it shows up as yards on the ground.
      const rushRank = rank(all, defense.team, (p) => p.rushEpaAdjusted, false);
      const share = defense.targetShareAllowed.RB ?? 0;
      const shareAverage = average((p) => p.targetShareAllowed.RB ?? 0);

      const score = clamp(defense.rushEpaAdjusted * 7 + (share - shareAverage) * 5);

      // "32nd most generous of 32" is technically true and reads like nonsense.
      // Past the midpoint, count from the other end and say "toughest".
      const rushRead =
        rushRank <= all.length / 2
          ? `${ordinal(rushRank)} most generous of ${teams}`
          : `${ordinal(teams + 1 - rushRank)} toughest of ${teams}`;

      return {
        score,
        headline:
          defense.rushEpaAdjusted > 0.02
            ? 'Run game should work'
            : defense.rushEpaAdjusted < -0.05
              ? 'Front is stout — hard yards'
              : 'Average run matchup',
        detail: `${defense.ypcAllowed.toFixed(1)} yards per carry allowed, ${(defense.explosiveRushRateAllowed * 100).toFixed(0)}% of runs going 10+ — ${rushRead} on adjusted EPA per rush. Backs also take ${(share * 100).toFixed(0)}% of targets against them (league ${(shareAverage * 100).toFixed(0)}%).`,
      };
    }

    default:
      return { score: 0, headline: 'No scheme read', detail: 'Not a position this translation covers.' };
  }
};

/** Plain-language name for where a defense sits on the shell continuum. */
export const shellLabel = (shellIndex: number): string => {
  if (shellIndex > 0.6) return 'Two-high, keeps it in front';
  if (shellIndex > 0.2) return 'Leans two-high';
  if (shellIndex < -0.6) return 'Single-high, loaded box';
  if (shellIndex < -0.2) return 'Leans single-high';
  return 'Balanced';
};
