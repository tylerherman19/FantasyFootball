export * from './domain/index.js';

// simulation
export { optimalLineup, lineupEfficiency, type LineupCandidate, type OptimalLineup } from './sim/lineup.js';
export { sampleWeek, DEFAULT_GAME_LOADING, type CorrelatedPlayer } from './sim/correlated.js';
export { seededRng, seedFrom, standardNormal, resample, type Rng } from './sim/random.js';
export {
  simulateSeason,
  type SeasonSimInput,
  type SeasonSimResult,
  type TeamOutcome,
  type TeamWeekProjection,
} from './sim/season.js';
export {
  projectSeason,
  projectTeamWeek,
  withRosterChange,
  type PlayerProjection,
  type ProjectionPool,
  type TeamContext,
} from './sim/roster-projection.js';

// decisions — everything priced in championship probability
export {
  currentOdds,
  extractOdds,
  oddsDelta,
  type OddsDelta,
  type OddsSnapshot,
  type RosterChange,
  type SimContext,
} from './decisions/odds.js';
export {
  rankWaivers,
  suggestBid,
  type WaiverCandidate,
  type WaiverInput,
  type WaiverRecommendation,
} from './decisions/waivers.js';
export {
  evaluateTrade,
  fairnessGap,
  findTrades,
  type TradeAsset,
  type TradeEvaluation,
  type TradeFinderInput,
  type TradeSide,
} from './decisions/trades.js';
export {
  compareStartSit,
  rankForSlot,
  type StartSitOption,
  type StartSitVerdict,
} from './decisions/start-sit.js';
