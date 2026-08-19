/*
 * The standalone reader.
 *
 * Everything is already computed — the payload above is the output of the same
 * simulation and the same aggregations the server app runs — so this file only
 * arranges and filters. No fetches, no framework, no build step, which is why
 * every interaction here lands in the same frame it was asked for.
 */

const DATA = JSON.parse(document.getElementById('site-data').textContent);

const POS_COLOR = {
  QB: 'var(--pos-qb)', RB: 'var(--pos-rb)', WR: 'var(--pos-wr)', TE: 'var(--pos-te)',
  K: 'var(--pos-k)', DEF: 'var(--pos-def)',
};
const posColor = (p) => POS_COLOR[p] || 'var(--ink-faint)';

const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
const signed = (v, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

/** Banded rather than continuous: five steps a reader can compare across a table. */
const ramp = (v) =>
  v >= 0.8 ? 'var(--p-max)' : v >= 0.6 ? 'var(--p-high)' : v >= 0.4 ? 'var(--p-mid)'
  : v >= 0.15 ? 'var(--p-low)' : 'var(--p-0)';
const rampInk = (v) => (v >= 0.6 ? '#fff' : 'var(--ink)');

const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const svgEl = (tag, attrs = {}, ...kids) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

// ---- chart primitives, matching the app's --------------------------------

const cellBar = (value, max, color = 'var(--p-mid)', label = null, width = 80) => {
  const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const svg = svgEl('svg', { width, height: 9, role: 'img', 'aria-label': label ?? String(value) },
    svgEl('rect', { x: 0, y: 0, width, height: 9, rx: 2, fill: 'var(--p-0)' }),
    svgEl('rect', { x: 0, y: 0, width: Math.max(share * width, share > 0 ? 1.5 : 0), height: 9, rx: 2, fill: color }));
  return el('span', { style: 'display:inline-flex;align-items:center;gap:7px' }, svg,
    label === null ? null : el('span', { class: 'num faint', style: 'font-size:11.5px' }, label));
};

const divergingBar = (value, max, width = 110, label = null) => {
  const half = width / 2;
  const share = max > 0 ? Math.max(-1, Math.min(1, value / max)) : 0;
  const length = Math.abs(share) * half;
  const svg = svgEl('svg', { width, height: 10, role: 'img', 'aria-label': label ?? String(value) },
    svgEl('rect', { x: 0, y: 4.5, width, height: 1, fill: 'var(--rule)' }),
    svgEl('rect', {
      x: share >= 0 ? half : half - length, y: 1,
      width: Math.max(length, 1), height: 8, rx: 2,
      fill: share >= 0 ? 'var(--good)' : 'var(--bad)',
    }),
    svgEl('rect', { x: half - 0.5, y: 0, width: 1, height: 10, fill: 'var(--rule-strong)' }));
  return el('span', { style: 'display:inline-flex;align-items:center;gap:7px' }, svg,
    label === null ? null : el('span', { class: 'num faint', style: 'font-size:11.5px' }, label));
};

const stackedBar = (segments, max, width = 200, height = 13, labels = false) => {
  const scale = max > 0 ? width / max : 0;
  let x = 0;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`, width: '100%', height,
    preserveAspectRatio: 'none', role: 'img',
    'aria-label': segments.map((s) => `${s.key} ${s.value.toFixed(1)}`).join(', '),
    style: `max-width:${width}px`,
  }, svgEl('rect', { x: 0, y: 0, width, height, fill: 'var(--p-0)', rx: 2 }));

  for (const segment of segments) {
    const length = Math.max(0, segment.value) * scale;
    const group = svgEl('g', {}, svgEl('title', {}, `${segment.key}: ${segment.value.toFixed(1)}`));
    group.append(svgEl('rect', { x, y: 0, width: Math.max(length - 0.75, 0), height, fill: segment.color }));
    if (labels && length > 26) {
      group.append(svgEl('text', {
        x: x + length / 2, y: height / 2 + 3.5, 'font-size': 9, 'font-weight': 700,
        'text-anchor': 'middle', fill: '#fff', style: 'pointer-events:none',
      }, segment.key));
    }
    svg.append(group);
    x += length;
  }
  return svg;
};

const sparkline = (values, width = 66, height = 18, color = 'var(--p-high)') => {
  if (values.length < 2) return el('span', { class: 'faint' }, '—');
  const min = Math.min(...values), max = Math.max(...values);
  const span = Math.max(max - min, 1e-9);
  const d = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - 1 - ((v - min) / span) * (height - 2);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return svgEl('svg', { width, height, role: 'img', 'aria-label': 'trend' },
    svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
};

const rangeBar = (value, low, high, width = 80, color = 'var(--p-high)') => {
  const s = (v) => Math.max(0, Math.min(1, v)) * width;
  return svgEl('svg', { width, height: 12, role: 'img', 'aria-label': pct(value) },
    svgEl('rect', { x: 0, y: 5, width, height: 2, fill: 'var(--p-0)', rx: 1 }),
    svgEl('rect', { x: s(low), y: 3, width: Math.max(s(high) - s(low), 1.5), height: 6, fill: color, opacity: 0.32, rx: 3 }),
    svgEl('rect', { x: 0, y: 5, width: s(value), height: 2, fill: color, rx: 1 }),
    svgEl('circle', { cx: s(value), cy: 6, r: 3.2, fill: color }));
};

const scatter = (points, xLabel, yLabel, quadrants) => {
  const width = 560, height = 300;
  const pad = { top: 18, right: 16, bottom: 32, left: 48 };
  const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const sx = (v) => pad.left + ((v - xMin) / Math.max(xMax - xMin, 1e-9)) * pw;
  const sy = (v) => pad.top + (1 - (v - yMin) / Math.max(yMax - yMin, 1e-9)) * ph;
  const mid = (arr) => { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mx = mid(xs), my = mid(ys);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`, width: '100%', role: 'img',
    'aria-label': `${yLabel} against ${xLabel}`, style: 'color:var(--ink-faint)',
  },
    svgEl('rect', { x: pad.left, y: pad.top, width: pw, height: ph, fill: 'var(--surface-sunk)', stroke: 'var(--rule)' }),
    svgEl('line', { x1: sx(mx), x2: sx(mx), y1: pad.top, y2: pad.top + ph, stroke: 'var(--rule-strong)', 'stroke-dasharray': '3 3' }),
    svgEl('line', { x1: pad.left, x2: pad.left + pw, y1: sy(my), y2: sy(my), stroke: 'var(--rule-strong)', 'stroke-dasharray': '3 3' }));

  if (quadrants) {
    const spots = [
      [pad.left + 6, pad.top + 13, 'start'], [pad.left + pw - 6, pad.top + 13, 'end'],
      [pad.left + pw - 6, pad.top + ph - 6, 'end'], [pad.left + 6, pad.top + ph - 6, 'start'],
    ];
    quadrants.forEach((text, i) => svg.append(svgEl('text', {
      x: spots[i][0], y: spots[i][1], 'font-size': 9, 'text-anchor': spots[i][2], opacity: 0.75,
    }, text)));
  }

  for (const p of points) {
    svg.append(svgEl('g', {}, svgEl('title', {}, p.label),
      svgEl('circle', { cx: sx(p.x), cy: sy(p.y), r: p.r ?? 4.5, fill: p.color, 'fill-opacity': 0.78,
        stroke: p.emphasis ? 'var(--ink)' : 'none', 'stroke-width': p.emphasis ? 1.5 : 0 })));
    if (p.tag) {
      svg.append(svgEl('text', { x: sx(p.x) + 6, y: sy(p.y) + 3, 'font-size': 8.5, opacity: 0.8 }, p.tag));
    }
  }

  svg.append(svgEl('text', { x: pad.left + pw / 2, y: height - 7, 'font-size': 10, 'text-anchor': 'middle' }, xLabel));
  svg.append(svgEl('text', { x: -(pad.top + ph / 2), y: 12, 'font-size': 10, 'text-anchor': 'middle', transform: 'rotate(-90)' }, yLabel));
  return svg;
};

