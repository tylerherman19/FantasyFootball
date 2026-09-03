'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import { evaluateTradeClient, type TradeGrade } from '@/lib/client-sim';
import type { WireLeague } from '@/lib/serialize';

/**
 * Interactive trade calculator.
 *
 * Runs the real engine in the browser — the same simulation the server uses —
 * so every change of selection re-grades the trade immediately instead of
 * waiting on a round trip. That responsiveness is the whole point: a calculator
 * you have to wait on is one you stop using.
 */

const GRADE_COLOR: Record<string, string> = {
  'A+': 'var(--good)',
  A: 'var(--good)',
  'B+': 'var(--good)',
  B: 'var(--ink)',
  'C+': 'var(--ink)',
  C: 'var(--ink-muted)',
  D: 'var(--bad)',
  F: 'var(--bad)',
};

const pct = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;

export const TradeBuilder = ({ league, myTeamId }: { league: WireLeague; myTeamId: string }) => {
  const otherTeams = league.teams.filter((team) => team.teamId !== myTeamId);

  const [partnerId, setPartnerId] = useState(otherTeams[0]?.teamId ?? '');
  const [iSend, setISend] = useState<string[]>([]);
  const [iGet, setIGet] = useState<string[]>([]);
  const [grade, setGrade] = useState<TradeGrade | null>(null);
  const [pending, startTransition] = useTransition();

  /** Players and picks together — both are assets a manager trades. */
  const assetsFor = useCallback((teamId: string) => {
    const team = league.teams.find((t) => t.teamId === teamId);

    const players = (team?.playerIds ?? [])
      .map((id) => league.players[id])
      .filter((p): p is NonNullable<typeof p> => p !== undefined)
      .sort((a, b) => b.mean - a.mean)
      .map((player) => ({
        id: player.id,
        name: player.name,
        position: player.position,
        team: player.team,
        mean: player.mean,
        value: player.value,
        isPick: false,
      }));

    const picks = league.picks
      .filter((pick) => pick.ownerTeamId === teamId)
      .sort((a, b) => a.season - b.season || a.round - b.round)
      .map((pick) => ({
        id: pick.id,
        name: pick.description,
        position: 'PICK',
        team: '',
        mean: 0,
        value: pick.value,
        isPick: true,
      }));

    return [...players, ...picks];
  }, [league]);

  const myPlayers = useMemo(() => assetsFor(myTeamId), [assetsFor, myTeamId]);
  const theirPlayers = useMemo(() => assetsFor(partnerId), [assetsFor, partnerId]);

  const toggle = (list: string[], setList: (next: string[]) => void, id: string) => {
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    setList(next);
    setGrade(null);
  };

  const evaluate = () => {
    if (iSend.length === 0 && iGet.length === 0) return;
    startTransition(() => {
      setGrade(evaluateTradeClient(league, myTeamId, partnerId, iSend, iGet));
    });
  };

  const valueOf = (id: string) =>
    league.players[id]?.value ?? league.picks.find((pick) => pick.id === id)?.value ?? 0;

  const sendValue = iSend.reduce((sum, id) => sum + valueOf(id), 0);
  const getValue = iGet.reduce((sum, id) => sum + valueOf(id), 0);

  return (
    <div className="rounded border" style={{ borderColor: 'var(--rule)', background: 'var(--surface)' }}>
      <div className="flex flex-wrap items-center gap-3 border-b p-4" style={{ borderColor: 'var(--rule)' }}>
        <label className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Trade with
        </label>
        <select
          value={partnerId}
          onChange={(event) => {
            setPartnerId(event.target.value);
            setIGet([]);
            setGrade(null);
          }}
          className="rounded border px-2 py-1 text-sm"
          style={{ borderColor: 'var(--rule-strong)', background: 'var(--ground)', color: 'var(--ink)' }}
        >
          {otherTeams.map((team) => (
            <option key={team.teamId} value={team.teamId}>
              {team.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={evaluate}
          disabled={pending || (iSend.length === 0 && iGet.length === 0)}
          className="ml-auto rounded px-3 py-1.5 text-sm font-medium disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          {pending ? 'Simulating…' : 'Grade trade'}
        </button>
      </div>

      {grade !== null && (
        <div className="border-b p-4" style={{ borderColor: 'var(--rule)', background: 'var(--ground)' }}>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
                Grade
              </div>
              <div className="text-4xl font-semibold" style={{ color: GRADE_COLOR[grade.grade] ?? 'var(--ink)' }}>
                {grade.grade}
              </div>
            </div>
            <Metric label="Your title odds" value={pct(grade.myTitleDelta)} good={grade.myTitleDelta > 0} />
            <Metric label="Your playoff odds" value={pct(grade.myPlayoffDelta)} good={grade.myPlayoffDelta > 0} />
            <Metric label="Their title odds" value={pct(grade.theirTitleDelta)} good={grade.theirTitleDelta > 0} />
            <Metric
              label="Model value"
              value={`${grade.myValueDelta >= 0 ? '+' : ''}${Math.round(grade.myValueDelta).toLocaleString()}`}
              good={grade.myValueDelta > 0}
            />
            <Metric label="Fairness gap" value={`${(grade.fairness * 100).toFixed(0)}%`} />
          </div>
          <p className="mt-3 text-sm" style={{ color: 'var(--ink-muted)' }}>
            {grade.verdict}
          </p>
        </div>
      )}

      <div className="grid gap-0 sm:grid-cols-2">
        <PlayerColumn
          title="You send"
          players={myPlayers}
          selected={iSend}
          onToggle={(id) => toggle(iSend, setISend, id)}
          total={sendValue}
        />
        <PlayerColumn
          title="You get"
          players={theirPlayers}
          selected={iGet}
          onToggle={(id) => toggle(iGet, setIGet, id)}
          total={getValue}
          bordered
        />
      </div>
    </div>
  );
};

const Metric = ({ label, value, good }: { label: string; value: string; good?: boolean }) => (
  <div>
    <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
      {label}
    </div>
    <div
      className="tabular text-lg font-semibold"
      style={{ color: good === undefined ? 'var(--ink)' : good ? 'var(--good)' : 'var(--bad)' }}
    >
      {value}
    </div>
  </div>
);

const PlayerColumn = ({
  title,
  players,
  selected,
  onToggle,
  total,
  bordered = false,
}: {
  title: string;
  players: readonly {
    id: string;
    name: string;
    position: string;
    team: string;
    mean: number;
    value: number;
    isPick: boolean;
  }[];
  selected: readonly string[];
  onToggle: (id: string) => void;
  total: number;
  bordered?: boolean;
}) => (
  <div style={bordered ? { borderLeft: '1px solid var(--rule)' } : undefined}>
    <div className="flex items-baseline justify-between px-4 pt-3">
      <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--ink-faint)' }}>
        {title}
      </span>
      <span className="tabular text-xs" style={{ color: 'var(--ink-muted)' }}>
        {selected.length} · {total.toLocaleString()}
      </span>
    </div>

    <ul className="max-h-80 overflow-y-auto p-2">
      {players.map((player) => {
        const isSelected = selected.includes(player.id);
        return (
          <li key={player.id}>
            <button
              type="button"
              onClick={() => onToggle(player.id)}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm"
              style={{
                background: isSelected ? 'var(--accent-soft)' : 'transparent',
                fontWeight: isSelected ? 600 : 400,
              }}
            >
              <span className="truncate">
                {player.name}
                <span className="ml-1.5 text-[10px] uppercase" style={{ color: 'var(--ink-faint)' }}>
                  {player.position} {player.team}
                </span>
              </span>
              <span className="tabular shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>
                {player.isPick ? '' : `${player.mean.toFixed(1)} · `}
                {player.value > 0 ? player.value.toLocaleString() : '—'}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  </div>
);
