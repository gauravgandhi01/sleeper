import { readFile, writeFile, rename } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { validateArchive } from "../server/history.js";

/** Only public scoring fields are retained, never cookies or raw member data. */
export function normalizeEspnScores(raw, year) {
  if (raw?.id !== 594599 || raw.seasonId !== year || !Array.isArray(raw.schedule) || !Array.isArray(raw.teams)) throw new Error(`Invalid ESPN season ${year}`);
  const end = raw.settings?.scheduleSettings?.matchupPeriodCount;
  if (!Number.isInteger(end) || end < 1 || end > 18) throw new Error(`Missing regular-season length ${year}`);
  const teams = raw.teams.map((team) => {
    const record = team.record?.overall;
    if (!record) throw new Error(`Missing ESPN standings ${year}`);
    return { rosterId: team.id, wins: record.wins, losses: record.losses, ties: record.ties, pointsFor: record.pointsFor, pointsAgainst: record.pointsAgainst };
  });
  const weeks = Array.from({ length: end }, (_, index) => ({ week: index + 1, entries: [] }));
  for (const game of raw.schedule) {
    if (game.matchupPeriodId < 1 || game.matchupPeriodId > end) continue;
    if (!game.home || !game.away || !["HOME", "AWAY", "TIE"].includes(game.winner)) throw new Error(`Incomplete ESPN matchup ${year}`);
    for (const [side, other, label] of [[game.home, game.away, "HOME"], [game.away, game.home, "AWAY"]]) {
      if (!Number.isFinite(side.totalPoints)) throw new Error(`Missing exact score ${year}`);
      weeks[game.matchupPeriodId - 1].entries.push({ rosterId: side.teamId, opponentRosterId: other.teamId, score: side.totalPoints, result: game.winner === "TIE" ? "ties" : game.winner === label ? "wins" : "losses" });
    }
  }
  return { year, teams, weeks };
}

export function applyPrecision(archive, precise) {
  if (precise?.schemaVersion !== 1 || precise.leagueId !== "594599" || precise.seasons?.length !== archive.seasons.length || new Set(precise.seasons.map((season) => season.year)).size !== precise.seasons.length) throw new Error("Invalid precision data");
  const result = structuredClone(archive);
  for (const season of result.seasons) {
    const { snapshot, recap } = season;
    const exact = precise.seasons.find((item) => String(item.year) === snapshot.metadata.season);
    if (!exact || exact.weeks.length !== snapshot.completedWeeks.length || exact.teams.length !== snapshot.teams.length || new Set(exact.teams.map((team) => team.rosterId)).size !== exact.teams.length || new Set(exact.weeks.map((week) => week.week)).size !== exact.weeks.length) throw new Error("Precision season coverage mismatch");
    for (const week of snapshot.completedWeeks) {
      const sourceWeek = exact.weeks.find((item) => item.week === week.week);
      if (!sourceWeek || sourceWeek.entries.length !== week.entries.length || new Set(sourceWeek.entries.map((entry) => entry.rosterId)).size !== week.entries.length) throw new Error("Precision roster coverage mismatch");
      for (const entry of week.entries) {
        const source = sourceWeek.entries.find((item) => item.rosterId === entry.rosterId);
        const opponent = week.entries.find((item) => item.matchupId === entry.matchupId && item.rosterId !== entry.rosterId);
        if (!source || source.opponentRosterId !== opponent?.rosterId) throw new Error("Precision opponent mismatch");
        entry.score = source.score;
        entry.result = source.result;
      }
    }
    for (const standing of recap.standings) {
      const source = exact.teams.find((team) => team.rosterId === standing.rosterId);
      if (!source) throw new Error("Missing exact standings");
      for (const key of ["wins", "losses", "ties", "pointsFor", "pointsAgainst"]) standing[key] = source[key];
    }
  }
  result.provenance = { ...result.provenance, source: "ESPN API scores; historical dashboard identities and championship corrections", scorePrecision: "original-api", scoresFetchedAt: precise.fetchedAt, precisionNote: "Weekly scores and standings totals retain the original ESPN API precision. Calculations use those values without rounding; points are displayed to two decimal places." };
  return validateArchive(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { ESPN_S2, SWID } = process.env;
    if (!ESPN_S2 || !SWID) throw new Error("Set ESPN_S2 and SWID in the process environment");
    const archivePath = new URL("../data/history.json", import.meta.url);
    const archive = JSON.parse(await readFile(archivePath, "utf8"));
    const precise = { schemaVersion: 1, leagueId: "594599", fetchedAt: new Date().toISOString(), seasons: [] };
    for (const { snapshot } of archive.seasons) {
      const year = Number(snapshot.metadata.season);
      const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/594599?view=mMatchup&view=mMatchupScore&view=mTeam&view=mSettings`;
      const response = await fetch(url, { headers: { Cookie: `espn_s2=${ESPN_S2}; SWID=${SWID}` }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`ESPN ${year}: HTTP ${response.status}`);
      precise.seasons.push(normalizeEspnScores(await response.json(), year));
      console.info(`Retrieved original scores for ${year}`);
    }
    const updated = applyPrecision(archive, precise);
    for (const [name, data] of [["espn-scores.json", precise], ["history.json", updated]]) {
      const path = new URL(`../data/${name}`, import.meta.url);
      const temporary = new URL(`../data/${name}.tmp`, import.meta.url);
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`);
      await rename(temporary, path);
    }
    console.info("Reconciled all seasons and replaced archive scores with original ESPN values.");
  } catch (error) {
    // Avoid printing request objects or headers containing session credentials.
    console.error(error.message);
    process.exitCode = 1;
  }
}