const histogram = (bins, mean, highlightFrom) => {
  const height = 96;
  const width = Math.max(bins.length * 20, 140);
  const bw = width / bins.length;
  const max = Math.max(...bins, 1e-9);
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height,
    preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Win distribution' });
  bins.forEach((share, i) => {
    const h = share > 0 ? Math.max((share / max) * (height - 2), 1.5) : 0;
    const hot = highlightFrom !== undefined && i >= highlightFrom;
    svg.append(svgEl('g', {}, svgEl('title', {}, `${i} wins: ${pct(share, 1)}`),
      svgEl('rect', { x: i * bw + 0.75, y: height - h, width: Math.max(bw - 1.5, 1), height: h,
        fill: hot ? 'var(--accent)' : 'var(--p-mid)', opacity: hot ? 1 : 0.75 })));
  });
  if (mean !== undefined) {
    svg.append(svgEl('line', { x1: (mean + 0.5) * bw, x2: (mean + 0.5) * bw, y1: 0, y2: height,
      stroke: 'var(--ink)', 'stroke-width': 1, 'stroke-dasharray': '3 2', 'vector-effect': 'non-scaling-stroke' }));
  }
  return svg;
};

const legend = (items) => el('div', { class: 'legend' },
  items.map(({ label, color }) => el('span', {},
    el('span', { class: 'swatch', style: `background:${color}` }), label)));

const section = (title, note, aside, ...body) => {
  const node = el('section', { class: 'block' },
    el('div', { class: 'head-row' }, el('h2', { class: 'eyebrow' }, title), aside),
    note ? el('p', { class: 'note', html: note }) : null, ...body);
  return node;
};

const tile = (label, value, sub, tone) => el('div', { class: 'tile' },
  el('div', { class: 'label' }, label),
  el('div', { class: `value num ${tone ?? ''}` }, value),
  sub ? el('div', { class: 'sub num' }, sub) : null);

