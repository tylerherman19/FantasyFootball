import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { Metric, MetricRow } from '@/components/design/primitives';

export const metadata: Metadata = {
  title: 'How the model works — Fantasy Football Edge',
  description: 'What the model does, what it measured, and what it refused to ship.',
};

/**
 * The model, in English.
 *
 * Written for a manager rather than for a modeller, and written because a
 * product whose whole argument is "you can check this" has to make the checking
 * possible. Every number quoted here is one the harness produced, including the
 * ones that are unflattering.
 *
 * The section that matters most is the last one. Anyone can list what their
 * model does; almost nobody publishes what they tried and threw away, and that
 * is the part that tells you whether the rest is trustworthy.
 */

const Para = ({ children }: { children: React.ReactNode }) => (
  <p className="mb-4 max-w-2xl text-[0.95rem] leading-relaxed">{children}</p>
);

export default function ModelPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-14">
      <Link
        href="/"
        className="text-[11px] uppercase tracking-widest hover:opacity-60"
        style={{ color: 'var(--ink-faint)' }}
      >
        ← All leagues
      </Link>

      <h1 className="headline mt-3 mb-3">How this model works</h1>
      <p className="deck mb-10">
        No jargon, no hand-waving. What it does, what it got right, and what it tried and threw
        away — because the last one is how you tell whether to trust the rest.
      </p>

      <Section
        title="It predicts what a player will do, not what he will score"
        note="The single decision everything else rests on."
      >
        <Para>
          Most tools give you a points projection. That number is wrong the moment your league
          scores anything unusual — and yours do. Across your three leagues there are 42, 64 and 132
          distinct scoring rules. One has full IDP. One has distance-banded field goals.
        </Para>
        <Para>
          So the model never predicts points. It predicts a <strong>stat line</strong> — targets,
          carries, yards, touchdowns — and each league converts that to points under its own rules.
          Two of your three leagues would get wrong numbers otherwise, silently.
        </Para>
      </Section>

      <Section
        title="Volume is sticky. Efficiency is noise."
        note="Why this beats a simple average of recent games."
      >
        <Para>
          A back who got 18 carries last week will probably get carries again. The 6.1 yards he
          averaged on them will not repeat. Those two facts are treated completely differently.
        </Para>
        <Para>
          <strong>Opportunity</strong> — carries, targets, pass attempts — is trusted, because it
          reflects a role and roles persist. <strong>Efficiency</strong> — yards per carry, catch
          rate, touchdown rate — is pulled hard toward the positional average, because it is mostly
          luck over a handful of games. Touchdown rate is pulled hardest of all.
        </Para>
        <Para>
          How hard is not a guess. For every position and every stat, the model measures how much
          players genuinely differ from each other versus how much a single player bounces week to
          week, and regresses accordingly. A player with fifty red-zone carries is barely adjusted;
          one with eight is pulled almost all the way to the mean.
        </Para>
        <MetricRow>
          <Metric
            label="Beats the baseline by"
            value="+5.6%"
            context="mean error, out of sample"
            tone="var(--pos)"
          />
          <Metric label="Tested on" value="21,679" context="player-weeks, 2022–2025" />
          <Metric label="Seasons won" value="4 of 4" context="beats the baseline in each separately" />
        </MetricRow>
      </Section>

      <Section
        title="Rookies get priced from draft capital"
        note="Because a player with no NFL games still has to have a number."
      >
        <Para>
          A rookie has no history, so the usual method produces nothing at all — not a low
          projection, an absent one. Until recently that is exactly what happened here: the first
          pick of the draft sat on a dynasty roster with no value, no rank and no trade price.
        </Para>
        <Para>
          Now they are priced from what the NFL paid to get them. Ten completed draft classes were
          used to fit how much opportunity a rookie actually receives at each draft slot, adjusted
          for where he sits on the depth chart. As real games arrive, his own record takes over
          automatically — nothing switches, the evidence simply outweighs the prior.
        </Para>
        <MetricRow>
          <Metric
            label="Better than a flat rookie average"
            value="+16.7%"
            context="mean error, out of sample"
            tone="var(--pos)"
          />
          <Metric label="Tested on" value="1,676" context="rookie player-weeks" />
        </MetricRow>
      </Section>

      <Section
        title="Injury designations were measured, not assumed"
        note="Two haircuts, because they are two different facts."
      >
        <Para>
          Every injury report since 2016 was matched against who actually appeared. The labels turn
          out to mean something quite different from what most tools assume — and one of them was
          being priced <strong>thirty times too generously</strong>.
        </Para>
        <MetricRow>
          <Metric label="Questionable" value="59%" context="actually played · was assumed 72%" />
          <Metric label="Doubtful" value="0.8%" context="actually played · was assumed 25%" />
          <Metric
            label="And if he plays"
            value="77%"
            context="of his own healthy baseline, when Questionable"
          />
        </MetricRow>
        <Para>
          That last one is the half almost nobody prices. A Questionable player who suits up is
          playing hurt, and treating &ldquo;he played&rdquo; as &ldquo;he was fine&rdquo; overstates
          every hurt starter — in the direction that loses leagues, because it tells you to start
          him.
        </Para>
        <Para>
          It also survives the tag being taken away. Sleeper drops a designation the moment a player
          is declared active, which used to take his whole injury with it: he snapped back to a full
          healthy projection because nothing in the data said otherwise. The site now remembers the
          removal for the rest of that week. Being activated settles whether he plays — it settles
          nothing about how well. A 20-point player reads 9.2 mid-week, <strong>15.5 once he is
          active</strong>, and 20.0 only if he was never listed at all.
        </Para>
      </Section>

      <Section
        title="Asset values are ours now"
        note="They used to be somebody else's number, on the render path of six pages."
      >
        <Para>
          Every price here — trade fairness, sell candidates, what your roster is worth, what a 2027
          first is worth — used to come from a public market feed. Those are real trades from real
          leagues, which is a genuine market and a defensible place to start. But it made a third
          party the author of the number this product argues with, and left the site no way to
          disagree with it or explain it.
        </Para>
        <Para>
          It also could not describe your league. That endpoint knows four things: dynasty or not,
          how many quarterbacks start, how many teams, and a PPR number. It does not know that yours
          starts a third receiver, plays two flexes, awards a point per first down, or that eleven
          weeks are left — which are the facts that decide what a player is worth.
        </Para>
        <Para>
          Value is now <strong>discounted production above replacement</strong>, computed from the
          same projections everything else on the site uses. Replacement level falls out of counting
          your actual lineup slots, so a superflex league reprices every quarterback without anyone
          coding a special case for superflex. Rookie picks are priced against this model&rsquo;s
          own read of the class they would be spent on, rather than a chart that says a 1.03 is worth
          the same in every draft ever held.
        </Para>
        <Para>
          One thing was genuinely lost and is marked as lost rather than faked: roster share is a
          fact about other people&rsquo;s leagues, not about football, so the site now says it does
          not know instead of substituting a proxy.
        </Para>
      </Section>

      <Section
        title="It is now scored against the free alternative, every week"
        note="The gap this page had the least right to leave open."
      >
        <Para>
          Everything above compares the model to <em>itself</em> — v1 against v0, the rookie prior
          against a flat average, matchup adjustments against no adjustment. Those are real
          measurements and they are the ones that decide what ships. They are also not the question
          you are actually asking, which is whether this beats the projection Sleeper already shows
          you for free.
        </Para>
        <Para>
          Until now that could not be answered. The snapshot table has recorded Sleeper&rsquo;s
          consensus before every kickoff since before Week 1, and it never recorded ours, and it
          never recorded what actually happened. Half the data for the comparison was simply
          missing — so the honest description of the claim was <em>untested</em>, not proven and not
          disproven.
        </Para>
        <Para>
          Both halves now run weekly. Our projection is captured before kickoff beside the
          consensus, under the same scoring rules; on Tuesday, once Monday night has settled the
          week, both are scored against what actually happened. The comparison is set up to be hard
          on us on purpose: only players <em>both</em> sources projected, so breadth cannot pass for
          skill; only players who actually appeared, so an injury miss cannot hide inside a
          projection score; and a paired t-test, so a single good week reports itself as a single
          good week rather than a finding.
        </Para>
        <Para>
          Expect the first several weeks to say the two are not separated. That is what one week of
          fantasy projections can support, and saying so is the point.
        </Para>
      </Section>

      <Section
        title="Ageing curves are measured against the player himself"
        note="The subtle trap that makes most ageing analysis wrong."
      >
        <Para>
          If you simply compare 32-year-olds to 25-year-olds, you learn nothing about ageing. The
          32-year-olds still playing are the ones good enough to still be playing, so the curve bends
          upward exactly where careers end.
        </Para>
        <Para>
          Instead each player is compared to <em>himself</em> a year later, so his own quality
          cancels out. The result reads like football: backs peak around 23 and are at 38% of their
          peak by 30; receivers decline far more gently. Read them as a floor on decline — the method
          cannot see the players whose careers ended, so real cohorts fall off faster.
        </Para>
      </Section>

      <Section
        title="Correlation is measured between real team-mates"
        note="Why your roster's risk is not the sum of its players' risks."
      >
        <Para>
          A quarterback and his top receiver rise and fall together, because he throws the passes
          the receiver catches. Two running backs on the same team do the opposite: they split the
          same carries, so one eating means the other did not.
        </Para>
        <MetricRow>
          <Metric label="QB with his WR" value="+0.26" context="measured, same team" tone="var(--pos)" />
          <Metric label="Two WRs" value="0.00" context="competition cancels the shared game" />
          <Metric label="Two RBs" value="−0.02" context="they split the same carries" tone="var(--neg)" />
        </MetricRow>
        <Para>
          Specific pairs who have played enough together get their own number rather than their
          position&rsquo;s average — a quarterback and his primary target measure around 0.42, well
          above the 0.26 typical of the pairing. This is why the dynasty page can tell you whether
          your roster is stacked, which a list of player values structurally cannot.
        </Para>
      </Section>

      <Section
        title="Offensive scheme is part of the engine"
        note="The player model owns the adjustment; the UI exposes every term that moved it."
      >
        <Para>
          Player history is not projected in a vacuum. The current offense contributes a bounded
          context adjustment through pace, neutral pass identity and PROE. That changes the
          opportunities available to the player — attempts, carries and targets — while the
          player-specific efficiency rates remain separately regressed.
        </Para>
        <Para>
          The adjustment is capped at six percent. It can move a receiver on a fast, pass-first
          offense or a back on a slow, run-first one, but it cannot overpower the role evidence.
          Every player page exposes the decomposition as a drill-down: positional baseline, player
          opportunity, offensive scheme, efficiency and the 25th / 50th / 75th outcome band.
        </Para>
      </Section>

      <Section
        title="What it tried and threw away"
        note="The part worth reading if you only read one."
      >
        <Para>
          Every version of the model has to beat the previous one on data it has never seen, or it
          does not ship. Two did not, and both are worth knowing about because they are things
          almost every other tool does confidently.
        </Para>
        <Para>
          <strong>Matchup adjustments do not work.</strong> The obvious move — scale a projection by
          how much the opposing defense gives up to that position — was built and measured. It made
          projections <em>worse</em>, and worse in proportion to how strongly it was applied, which
          is the signature of a variable with no real content.
        </Para>
        <Para>
          The obvious objection is that it adjusted the wrong thing, so a second version adjusted
          only opportunity — targets and carries — and left efficiency alone. Same result.
        </Para>
        <MetricRow>
          <Metric label="Baseline (v1)" value="4.568" context="mean error, lower is better" />
          <Metric label="Matchup on points" value="4.578" context="at full strength · worse" tone="var(--neg)" />
          <Metric label="Matchup on volume" value="4.581" context="at full strength · worse" tone="var(--neg)" />
        </MetricRow>
        <Para>
          There was an obvious way to rescue it, and this page used to make the argument: perhaps
          scheme leaves a player&rsquo;s <em>average</em> alone and changes the <em>shape</em> —
          a two-high shell clipping a receiver&rsquo;s ceiling while a light box opens a back&rsquo;s
          floor. Mean error cannot see a change like that, so the first two tests could not have
          found it either way.
        </Para>
        <Para>
          So it was tested directly. If the story were true, receivers and backs would land on
          opposite sides of 1.00 below. They land on the same side, a hundredth apart.
        </Para>
        <MetricRow>
          <Metric label="WR spread ratio" value="0.997" context="soft shell ÷ loaded box" />
          <Metric label="RB spread ratio" value="1.005" context="should have been above 1 if real" />
          <Metric label="Separation" value="0.008" context="21,679 player-weeks · declined" tone="var(--neg)" />
        </MetricRow>
        <Para>
          That is three measurements and three declines, so scheme is shown beside a projection as
          a description of how a defense plays — and the site now says, per player and in points,
          how small a thing that is. The internet is confident matchups matter enormously. This has
          measured it three ways and can tell you, with numbers, that they do not.
        </Para>
      </Section>

      <Section title="What it still cannot do" note="Stated plainly, because the gaps matter too.">
        <ul className="mb-4 max-w-2xl list-disc space-y-2 pl-5 text-[0.95rem] leading-relaxed">
          <li>
            <strong>No weather.</strong> Nothing ingests it, so wind and cold are simply absent from
            every projection.
          </li>
          <li>
            <strong>No drive-level simulation.</strong> Game script is not modelled, so a blowout
            suppressing passing volume is not something the model anticipates.
          </li>
          <li>
            <strong>Coverage data is frozen.</strong> The charting behind man/zone and shell rates
            was retired by its publisher, so it describes completed seasons and will not update
            during this one.
          </li>
          <li>
            <strong>Correlation is by position pair.</strong> Two specific receivers on one team get
            their position&rsquo;s number unless they have played enough games together.
          </li>
          <li>
            <strong>The head-to-head is young.</strong> Weekly scoring against the free consensus
            started this season. Until a season of weeks accumulates, the right reading of it is
            &ldquo;not separated yet&rdquo;, whichever way the sign happens to point.
          </li>
          <li>
            <strong>A Friday injury report reads like a Wednesday one.</strong> The 59% play rate is
            an average over the whole week, and a designation issued the day before kickoff carries
            more information than one issued three days out. Splitting them needs play rates measured
            against hours-to-kickoff, which the availability export does not yet produce.
          </li>
          <li>
            <strong>It is slow to believe a surprise starter.</strong> Twenty-four games of memory
            is what makes it hard to fool with a hot fortnight, and it is the same property that
            makes it late on a genuine role change. Nothing here has been tuned to fix that, because
            a change to the memory that has not been backtested is exactly the kind this project has
            already declined twice.
          </li>
          <li>
            <strong>Season odds are not calibrated.</strong> Weekly spread is; the playoff and title
            percentages inherit it without having been checked against realised outcomes. Treat the
            ordering as meaningful and the exact percentage as not.
          </li>
        </ul>
      </Section>

      <div className="source-line">
        Backtest figures from walk-forward runs · <code>model/backtest/run_ladder.py</code> to
        reproduce · head-to-head from <code>scripts/score-snapshots.ts</code>, weekly
      </div>
    </main>
  );
}
