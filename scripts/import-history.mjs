import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { owners } from "../server/identities.js";
import { validateArchive } from "../server/history.js";
import { applyPrecision } from "./espn-precision.mjs";

export function importHistory(html, precise) {
  const match = html.match(/\bconst DATA = (\{[^\n]+\});/);
  if (!match) throw new Error("Historical DATA JSON not found");
  const data = JSON.parse(match[1]);
  const seasons = data.seasons.map((season) => {
    const year = season.year;
    const sourceTeams = data.teams.filter((team) => team.year === year);
    const teams = sourceTeams.map((team) => {
      const owner = owners.find((item) => item.espnKey === team.manager_key);
      if (!owner) throw new Error(`Unmapped owner: ${team.owner_display}`);
      return { rosterId: team.team_id, teamRef: team.team_ref, canonicalOwnerIds: [owner.id], ownerIds: team.owner_ids, managerNames: [owner.name], managerName: owner.name, teamName: team.team_name, avatarUrl: null };
    });
    const completedWeeks = [];
    for (let week = season.first_scoring_period; week <= season.reg_season_count; week++) {
      const matchups = data.matchups.filter((game) => game.year === year && game.week === week && game.stage === "regular");
      const entries = matchups.flatMap((game, index) => {
        if (!game.completed || !game.home || !game.away || game.home.team_id === game.away.team_id) throw new Error(`Invalid matchup: ${game.matchup_ref}`);
        if (!["HOME", "AWAY", "TIE"].includes(game.winner)) throw new Error(`Missing matchup outcome: ${game.matchup_ref}`);
        return [game.home, game.away].map((side, sideIndex) => ({ rosterId: side.team_id, matchupId: index + 1, score: side.score, result: game.winner === "TIE" ? "ties" : game.winner === (sideIndex === 0 ? "HOME" : "AWAY") ? "wins" : "losses" }));
      });
      completedWeeks.push({ week, status: "final", entries });
    }
    const standings = data.standings.filter((row) => row.year === year).map((row) => ({ rosterId: row.team_id, teamName: row.team_name, managerName: teams.find((team) => team.rosterId === row.team_id)?.managerName, finalRank: row.final_rank, isChampion: row.is_champion, championNote: row.champion_note, wins: row.wins, losses: row.losses, ties: row.ties, pointsFor: row.points_for, pointsAgainst: row.points_against }));
    return { snapshot: { metadata: { leagueId: "espn:594599", source: "espn", name: season.league_name, season: String(year), teamCount: season.team_count, startWeek: season.first_scoring_period, regularSeasonEnd: season.reg_season_count, currentWeek: season.reg_season_count + 1, lastCompletedWeek: season.reg_season_count }, teams, completedWeeks, liveWeek: null, currentWeekData: null, warnings: [] }, recap: { standings, corrections: data.metadata.manual_overrides.filter((item) => item.year === year) } };
  });
  const archive = validateArchive({ schemaVersion: 1, provenance: { source: "ESPN historical dashboard", generatedAt: data.metadata.generated_at, leagueId: String(data.metadata.league_id), precisionNote: "Archived weekly scores are rounded to one decimal in the source. Scoring totals are calculated from those scores and may differ slightly from ESPN standings totals. Records preserve recorded matchup outcomes, including wins that round to tied scores." }, seasons });
  return precise ? applyPrecision(archive, precise) : archive;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = resolve(process.argv[2] || "../index.html");
  const output = resolve(process.argv[3] || "data/history.json");
  // Require the bundled API extract: never silently revert to rounded HTML scores.
  const precise = JSON.parse(await readFile(new URL("../data/espn-scores.json", import.meta.url), "utf8"));
  const archive = importHistory(await readFile(input, "utf8"), precise);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(archive, null, 2)}\n`);
  console.info(`Imported and reconciled ${archive.seasons.length} seasons into ${output}`);
}