const posChip = (p) => el('span', { class: 'pos', style: `background:${posColor(p)}` }, p);

// ---- data helpers ---------------------------------------------------------

const teams = DATA.teams;
const players = DATA.players;
const defenses = DATA.defenses;
const matchupById = new Map(DATA.matchups.map((m) => [m.id, m]));
const playerById = new Map(players.map((p) => [p.id, p]));
const defenseByTeam = new Map(defenses.map((d) => [d.t, d]));
const teamOf = new Map();
for (const [teamId, ids] of Object.entries(DATA.rosters)) for (const id of ids) teamOf.set(id, teamId);

const CORE = ['QB', 'RB', 'WR', 'TE'];
const positionsPresent = teams[0] ? teams[0].byPos.map((s) => s.p) : CORE;
const corePositions = positionsPresent.filter((p) => CORE.includes(p));

const stdErr = (p) => Math.sqrt(Math.max(p * (1 - p), 0) / Math.max(DATA.iterations, 1));

const shellLabel = (s) =>
  s > 0.6 ? 'Two-high, keeps it in front' : s > 0.2 ? 'Leans two-high'
  : s < -0.6 ? 'Single-high, loaded box' : s < -0.2 ? 'Leans single-high' : 'Balanced';

const maxStart = Math.max(...teams.map((t) => t.start), 1);
const rankedTeams = [...teams].sort((a, b) => b.start - a.start);
const mine = teams.find((t) => t.mine) ?? null;

/** Sortable table: click a header to reorder, click again to reverse. */
const sortableTable = (columns, rows, initial) => {
  const state = { key: initial.key, dir: initial.dir ?? -1 };
  const table = el('table', { class: 'data-table' });
  const thead = el('thead'), tbody = el('tbody');
  table.append(thead, tbody);

  const draw = () => {
    const column = columns.find((c) => c.key === state.key);
    const sorted = column?.value
      ? [...rows].sort((a, b) => {
          const av = column.value(a), bv = column.value(b);
          if (typeof av === 'string' || typeof bv === 'string') {
            return String(av).localeCompare(String(bv)) * -state.dir;
          }
          return ((av ?? -Infinity) - (bv ?? -Infinity)) * state.dir;
        })
      : rows;

    thead.replaceChildren(el('tr', {}, columns.map((c) =>
      el('th', {
        class: c.value ? 'sortable' : '',
        style: c.width ? `width:${c.width}` : null,
        title: c.title,
        'aria-sort': state.key === c.key ? (state.dir === -1 ? 'descending' : 'ascending') : null,
        onclick: c.value ? () => {
          if (state.key === c.key) state.dir *= -1;
          else { state.key = c.key; state.dir = -1; }
          draw();
        } : null,
      }, c.label, state.key === c.key ? el('span', { class: 'arrow' }, state.dir === -1 ? ' ↓' : ' ↑') : null))));

    tbody.replaceChildren(...sorted.map((row) => {
      const tr = el('tr', { class: row.__mine ? 'mine' : '' });
      for (const c of columns) tr.append(el('td', { class: c.cellClass ?? '' }, c.cell(row)));
      return tr;
    }));
  };

  draw();
  return { table, redraw: (next) => { rows = next; draw(); } };
};

// ---- views ----------------------------------------------------------------

const views = {};

