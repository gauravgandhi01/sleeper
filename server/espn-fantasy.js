import { owners } from "./identities.js";
import { nflTeam } from "./nfl.js";

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const CACHE_MS = 60_000;
const STALE_MS = 180_000;
const ESPN_TEAMS = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
  9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN",
  17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
  25: "SF", 26: "SEA", 27: "TB", 28: "WAS", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

export function projectionKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\bd\/st\b/g, "defense")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function projectionFor(player, season, week) {
  const stats = player?.stats || [];
  const candidates = stats.filter((stat) => Number(stat.seasonId) === Number(season)
    && Number(stat.scoringPeriodId) === Number(week)
    && Number(stat.statSourceId) !== 0
    && Number(stat.statSplitTypeId) !== 2);
  for (const stat of candidates) {
    const value = Number(stat.appliedTotal);
    if (Number.isFinite(value)) return Math.round(value * 100) / 100;
  }
  return null;
}

function normalizeProjectionPayload(payload, season, week) {
  const teams = new Map();
  for (const team of payload.teams || []) {
    const ownerIds = (team.owners || [])
      .map((id) => owners.find((owner) => owner.espnKey === `owner:${id}`)?.id)
      .filter(Boolean);
    teams.set(team.id, { ownerIds, projectedScore: null });
  }

  const playersByName = new Map();
  const defensesByTeam = new Map();
  for (const matchup of payload.schedule || []) {
    for (const side of ["home", "away"]) {
      const data = matchup[side];
      if (!data) continue;
      const team = teams.get(data.teamId) || { ownerIds: [], projectedScore: null };
      const teamProjected = Number(data.totalProjectedPointsLive);
      if (Number.isFinite(teamProjected)) team.projectedScore = Math.round(teamProjected * 100) / 100;
      teams.set(data.teamId, team);

      for (const entry of data.rosterForCurrentScoringPeriod?.entries || []) {
        const player = entry.playerPoolEntry?.player || entry.player;
        const projectedPoints = projectionFor(player, season, week);
        if (!player || projectedPoints == null) continue;
        const fullName = player.fullName || `${player.firstName || ""} ${player.lastName || ""}`;
        const record = { projectedPoints, name: fullName, nflTeam: nflTeam(ESPN_TEAMS[player.proTeamId]) };
        playersByName.set(projectionKey(fullName), record);
        if (Number(player.defaultPositionId) === 16 && record.nflTeam) defensesByTeam.set(record.nflTeam, record);
      }
    }
  }

  return { teams, playersByName, defensesByTeam };
}

export class EspnFantasyProjections {
  constructor({ leagueId = process.env.ESPN_FANTASY_LEAGUE_ID || "594599", espnS2 = process.env.ESPN_S2, swid = process.env.SWID, fetchImpl = globalThis.fetch, now = Date.now, log = console } = {}) {
    Object.assign(this, { leagueId: String(leagueId || ""), espnS2, swid, fetchImpl, now, log });
    this.cache = new Map();
    this.pending = new Map();
  }

  enabled() { return Boolean(this.leagueId && this.espnS2 && this.swid); }

  async refresh(season, week) {
    const key = `${season}/${week}`;
    const cached = this.cache.get(key);
    if (!this.enabled()) {
      this.cache.set(key, { season: String(season), week, unavailable: true, reason: "missing_credentials" });
      return;
    }
    if (cached?.fetchedAt && this.now() - Date.parse(cached.fetchedAt) < CACHE_MS) return;
    if (this.pending.has(key)) return this.pending.get(key);
    const work = this.fetch(season, week).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }

  async fetch(season, week) {
    const key = `${season}/${week}`;
    const prior = this.cache.get(key);
    const url = new URL(`${BASE}/seasons/${encodeURIComponent(season)}/segments/0/leagues/${encodeURIComponent(this.leagueId)}`);
    for (const view of ["mMatchupScore", "mScoreboard", "mTeam"]) url.searchParams.append("view", view);
    url.searchParams.set("scoringPeriodId", String(week));
    const headers = {
      Accept: "application/json",
      Cookie: `espn_s2=${this.espnS2}; SWID=${this.swid}`,
    };
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 8000) : null;
    try {
      const response = await this.fetchImpl(url, { headers, signal: controller?.signal });
      if (!response.ok) throw new Error(`ESPN fantasy returned HTTP ${response.status}`);
      const payload = await response.json();
      const projections = normalizeProjectionPayload(Array.isArray(payload) ? payload[0] : payload, season, week);
      this.cache.set(key, { season: String(season), week, fetchedAt: new Date(this.now()).toISOString(), source: "ESPN fantasy", ...projections });
    } catch (error) {
      this.log.warn?.("espn_projection_failure", { season, week, error: error.message });
      this.cache.set(key, prior?.fetchedAt ? { ...prior, failed: true } : { season: String(season), week, unavailable: true, failed: true });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  dashboard(season, week) {
    const data = this.cache.get(`${season}/${week}`);
    if (!data) return this.enabled() ? null : { season: String(season), week, unavailable: true, reason: "missing_credentials" };
    const stale = Boolean(data.fetchedAt && this.now() - Date.parse(data.fetchedAt) > STALE_MS);
    return { ...data, stale };
  }
}
