/**
 * Freeze one league into the JSON payload the standalone page inlines.
 *
 *     npx tsx scripts/export-static.mts <leagueId> <sleeperUsername> [outFile]
 */
import { writeFile } from 'node:fs/promises';
import { buildStaticSite } from '../apps/web/src/lib/static-export.js';

const [leagueId, username, out = 'site-data.json'] = process.argv.slice(2);
if (leagueId === undefined || username === undefined) {
  console.error('usage: export-static.mts <leagueId> <username> [outFile]');
  process.exit(1);
}

const started = Date.now();
const payload = await buildStaticSite(leagueId, username);
const json = JSON.stringify(payload);

await writeFile(out, json, 'utf8');
console.log(
  `${out}: ${(json.length / 1024).toFixed(0)} KB — ${payload.teams.length} teams, ` +
    `${payload.players.length} players, ${payload.defenses.length} defenses, ` +
    `${payload.matchups.length} matchups (${Date.now() - started} ms)`,
);