views.power = () => {
  const frag = document.createDocumentFragment();
  const strongest = rankedTeams[0], weakest = rankedTeams[rankedTeams.length - 1];

  frag.append(section('The field',
    'What a typical roster in this league looks like, so every number below has something to be compared against.',
    null,
    el('div', { class: 'tiles c5' },
      tile('Median starter pts', ((rankedTeams[Math.floor(rankedTeams.length / 2)]?.start) ?? 0).toFixed(1), 'per week, optimal lineup'),
      tile('Strongest → weakest', `${strongest.start.toFixed(0)} → ${weakest.start.toFixed(0)}`,
        `${((strongest.start / Math.max(weakest.start, 1) - 1) * 100).toFixed(0)}% spread`),
      tile('Playoff spots', `${DATA.league.playoffTeams} of ${DATA.league.teamCount}`,
        `${pct(DATA.league.playoffTeams / DATA.league.teamCount)} of the field`),
      tile('Simulations', DATA.iterations.toLocaleString(), 'seasons played out'),
      tile('Your rank', mine ? `#${rankedTeams.findIndex((t) => t.mine) + 1}` : '—',
        mine ? `${mine.start.toFixed(1)} starter pts` : 'team not found',
        mine ? 'good' : null))));

  const { table } = sortableTable([
    { key: 'name', label: 'Team', value: (t) => t.name, cell: (t) => el('span', { class: `trunc ${t.mine ? 'bold' : ''}` }, t.name), width: '9rem' },
    { key: 'shape', label: 'Starter points by position', cell: (t) => stackedBar(
        corePositions.map((p) => ({ key: p, value: t.byPos.find((s) => s.p === p)?.start ?? 0, color: posColor(p) })),
        maxStart, 230), width: '15rem' },
    { key: 'start', label: 'Start', value: (t) => t.start, cell: (t) => el('span', { class: 'bold' }, t.start.toFixed(1)), cellClass: 'r num' },
    { key: 'bench', label: 'Bench', value: (t) => t.bench, cell: (t) => t.bench.toFixed(0), cellClass: 'r num faint' },
    { key: 'value', label: 'Value', value: (t) => t.value, cell: (t) => t.value.toLocaleString(), cellClass: 'r num' },
    { key: 'wins', label: 'Proj W', value: (t) => t.wins, cell: (t) => t.wins.toFixed(1), cellClass: 'r num' },
    { key: 'playoff', label: 'Playoffs', value: (t) => t.playoff, cell: (t) => el('span', { style: 'display:inline-flex;align-items:center;gap:7px' },
        rangeBar(t.playoff, Math.max(0, t.playoff - 1.96 * stdErr(t.playoff)), Math.min(1, t.playoff + 1.96 * stdErr(t.playoff)), 70,
          t.mine ? 'var(--accent)' : 'var(--p-high)'),
        el('span', { class: 'num' }, pct(t.playoff))), width: '9rem' },
    { key: 'title', label: 'Title', value: (t) => t.title, cell: (t) => el('span', { class: 'bold' }, pct(t.title, 1)), cellClass: 'r num' },
  ], teams.map((t) => ({ ...t, __mine: t.mine })), { key: 'start', dir: -1 });

  frag.append(section('Power rankings',
    'Ranked by what the optimal lineup projects to score this week, broken down by where those points come from. Two rosters with the same total are not the same team — the bar shows whether a team is balanced or leaning on one position, which is what decides how a single injury lands. <span class="quiet">Click any column to re-sort.</span>',
    legend(corePositions.map((p) => ({ label: p, color: posColor(p) }))),
    el('div', { class: 'panel scroll-x' }, table)));

  // Positional heat map.
  const heatTable = el('table', { style: 'width:100%;border-collapse:collapse' });
  heatTable.append(el('thead', {}, el('tr', {},
    el('th', { style: 'width:9rem' }),
    positionsPresent.map((p) => el('th', { class: 'eyebrow', style: 'padding-bottom:4px;text-align:center' }, p)))));
  heatTable.append(el('tbody', {}, rankedTeams.map((t) => el('tr', {},
    el('td', { class: 'trunc', style: `font-size:12px;padding-right:8px;${t.mine ? 'font-weight:700;color:var(--accent)' : ''}` }, t.name),
    t.byPos.map((s) => el('td', { style: 'padding:1px' },
      el('div', { class: 'heat', title: `${t.name} — ${s.p}: ${s.start.toFixed(1)} starter pts, #${s.rank} in league, ${s.count} rostered`,
        style: `background:${ramp(s.strength)};color:${rampInk(s.strength)}` }, s.start.toFixed(0))))))));

  frag.append(section('Positional strength',
    "Each team's starting points at each position, coloured against the rest of the league — the stronger the colour, the higher that team ranks there. Read across for a team's shape, down for where the league is thin. A column that is washed out everywhere is a position nobody has solved, which is where the waiver wire and the trade market are worth the most.",
    null,
    el('div', { class: 'panel panel-pad scroll-x' }, heatTable)));

  // Finishing position grid.
  const grid = el('table', { style: 'width:100%;border-collapse:collapse' });
  grid.append(el('thead', {}, el('tr', {}, el('th', { style: 'width:9rem' }),
    teams.map((_, i) => el('th', { class: 'eyebrow', style: 'padding-bottom:4px;text-align:center' }, i + 1)))));
  grid.append(el('tbody', {}, [...teams].sort((a, b) => b.playoff - a.playoff).map((t) => el('tr', {},
    el('td', { class: 'trunc', style: `font-size:12px;padding-right:8px;${t.mine ? 'font-weight:700;color:var(--accent)' : ''}` }, t.name),
    t.rankDist.map((share, i) => el('td', { style: 'padding:1px' },
      el('div', { class: 'heat', title: `${t.name}: finishes #${i + 1} in ${pct(share, 1)} of seasons`,
        style: `background:${ramp(Math.min(1, share * 3))};color:${rampInk(Math.min(1, share * 3))};height:22px;` +
          (i + 1 === DATA.league.playoffTeams ? 'border-right:2px solid var(--ink)' : '') },
        share >= 0.005 ? (share * 100).toFixed(0) : '')))))));

  frag.append(section('Where every team finishes',
    `Out of ${DATA.iterations.toLocaleString()} simulated seasons, how often each team ends up in each final standing position. A row spread wide is a season still genuinely undecided; a row concentrated in two or three cells is a team whose range is already narrow. The heavy rule marks the playoff cut.`,
    el('span', { class: 'faint', style: 'font-size:11px' }, 'columns = final position'),
    el('div', { class: 'panel panel-pad scroll-x' }, grid)));

  if (mine) {
    let cumulative = 0, threshold = 0;
    for (let w = mine.winDist.length - 1; w >= 0; w -= 1) {
      cumulative += mine.winDist[w];
      if (cumulative >= mine.playoff) { threshold = w; break; }
    }
    frag.append(section('Where your season can land',
      'Every simulated season, by final win total. The dashed line is your average; the highlighted bars are the outcomes that make the playoffs. The width of this distribution is the honest answer to how much of your season is already decided.',
      null,
      el('div', { class: 'panel panel-pad' },
        histogram(mine.winDist, mine.wins, threshold),
        el('div', { style: 'display:flex;margin-top:4px' }, mine.winDist.map((_, i) =>
          el('div', { class: 'num faint', style: 'flex:1;text-align:center;font-size:10px' }, i))))));
  }

  return frag;
};

