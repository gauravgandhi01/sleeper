import { calculateStats } from "../src/stats.js";
import { fetchSleeperSeason } from "../src/sleeper.js";
import { applyDisplayNames } from "./names.js";
import { linkCurrentOwners } from "./identities.js";

export function currentMatchups(snapshot, players = {}) {
  const { currentWeek, regularSeasonEnd } = snapshot.metadata;
  if (currentWeek > regularSeasonEnd) return { week: null, status: "season_complete", matchups: [], unpairedTeams: [] };
  const week = snapshot.currentWeekData;
  if (!week) return { week: currentWeek, status: "unavailable", matchups: [], unpairedTeams: [] };
  const teams = new Map(snapshot.teams.map((t) => [t.rosterId, t]));
  const groups = new Map();
  const unpairedTeams = [];
  for (const entry of week.entries) {
    const starters = Array.isArray(entry.starters) ? entry.starters.map((starter, index) => ({
      ...starter,
      slot: snapshot.metadata.startingSlots?.[index] || "—",
      name: starter.playerId === null ? "Empty slot" : players[starter.playerId]?.name || `Player ${starter.playerId}`,
      position: players[starter.playerId]?.position || null,
      nflTeam: players[starter.playerId]?.nflTeam || null,
    })) : null;
    const side = { ...teams.get(entry.rosterId), score: entry.score, starters };
    if (entry.matchupId == null) unpairedTeams.push(side);
    else groups.set(entry.matchupId, [...(groups.get(entry.matchupId) || []), side]);
  }
  const matchups = [];
  for (const [matchupId, sides] of [...groups].sort(([a], [b]) => a - b)) {
    if (sides.length !== 2) { unpairedTeams.push(...sides); continue; }
    const difference = sides[0].score - sides[1].score;
    matchups.push({ matchupId, teams: sides, margin: Math.abs(difference), leaderRosterId: difference === 0 ? null : sides[difference > 0 ? 0 : 1].rosterId });
  }
  return { week: currentWeek, status: week.status === "live" ? "provisional" : week.status, matchups, unpairedTeams };
}

export class DashboardService {
  constructor({ store, leagueId, playerDirectory = null, draftBoard = null, fetchSeason = fetchSleeperSeason, now = Date.now, log = console }) {
    Object.assign(this, { store, leagueId, playerDirectory, draftBoard, fetchSeason, now, log });
    this.saved = null;
    this.lastAttempt = -Infinity;
    this.failure = null;
    this.pending = null;
  }
  async initialize() { this.saved = await this.store.load(); }
  refresh() {
    if (this.pending) return this.pending;
    if (this.now() - this.lastAttempt < 60000) return Promise.resolve();
    this.lastAttempt = this.now();
    this.pending = this.performRefresh().finally(() => { this.pending = null; });
    return this.pending;
  }
  async performRefresh() {
    const start = this.now();
    try {
      const snapshot = await this.fetchSeason({ leagueId: this.leagueId, now: new Date(start), strict: true });
      this.saved = await this.store.save(snapshot, new Date(this.now()).toISOString());
      await Promise.all([this.playerDirectory?.refresh(), this.draftBoard?.refresh(snapshot.metadata.draftId)]);
      this.failure = null;
      this.log.info("refresh_success", { durationMs: this.now() - start, lastSuccessfulFetchAt: this.saved.lastSuccessfulFetchAt });
    } catch (error) {
      this.failure = "The latest refresh failed; saved league data is being shown.";
      this.log.error("refresh_failure", { durationMs: this.now() - start, error: error.message, lastSuccessfulFetchAt: this.saved?.lastSuccessfulFetchAt || null });
    }
  }
  dashboard() {
    if (!this.saved) return null;
    const { lastSuccessfulFetchAt } = this.saved;
    const snapshot = linkCurrentOwners(applyDisplayNames(this.saved.snapshot));
    const stale = Boolean(this.failure) || this.now() - Date.parse(lastSuccessfulFetchAt) > 20 * 60000;
    const warnings = [...snapshot.warnings];
    if (this.failure) warnings.push(this.failure);
    else if (stale) warnings.push("League data has not been updated in over 20 minutes.");
    return { schemaVersion: 1, stats: calculateStats(snapshot), draftBoard: this.draftBoard?.dashboard(snapshot.metadata.draftId, snapshot.teams) || null, currentWeekMatchups: currentMatchups(snapshot, this.playerDirectory?.players), lastSuccessfulFetchAt, stale, warnings };
  }
}
