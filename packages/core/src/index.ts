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
  starterPoints,
  withRosterChange,
  type PlayerProjection,
  type ProjectionPool,
  type TeamContext,
} from './sim/roster-projection.js';

// projections
export { scoreStatLine, scoringCoverage, type StatLine } from './projections/scoring.js';
export {
  applyAvailability,
  isRuledOut,
  playProbability,
  type AvailabilityAdjustment,
  type InjuryStatus,
} from './projections/availability.js';

// valuation
export {
  marketPickValues,
  pickInventory,
  valuePicks,
  type PickValueSource,
  type ValuedPick,
} from './valuation/picks.js';

// metrics
export { lineupEfficiencies, type EfficiencyResult } from './metrics/efficiency.js';
export {
  assessDepth,
  marginalValues,
  type DepthAssessment,
  type MarginalValue,
} from './metrics/marginal-value.js';

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
  estimateFutureGain,
  rankWaivers,
  suggestBid,
  type WaiverCandidate,
  type WaiverInput,
  type WaiverRecommendation,
} from './decisions/waivers.js';
export {
  analyzeRosters,
  offerCandidates,
  rankPartners,
  type FitScore,
  type RosterInput,
  type TeamRosterAnalysis,
} from './decisions/fit.js';
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