views.scheme = () => {
  const frag = document.createDocumentFragment();
  const byShell = [...defenses].sort((a, b) => b.shell - a.shell);
  const softest = byShell[0], hardest = byShell[byShell.length - 1];
  const mostPressure = [...defenses].sort((a, b) => b.pressure - a.pressure)[0];
  const avgAdot = defenses.reduce((s, d) => s + d.adot, 0) / defenses.length;
  const avgDeep = defenses.reduce((s, d) => s + d.deep, 0) / defenses.length;

  frag.append(section('The trade every defense has to make',
    'A defense cannot take away the deep ball and the run at the same time — two safeties deep is one fewer defender in the box. So every defense sits somewhere on one continuum, and where it sits decides which of your players it hurts. <strong>Playing it high</strong> caps quarterbacks and outside receivers and hands volume to tight ends and backs. <strong>Loading the box</strong> does the opposite.<br><span class="quiet">Measured from ' +
    (DATA.defenseMeta ? DATA.defenseMeta.seasons.join(' and ') : 'recent') +
    ' play-by-play — depth of target, deep rate, yards after catch and rushing EPA allowed — not from coverage labels. Every rate is opponent-adjusted, so a defense that drew a soft schedule gets no credit for it.</span>',
    null,
    el('div', { class: 'tiles c4' },
      tile('Softest shell', softest.t, `${softest.adot.toFixed(1)} yd aDOT · ${pct(softest.tgt.TE)} of targets to TEs`),
      tile('Most loaded box', hardest.t, `${hardest.adot.toFixed(1)} yd aDOT · ${pct(hardest.tgt.WR)} of targets to WRs`),
      tile('Most pressure', mostPressure.t, `${pct(mostPressure.sack, 1)} sack rate`),
      tile('League aDOT allowed', `${avgAdot.toFixed(1)} yd`, `${pct(avgDeep, 1)} thrown 20+ deep`))));

  const { table } = sortableTable([
    { key: 't', label: 'Def', value: (d) => d.t, cell: (d) => el('span', { class: 'bold' }, d.t), width: '3rem' },
    { key: 'shell', label: 'Shell', value: (d) => d.shell, cell: (d) => divergingBar(d.shell, 2.2, 100), width: '10rem' },
    { key: 'posture', label: 'Posture', cell: (d) => el('span', { class: 'muted', style: 'font-size:11.5px' }, shellLabel(d.shell)), width: '10rem' },
    { key: 'adot', label: 'aDOT', value: (d) => d.adot, cell: (d) => d.adot.toFixed(1), cellClass: 'r num', title: 'Average depth of target allowed' },
    { key: 'deep', label: 'Deep%', value: (d) => d.deep, cell: (d) => pct(d.deep, 1), cellClass: 'r num', title: 'Share of attempts thrown 20+ yards downfield' },
    { key: 'yac', label: 'YAC%', value: (d) => d.yac, cell: (d) => pct(d.yac), cellClass: 'r num', title: 'Share of receiving yards allowed that came after the catch' },
    { key: 'tgt', label: 'Targets allowed', cell: (d) => stackedBar(
        [{ key: 'WR', value: d.tgt.WR, color: posColor('WR') },
         { key: 'TE', value: d.tgt.TE, color: posColor('TE') },
         { key: 'RB', value: d.tgt.RB, color: posColor('RB') }], 1, 130), width: '9rem' },
    { key: 'sack', label: 'Sack%', value: (d) => d.sack, cell: (d) => pct(d.sack, 1), cellClass: 'r num' },
    { key: 'passEpa', label: 'Pass EPA', value: (d) => d.passEpa, cell: (d) =>
        el('span', { class: d.passEpa < 0 ? 'good' : 'bad' }, signed(d.passEpa, 3)), cellClass: 'r num',
      title: 'Opponent-adjusted EPA per dropback allowed — negative favours the defense' },
    { key: 'rushEpa', label: 'Rush EPA', value: (d) => d.rushEpa, cell: (d) =>
        el('span', { class: d.rushEpa < 0 ? 'good' : 'bad' }, signed(d.rushEpa, 3)), cellClass: 'r num',
      title: 'Opponent-adjusted EPA per rush allowed' },
  ], defenses, { key: 'shell', dir: -1 });

  frag.append(section('Every defense on the continuum',
    'Sorted from the softest shell to the most loaded box. Right of centre keeps everything in front of it; left of centre dares you to throw deep and stops the run instead. <span class="quiet">Click any column to re-sort.</span>',
    legend([{ label: 'keeps it in front', color: 'var(--good)' }, { label: 'loaded box', color: 'var(--bad)' }]),
    el('div', { class: 'panel scroll-x' }, table)));

  frag.append(section('The trade, drawn',
    'Deep passing allowed against rushing allowed. If the trade were free the dots would scatter at random; instead everyone has to pick a side. A defense in the top-left is the one your tight end and your running back both want.',
    null,
    el('div', { class: 'panel panel-pad' },
      scatter(defenses.map((d) => ({
        x: d.deep, y: d.rushEpa, tag: d.t,
        color: d.shell > 0 ? 'var(--good)' : 'var(--bad)',
        label: `${d.t} — ${pct(d.deep, 1)} deep allowed, ${signed(d.rushEpa, 3)} rush EPA, ${shellLabel(d.shell)}`,
      })), 'Deep attempts allowed (20+ yds) →', 'Adjusted rush EPA allowed →',
        ['Nothing deep, run works', 'Gives up everything', 'Shots allowed, run stuffed', 'Nothing deep, run stuffed']),
      el('p', { class: 'note', style: 'margin:8px 0 0;font-size:11px' },
        'Green plays it high, red loads the box.'))));

  const funnels = el('div', { style: 'display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))' });
  for (const group of ['TE', 'RB', 'WR']) {
    const sorted = [...defenses].sort((a, b) => b.tgt[group] - a.tgt[group]).slice(0, 8);
    const max = Math.max(...defenses.map((d) => d.tgt[group]));
    funnels.append(el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('span', { class: 'eyebrow' }, `Most generous to ${group}s`),
        el('span', { class: 'eyebrow' }, 'target share allowed')),
      sorted.map((d) => el('div', { class: 'bar-row' },
        el('span', { class: 'bold', style: 'width:2.2rem;flex:none;font-size:12px' }, d.t),
        cellBar(d.tgt[group], max, posColor(group), pct(d.tgt[group]), 120),
        el('span', { class: 'faint', style: 'margin-left:auto;font-size:11px' }, shellLabel(d.shell))))));
  }

  frag.append(section('Where the targets go',
    'Share of targets each defense allows to receivers, tight ends and backs. The spread is not subtle — the softest shell in the league gives tight ends half again as many targets as the tightest, which is worth more than most start/sit calls.',
    legend(['WR', 'TE', 'RB'].map((p) => ({ label: p, color: posColor(p) }))),
    funnels));

  return frag;
};

