import { readFile } from "node:fs/promises";
import { calculateStats } from "../src/stats.js";
import { validateSnapshot } from "./store.js";
import { owners } from "./identities.js";

export function seasonRecords(snapshot) {
  const rows = new Map(snapshot.teams.map((team) => [team.rosterId, { rosterId: team.rosterId, teamName: team.teamName, canonicalOwnerIds: team.canonicalOwnerIds || [], games: 0, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 }]));
  for (const week of snapshot.completedWeeks) {
    const pairs = new Map();
    for (const entry of week.entries) {
      const row = rows.get(entry.rosterId);
      row.games++;
      row.pointsFor += entry.score;
      if (entry.matchupId != null) pairs.set(entry.matchupId, [...(pairs.get(entry.matchupId) || []), entry]);
    }
    for (const pair of pairs.values()) {
      if (pair.length !== 2) continue;
      pair.forEach((entry, index) => {
        const opponent = pair[1 - index];
        const row = rows.get(entry.rosterId);
        row.pointsAgainst += opponent.score;
        const result = entry.result || (entry.score === opponent.score ? "ties" : entry.score > opponent.score ? "wins" : "losses");
        row[result]++;
      });
    }
  }
  return [...rows.values()];
}

export function validateArchive(archive) {
  if (archive?.schemaVersion !== 1 || !Array.isArray(archive.seasons) || archive.seasons.length !== 8) throw new Error("Invalid ESPN archive");
  const years = new Set();
  for (const season of archive.seasons) {
    const { snapshot, recap } = season;
    validateSnapshot(snapshot, "espn:594599");
    const year = Number(snapshot.metadata.season);
    if (year < 2018 || year > 2025 || years.has(year)) throw new Error("Invalid archive season");
    years.add(year);
    if (snapshot.completedWeeks.length !== snapshot.metadata.regularSeasonEnd - snapshot.metadata.startWeek + 1) throw new Error("Incomplete archive weeks");
    const weekNumbers = new Set();
    for (const week of snapshot.completedWeeks) {
      if (week.status !== "final") throw new Error("Unfinalized archive week");
      if (weekNumbers.has(week.week)) throw new Error("Duplicate archive week");
      weekNumbers.add(week.week);
      const pairs = new Map();
      for (const entry of week.entries) pairs.set(entry.matchupId, [...(pairs.get(entry.matchupId) || []), entry]);
      if ([...pairs].some(([id, entries]) => id == null || entries.length !== 2 || !["wins/losses", "losses/wins", "ties/ties"].includes(entries.map((entry) => entry.result).join("/")))) throw new Error("Invalid archive opponents");
      for (const [a, b] of pairs.values()) {
        if (a.score !== b.score && a.result !== (a.score > b.score ? "wins" : "losses")) throw new Error("Archive outcome contradicts scores");
      }
    }
    if (snapshot.teams.some((team) => team.canonicalOwnerIds?.length !== 1 || !owners.some((owner) => owner.id === team.canonicalOwnerIds[0]))) throw new Error("Unknown archive owner");
    if (recap.standings.length !== snapshot.teams.length || recap.standings.filter((row) => row.isChampion).length !== 1) throw new Error("Invalid archive standings");
    for (const row of seasonRecords(snapshot)) {
      const standing = recap.standings.find((item) => item.rosterId === row.rosterId);
      // Raw API values must reconcile within floating-point error only.
      const roundingBound = archive.provenance?.scorePrecision === "original-api" ? 1e-6 : (row.games + 1) * 0.05 + 1e-8;
      if (!standing || ["wins", "losses", "ties"].some((key) => standing[key] !== row[key]) || !Number.isFinite(standing.pointsFor) || !Number.isFinite(standing.pointsAgainst) || Math.abs(row.pointsFor - standing.pointsFor) > roundingBound || Math.abs(row.pointsAgainst - standing.pointsAgainst) > roundingBound) throw new Error(`Archive reconciliation failed: ${year} roster ${row.rosterId}`);
    }
  }
  return archive;
}

export class History {
  constructor(archive) { this.archive = validateArchive(archive); }
  static async load() { return new History(JSON.parse(await readFile(new URL("../data/history.json", import.meta.url), "utf8"))); }
  dashboard(year) {
    const season = this.archive.seasons.find((item) => item.snapshot.metadata.season === String(year));
    if (!season) return null;
    return { schemaVersion: 1, stats: calculateStats(season.snapshot), source: "espn", provenance: this.archive.provenance, recap: season.recap, currentWeekMatchups: null, draftBoard: null, lastSuccessfulFetchAt: null, stale: false, warnings: [] };
  }
  seasons(currentSeason) {
    return { currentSeason: String(currentSeason), seasons: [{ season: String(currentSeason), source: "sleeper", current: true }, ...this.archive.seasons.map(({ snapshot }) => ({ season: snapshot.metadata.season, source: "espn", current: false }))].sort((a, b) => Number(b.season) - Number(a.season)) };
  }
  careers(currentSnapshot, { currentSeason, stale = false } = {}) {
    const known = new Map(owners.map((owner) => [owner.id, { id: owner.id, name: owner.name, current: currentSnapshot ? currentSnapshot.teams.some((team) => team.canonicalOwnerIds?.includes(owner.id)) : Boolean(owner.sleeperId), seasons: [] }]));
    const seasons = [...this.archive.seasons];
    if (currentSnapshot) seasons.push({ snapshot: currentSnapshot, recap: { standings: [] } });
    for (const { snapshot, recap } of seasons) {
      for (const row of seasonRecords(snapshot)) {
        for (const ownerId of row.canonicalOwnerIds) {
          if (!known.has(ownerId)) known.set(ownerId, { id: ownerId, name: snapshot.teams.find((team) => team.rosterId === row.rosterId).managerName, current: true, seasons: [] });
          known.get(ownerId).seasons.push({ ...row, season: snapshot.metadata.season, ongoing: snapshot.metadata.source !== "espn" && snapshot.metadata.status !== "complete", champion: recap.standings.some((standing) => standing.rosterId === row.rosterId && standing.isChampion) });
        }
      }
    }
    return { schemaVersion: 1, currentSeason: String(currentSeason), currentDataAvailable: Boolean(currentSnapshot), stale,
      owners: [...known.values()].map((owner) => {
        const total = { seasonsPlayed: 0, games: 0, wins: 0, losses: 0, ties: 0, pointsFor: 0, championships: 0 };
        const years = new Set();
        for (const row of owner.seasons) {
          if (row.games) years.add(row.season);
          for (const key of ["games", "wins", "losses", "ties", "pointsFor"]) total[key] += row[key];
          if (row.champion) total.championships++;
        }
        total.seasonsPlayed = years.size;
        const decisions = total.wins + total.losses + total.ties;
        return { ...owner, seasons: owner.seasons.sort((a, b) => Number(b.season) - Number(a.season)), ...total, winPct: decisions ? (total.wins + total.ties / 2) / decisions : null, pointsPerGame: total.games ? total.pointsFor / total.games : null };
      }).sort((a, b) => a.name.localeCompare(b.name)) };
  }
}
