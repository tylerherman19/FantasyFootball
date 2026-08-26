'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { TeamProfile } from '@/lib/league-analytics';
import {
  CellBar,
  Legend,
  RangeBar,
  Sparkline,
  StackedBar,
  formatPct,
  positionColor,
} from '@/components/charts/primitives';

type Lens = 'roster' | 'projection' | 'value' | 'odds';

const LENS_COPY: Record<Lens, { title: string; body: string }> = {
  roster: {
    title: 'Roster construction',
    body: 'Every rostered player is shown below. Starter is the optimal league-specific lineup, not the platform lineup.',
  },
  projection: {
    title: 'Score range',
    body: 'P25/P50/P75 come from the same calibrated weekly spread used by the simulator. They are outcome ranges, not confidence intervals around the mean.',
  },
  value: {
    title: 'Market value',
    body: 'Roster and player values use the league’s selected dynasty market. Value is kept separate from projected points so productive veterans and liquid young assets are not treated as the same thing.',
  },
  odds: {
    title: 'Season odds',
    body: 'Projected wins, playoff odds and title odds come from the same simulated seasons. The playoff bar includes the simulation’s sampling interval.',
  },
};

export function TeamPowerExplorer({
  leagueId,
  profiles,
  positions,
  hasMarket,
  hasHistory,
  iterations,
}: {
  leagueId: string;
  profiles: readonly TeamProfile[];
  positions: readonly string[];
  hasMarket: boolean;
  hasHistory: boolean;
  iterations: number;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>('roster');

  const selected = useMemo(
    () => profiles.find((profile) => profile.teamId === selectedId) ?? null,
    [profiles, selectedId],
  );
  const maxStarterPoints = Math.max(...profiles.map((profile) => profile.starterPoints), 1);
  const maxTotalValue = Math.max(...profiles.map((profile) => profile.marketValue), 1);
  const standardError = (probability: number): number =>
    Math.sqrt(Math.max(probability * (1 - probability), 0) / Math.max(iterations, 1));

  const open = (teamId: string, nextLens: Lens) => {
    setSelectedId(teamId);
    setLens(nextLens);
  };

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
          Select a team or any metric to open its evidence.
        </p>
        <Legend items={positions.map((position) => ({ label: position, color: positionColor(position) }))} />
      </div>
      <div className="panel scroll-x">
        <table className="data-table power-explorer-table" style={{ minWidth: '58rem' }}>
          <thead>
            <tr>
              <th style={{ width: '2rem' }}>#</th>
              <th style={{ minWidth: '9rem' }}>Team</th>
              <th style={{ width: '17rem' }}>Starter points by position</th>
              <th className="text-right">Start</th>
              <th className="text-right">Bench</th>
              {hasMarket && <th className="text-right">Value</th>}
              <th className="text-right">Proj W</th>
              <th style={{ width: '9rem' }}>Playoffs</th>
              <th className="text-right">Title</th>
              {hasHistory && <th className="text-right">Form</th>}
            </tr>
          </thead>
          <tbody>
            {profiles.map((profile, index) => {
              const active = profile.teamId === selectedId;
              return (
                <tr key={profile.teamId} data-mine={profile.isMine} data-selected={active || undefined}>
                  <td className="tabular" style={{ color: 'var(--ink-faint)' }}>{index + 1}</td>
                  <td>
                    <button
                      type="button"
                      className="metric-button max-w-[12rem] text-left"
                      onClick={() => open(profile.teamId, 'roster')}
                      aria-expanded={active}
                    >
                      <span className="block truncate" style={{ fontWeight: profile.isMine ? 700 : 500 }}>
                        {profile.name}
                      </span>
                      <span className="block text-[10px]" style={{ color: 'var(--ink-faint)' }}>
                        {profile.rosterSize} players · inspect →
                      </span>
                    </button>
                  </td>
                  <td>
                    <button type="button" className="metric-button" onClick={() => open(profile.teamId, 'projection')}>
                      <StackedBar
                        max={maxStarterPoints}
                        width={260}
                        segments={positions.map((position) => ({
                          key: position,
                          value: profile.byPosition.find((slice) => slice.position === position)?.starterPoints ?? 0,
                          color: positionColor(position),
                        }))}
                      />
                    </button>
                  </td>
                  <td className="tabular text-right font-semibold">
                    <button type="button" className="metric-button tabular" onClick={() => open(profile.teamId, 'projection')}>
                      {profile.starterPoints.toFixed(1)}
                    </button>
                  </td>
                  <td className="tabular text-right" style={{ color: 'var(--ink-faint)' }}>
                    <button type="button" className="metric-button tabular" onClick={() => open(profile.teamId, 'roster')}>
                      {profile.benchPoints.toFixed(0)}
                    </button>
                  </td>
                  {hasMarket && (
                    <td className="tabular text-right">
                      <button type="button" className="metric-button" onClick={() => open(profile.teamId, 'value')}>
                        <CellBar value={profile.marketValue} max={maxTotalValue} width={48} color="var(--pos-qb)" label={profile.marketValue.toLocaleString()} />
                      </button>
                    </td>
                  )}
                  <td className="tabular text-right">
                    <button type="button" className="metric-button tabular" onClick={() => open(profile.teamId, 'odds')}>
                      {profile.expectedWins.toFixed(1)}
                    </button>
                  </td>
                  <td>
                    <button type="button" className="metric-button" onClick={() => open(profile.teamId, 'odds')}>
                      <span className="flex items-center gap-2">
                        <RangeBar
                          value={profile.playoffPct}
                          low={Math.max(0, profile.playoffPct - 1.96 * standardError(profile.playoffPct))}
                          high={Math.min(1, profile.playoffPct + 1.96 * standardError(profile.playoffPct))}
                          width={72}
                          color={profile.isMine ? 'var(--accent)' : 'var(--p-high)'}
                        />
                        <span className="tabular text-xs">{formatPct(profile.playoffPct)}</span>
                      </span>
                    </button>
                  </td>
                  <td className="tabular text-right font-semibold">
                    <button type="button" className="metric-button tabular" onClick={() => open(profile.teamId, 'odds')}>
                      {formatPct(profile.titlePct, 1)}
                    </button>
                  </td>
                  {hasHistory && (
                    <td>
                      <button type="button" className="metric-button ml-auto block" onClick={() => open(profile.teamId, 'projection')}>
                        <Sparkline values={profile.weeklyScores} color={profile.isMine ? 'var(--accent)' : 'var(--p-high)'} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected !== null && (
        <section className="team-analysis-surface mt-3" aria-live="polite">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--rule)' }}>
            <div>
              <div className="eyebrow">Team file · {selected.isMine ? 'your roster' : 'league opponent'}</div>
              <h3 className="mt-1 text-xl font-semibold">{selected.name}</h3>
              <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                {selected.rosterSize} assets · {selected.averageAge === null ? 'age unavailable' : `${selected.averageAge.toFixed(1)} value-weighted age`} · {selected.starterPoints.toFixed(1)} starter points
              </p>
            </div>
            <button type="button" className="quiet-button" onClick={() => setSelectedId(null)} aria-label="Close team analysis">Close ×</button>
          </div>

          <div className="analysis-tabs px-4 pt-3" role="tablist" aria-label="Team analysis view">
            {(Object.keys(LENS_COPY) as Lens[]).map((key) => (
              <button key={key} type="button" role="tab" aria-selected={lens === key} onClick={() => setLens(key)}>
                {key === 'roster' ? 'All players' : key === 'projection' ? 'Score range' : key === 'value' ? 'Value' : 'Odds'}
              </button>
            ))}
          </div>

          <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="scroll-x">
              <table className="data-table roster-ledger" style={{ minWidth: '44rem' }}>
                <thead>
                  <tr>
                    <th>Player</th><th>Role</th><th className="text-right">Age</th><th className="text-right">Value</th>
                    <th className="text-right">P25</th><th className="text-right">P50</th><th className="text-right">P75</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.roster.map((player) => (
                    <tr key={player.playerId}>
                      <td>
                        <Link className="player-ledger-link" href={`/league/${leagueId}/player/${player.playerId}`}>
                          <span className="font-medium">{player.name}</span>
                          <span>{player.position} · {player.nflTeam || 'FA'} · open file →</span>
                        </Link>
                      </td>
                      <td><span className={player.starting ? 'role-chip role-chip-start' : 'role-chip'}>{player.starting ? 'Starter' : 'Bench'}</span></td>
                      <td className="tabular text-right">{player.age === null ? '—' : player.age.toFixed(1)}</td>
                      <td className="tabular text-right font-medium">{player.marketValue > 0 ? player.marketValue.toLocaleString() : '—'}</td>
                      <td className="tabular text-right" style={{ color: 'var(--ink-faint)' }}>{player.basis === 'unprojected' ? '—' : player.p25.toFixed(1)}</td>
                      <td className="tabular text-right font-semibold">{player.basis === 'unprojected' ? '—' : player.p50.toFixed(1)}</td>
                      <td className="tabular text-right" style={{ color: 'var(--good)' }}>{player.basis === 'unprojected' ? '—' : player.p75.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <aside className="analysis-note">
              <div className="eyebrow">How to read this</div>
              <h4 className="mt-2 font-semibold">{LENS_COPY[lens].title}</h4>
              <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>{LENS_COPY[lens].body}</p>
              <dl className="mt-4 space-y-2 text-xs">
                <div><dt>Starter value</dt><dd>{selected.starterMarketValue.toLocaleString()}</dd></div>
                <div><dt>Bench value</dt><dd>{Math.max(0, selected.marketValue - selected.starterMarketValue).toLocaleString()}</dd></div>
                <div><dt>Lineup efficiency</dt><dd>{formatPct(selected.lineupEfficiency)}</dd></div>
                <div><dt>Top-two reliance</dt><dd>{formatPct(selected.topTwoShare)}</dd></div>
              </dl>
            </aside>
          </div>
        </section>
      )}
    </>
  );
}