views.matchups = () => {
  const frag = document.createDocumentFragment();
  const state = { team: mine ? mine.id : teams[0].id, position: 'ALL' };

  const list = el('div', { class: 'panel' });

  const render = () => {
    const roster = new Set(DATA.rosters[state.team] ?? []);
    const rows = DATA.matchups
      .filter((m) => roster.has(m.id))
      .map((m) => ({ m, p: playerById.get(m.id) }))
      .filter(({ p }) => p && (state.position === 'ALL' || p.p === state.position))
      .sort((a, b) => b.p.pts - a.p.pts);

    list.replaceChildren(...(rows.length === 0
      ? [el('div', { class: 'panel-pad faint' }, 'No projected skill players on this roster.')]
      : rows.map(({ m, p }) => {
          const defense = defenseByTeam.get(m.opp);
          const tone = m.score > 0.25 ? 'good' : m.score < -0.25 ? 'bad' : 'muted';
          return el('div', { class: 'matchup-card' },
            el('div', { class: 'matchup-top' },
              posChip(p.p),
              el('span', { class: 'bold' }, p.n),
              el('span', { class: 'faint', style: 'font-size:11.5px' }, `${p.t} vs ${m.opp}`),
              el('span', { class: `verdict ${tone}`, style: 'margin-left:auto' }, m.headline),
              divergingBar(m.score, 1, 88)),
            el('p', { class: 'matchup-detail' }, m.detail),
            el('div', { class: 'matchup-meta' },
              el('span', {}, `${m.opp} shell `, el('b', {}, defense ? shellLabel(defense.shell) : '—')),
              el('span', {}, 'projected ', el('b', {}, `${p.pts.toFixed(1)} pts`)),
              el('span', {}, 'opportunity ', el('b', {}, p.opp.toFixed(1))),
              el('span', {}, 'TD-dependence ', el('b', {}, pct(p.td)))));
        })));
  };

  const teamSelect = el('select', { 'aria-label': 'Team', onchange: (e) => { state.team = e.target.value; render(); } },
    teams.map((t) => el('option', { value: t.id, selected: t.id === state.team }, t.name + (t.mine ? ' (yours)' : ''))));

  const chips = ['ALL', ...CORE].map((p) =>
    el('button', { class: 'chip', type: 'button', 'aria-pressed': p === state.position,
      onclick: (e) => {
        state.position = p;
        for (const c of e.target.parentElement.children) c.setAttribute('aria-pressed', String(c === e.target));
        render();
      } }, p === 'ALL' ? 'All' : p));

  frag.append(section(`Scheme matchups, week ${DATA.league.week}`,
    "Every projected player on a roster, against the defense he actually lines up against. The read follows from that defense's measured tendencies — green is a matchup that works with what the player does, red is one that fights it. Pick any team in the league.",
    null,
    el('div', { class: 'controls' }, teamSelect, el('div', { style: 'display:flex;gap:6px' }, chips)),
    list));

  render();
  return frag;
};

views.players = () => {
  const frag = document.createDocumentFragment();
  const state = { query: '', position: 'ALL', scope: 'ALL' };

  const maxOpp = Math.max(...players.map((p) => p.opp), 1);
  const rostered = new Set(Object.values(DATA.rosters).flat());

  const columns = [
    { key: 'p', label: '', cell: (p) => posChip(p.p), width: '2rem' },
    { key: 'n', label: 'Player', value: (p) => p.n, cell: (p) => el('span', { class: 'trunc' }, p.n), width: '11rem' },
    { key: 't', label: 'Tm', value: (p) => p.t, cell: (p) => el('span', { class: 'faint' }, p.t) },
    { key: 'opp2', label: 'Opp', value: (p) => matchupById.get(p.id)?.opp ?? '', cell: (p) => {
        const m = matchupById.get(p.id);
        if (!m) return el('span', { class: 'faint' }, '—');
        return el('span', { class: m.score > 0.25 ? 'good' : m.score < -0.25 ? 'bad' : 'muted',
          title: `${m.headline} — ${m.detail}` }, m.opp);
      } },
    { key: 'opp', label: 'Opportunity', value: (p) => p.opp, cell: (p) => stackedBar(
        [{ key: 'Car', value: p.car, color: posColor('RB') }, { key: 'Tgt', value: p.tgt, color: posColor('WR') }],
        maxOpp, 130), width: '9rem' },
    { key: 'oppn', label: 'Opp', value: (p) => p.opp, cell: (p) => el('span', { class: 'bold' }, p.opp.toFixed(1)), cellClass: 'r num' },
    { key: 'ts', label: 'Tgt%', value: (p) => p.ts, cell: (p) => pct(p.ts), cellClass: 'r num' },
    { key: 'cs', label: 'Car%', value: (p) => p.cs, cell: (p) => pct(p.cs), cellClass: 'r num' },
    { key: 'yds', label: 'Yds', value: (p) => p.yds, cell: (p) => p.yds, cellClass: 'r num' },
    { key: 'ppo', label: 'Pts/opp', value: (p) => p.ppo, cell: (p) => (p.ppo === null ? '—' : p.ppo.toFixed(2)), cellClass: 'r num faint' },
    { key: 'td', label: 'TD-dep', value: (p) => p.td, cell: (p) =>
        el('span', { class: p.td > 0.35 ? 'warn' : 'faint' }, pct(p.td)), cellClass: 'r num',
      title: 'Share of projected points that requires a touchdown' },
    { key: 'mv', label: 'Market', value: (p) => p.mv, cell: (p) => (p.mv > 0 ? p.mv.toLocaleString() : '—'), cellClass: 'r num faint' },
    { key: 'pts', label: 'Pts', value: (p) => p.pts, cell: (p) => el('span', { class: 'bold' }, p.pts.toFixed(1)), cellClass: 'r num' },
  ];

  const counter = el('span', { class: 'count' });

  const filtered = () => players.filter((p) => {
    if (state.position !== 'ALL' && p.p !== state.position) return false;
    if (state.scope === 'FA' && rostered.has(p.id)) return false;
    if (state.scope === 'MINE' && teamOf.get(p.id) !== (mine?.id ?? '')) return false;
    if (state.query && !p.n.toLowerCase().includes(state.query)) return false;
    return true;
  }).map((p) => ({ ...p, __mine: mine !== null && teamOf.get(p.id) === mine.id }));

  const { table, redraw } = sortableTable(columns, filtered(), { key: 'pts', dir: -1 });

  const update = () => {
    const rows = filtered();
    counter.textContent = `${rows.length} of ${players.length}`;
    redraw(rows);
  };

  const search = el('input', { type: 'search', placeholder: 'Search players…', 'aria-label': 'Search players',
    oninput: (e) => { state.query = e.target.value.trim().toLowerCase(); update(); } });

  const posChips = ['ALL', ...CORE].map((p) => el('button', {
    class: 'chip', type: 'button', 'aria-pressed': p === 'ALL',
    onclick: (e) => { state.position = p;
      for (const c of e.target.parentElement.children) c.setAttribute('aria-pressed', String(c === e.target));
      update(); } }, p === 'ALL' ? 'All' : p));

  const scopeChips = [['ALL', 'Everyone'], ['MINE', 'My roster'], ['FA', 'Free agents']].map(([key, label]) =>
    el('button', { class: 'chip', type: 'button', 'aria-pressed': key === 'ALL',
      onclick: (e) => { state.scope = key;
        for (const c of e.target.parentElement.children) c.setAttribute('aria-pressed', String(c === e.target));
        update(); } }, label));

  frag.append(section('Every projected player',
    'The volume behind every projection, scored under this league’s rules. <strong>Opportunity</strong> is carries plus targets — the most stable thing about a player and the first place a role change shows up. <strong>TD-dep</strong> is how much of the projection needs a touchdown, which is the difference between a floor and a lottery ticket. The <strong>Opp</strong> column is his week ' + DATA.league.week + ' opponent, coloured by the scheme read — hover it. <span class="quiet">Search, filter and sort any column.</span>',
    null,
    el('div', { class: 'controls' }, search,
      el('div', { style: 'display:flex;gap:6px' }, posChips),
      el('div', { style: 'display:flex;gap:6px' }, scopeChips),
      counter),
    el('div', { class: 'panel scroll-x', style: 'max-height:70vh;overflow-y:auto' }, table)));

  update();
  return frag;
};

views.offense = () => {
  const frag = document.createDocumentFragment();
  const offenses = DATA.offenses;
  const maxPlays = Math.max(...offenses.map((o) => o.plays), 1);

  const { table } = sortableTable([
    { key: 't', label: 'Tm', value: (o) => o.t, cell: (o) => el('span', { class: 'bold' }, o.t), width: '3rem' },
    { key: 'split', label: 'Pass / run split', cell: (o) => stackedBar(
        [{ key: 'Pass', value: o.passRate, color: posColor('WR') },
         { key: 'Run', value: 1 - o.passRate, color: posColor('RB') }], 1, 190), width: '13rem' },
    { key: 'passRate', label: 'Pass lean', value: (o) => o.passRate, cell: (o) => el('span', { class: 'bold' }, pct(o.passRate, 1)), cellClass: 'r num' },
    { key: 'plays', label: 'Volume', value: (o) => o.plays, cell: (o) => cellBar(o.plays, maxPlays, 'var(--p-mid)', String(o.plays), 44) },
    { key: 'conc', label: 'Concentration', value: (o) => o.conc, cell: (o) => o.conc.toFixed(3), cellClass: 'r num',
      title: 'Herfindahl index over target share — high means one receiver eats' },
    { key: 'top', label: 'Lead target', value: (o) => o.top ?? '', cell: (o) => el('span', { class: 'trunc' }, o.top ?? '—'), width: '10rem' },
    { key: 'topShare', label: 'Share', value: (o) => o.topShare, cell: (o) => pct(o.topShare, 1), cellClass: 'r num' },
  ], offenses, { key: 'passRate', dir: -1 });

  frag.append(section('Offensive identity, all 32',
    'How each offense is projected to distribute the ball. <strong>Pass lean</strong> is dropbacks as a share of plays — the clearest single read on what a team wants to do, and what a defense that stops one thing forces them into. <strong>Concentration</strong> is a Herfindahl index over target share: high means one receiver eats and his teammates are traps, low means the work is spread and nobody is safe.<br><span class="quiet">Volume sums every rostered player’s projection including backups who probably won’t play, so it runs above a real box score. The ratios are the comparable part; the count is the denominator behind them.</span>',
    legend([{ label: 'Pass', color: posColor('WR') }, { label: 'Run', color: posColor('RB') }]),
    el('div', { class: 'panel scroll-x' }, table)));

  return frag;
};

// ---- shell ----------------------------------------------------------------

const TABS = [
  ['power', 'Power'],
  ['scheme', 'Scheme'],
  ['matchups', 'Matchups'],
  ['players', 'Players'],
  ['offense', 'Offenses'],
];

const main = document.getElementById('main');
const tabBar = document.getElementById('tabs');

const show = (key) => {
  main.replaceChildren(views[key]());
  for (const button of tabBar.children) button.setAttribute('aria-selected', String(button.dataset.key === key));
  window.scrollTo({ top: 0, behavior: 'instant' });
};

for (const [key, label] of TABS) {
  tabBar.append(el('button', { type: 'button', role: 'tab', 'data-key': key,
    'aria-selected': key === 'power', onclick: () => show(key) }, label));
}

document.getElementById('league-name').textContent = DATA.league.name;
document.getElementById('league-meta').textContent =
  [DATA.league.format, `${DATA.league.teamCount} teams`,
   DATA.league.superFlex ? 'superflex' : null, `${DATA.league.season} week ${DATA.league.week}`]
    .filter(Boolean).join(' · ');

document.getElementById('stamps').append(
  ...[['Sims', DATA.iterations.toLocaleString()],
      ['Projections', DATA.modelVersion ?? '—'],
      ['Defense', DATA.defenseMeta ? `${DATA.defenseMeta.version} · ${DATA.defenseMeta.seasons.join('+')}` : '—'],
      ['Players', String(DATA.players.length)],
      ['Built', new Date(DATA.generatedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC']]
    .map(([label, value]) => el('span', {}, label + ' ', el('b', {}, value))));

document.getElementById('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.getAttribute('data-theme') === 'dark'
    || (!root.hasAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', dark ? 'light' : 'dark');
});

show('power');
