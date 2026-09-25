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

function statValue(stats, id) {
  const value = Number(stats?.[id]);
  return Number.isFinite(value) ? value : 0;
}

function statAny(stats, ids) {
  for (const id of ids) {
    if (Number.isFinite(Number(stats?.[id]))) return statValue(stats, id);
  }
  return 0;
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function pushStat(parts, value, label) {
  if (value) parts.push(`${compactNumber(value)} ${label}`);
}

function actualStatsFor(player, season, week) {
  return (player?.stats || []).find((item) => Number(item.seasonId) === Number(season)
    && Number(item.scoringPeriodId) === Number(week)
    && Number(item.statSourceId) === 0
    && Number(item.statSplitTypeId) !== 2
    && item.stats);
}

function actualStatLine(player, season, week) {
  const stats = actualStatsFor(player, season, week)?.stats;
  if (!stats) return null;
  const position = Number(player?.defaultPositionId);
  const parts = [];
  if (position === 5) {
    const fgMade = statAny(stats, [83]) || statValue(stats, 80) + statValue(stats, 77) + statValue(stats, 74) + statValue(stats, 198) + statValue(stats, 201);
    const fgAtt = statAny(stats, [84]) || fgMade + statValue(stats, 85);
    const xpMade = statValue(stats, 86);
    const xpAtt = statValue(stats, 87) || xpMade + statValue(stats, 88);
    if (fgMade || fgAtt) parts.push(`FG ${compactNumber(fgMade)}/${compactNumber(fgAtt)}`);
    if (xpMade || xpAtt) parts.push(`XP ${compactNumber(xpMade)}/${compactNumber(xpAtt)}`);
    return parts.join(", ") || null;
  }
  if (position === 16) {
    pushStat(parts, statValue(stats, 99), "sack");
    pushStat(parts, statValue(stats, 95) + statValue(stats, 96), "takeaway");
    pushStat(parts, statValue(stats, 105) || statValue(stats, 93) + statValue(stats, 94) + statValue(stats, 101) + statValue(stats, 102) + statValue(stats, 103) + statValue(stats, 104), "TD");
    pushStat(parts, statValue(stats, 98), "safety");
    if (Number.isFinite(Number(stats[120]))) parts.push(`${compactNumber(statValue(stats, 120))} PA`);
    return parts.join(", ") || null;
  }

  const completions = statValue(stats, 1);
  const attempts = statValue(stats, 0);
  const passingYards = statAny(stats, [3, 22]);
  const passingTouchdowns = statValue(stats, 4);
  const interceptions = statValue(stats, 20);
  const touchdownTotal = passingTouchdowns + statValue(stats, 25) + statValue(stats, 43);
  if (completions || attempts || passingYards || passingTouchdowns || interceptions) {
    if (attempts) parts.push(`${compactNumber(completions)}/${compactNumber(attempts)}`);
    pushStat(parts, passingYards, "pass yd");
    pushStat(parts, interceptions, "INT");
  }

  const rushingAttempts = statValue(stats, 23);
  const rushingYards = statAny(stats, [24, 40]);
  const rushingTouchdowns = statValue(stats, 25);
  if (rushingAttempts || rushingYards || rushingTouchdowns) {
    pushStat(parts, rushingYards, "rush yd");
  }

  const receptions = statAny(stats, [41, 53]);
  const targets = statValue(stats, 58);
  const receivingYards = statAny(stats, [42, 61]);
  const receivingTouchdowns = statValue(stats, 43);
  if (receptions || targets || receivingYards || receivingTouchdowns) {
    pushStat(parts, receptions, "rec");
    pushStat(parts, receivingYards, "rec yd");
  }
  pushStat(parts, touchdownTotal, "TD");

  pushStat(parts, statValue(stats, 62), "2PT");
  pushStat(parts, statValue(stats, 72), "fum lost");
  return parts.join(", ") || null;
}

function trueLeagueKickerProjection(player, season, week) {
  if (Number(player?.defaultPositionId) !== 5) return null;
  const stat = (player?.stats || []).find((item) => Number(item.seasonId) === Number(season)
    && Number(item.scoringPeriodId) === Number(week)
    && Number(item.statSourceId) !== 0
    && Number(item.statSplitTypeId) !== 2);
  const stats = stat?.stats;
  if (!stats) return null;
  const madeUnder40 = statValue(stats, 80);
  const made40 = statValue(stats, 77);
  const made50 = Object.hasOwn(stats, "198") ? statValue(stats, 198) : statValue(stats, 74);
  const made60 = statValue(stats, 201);
  const madeXp = statValue(stats, 86);
  const missedFg = statValue(stats, 85);
  const missedXp = statValue(stats, 88);
  const value = (madeUnder40 * 2)
    + (made40 * 3)
    + (made50 * 4)
    + (made60 * 5)
    + madeXp
    - missedFg
    - missedXp;
  return Math.round(value * 100) / 100;
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
  const addPlayer = (player) => {
    const projectedPoints = trueLeagueKickerProjection(player, season, week) ?? projectionFor(player, season, week);
    const statLine = actualStatLine(player, season, week);
    if (!player || (projectedPoints == null && !statLine)) return;
    const fullName = player.fullName || `${player.firstName || ""} ${player.lastName || ""}`;
    const record = { projectedPoints, statLine, name: fullName, nflTeam: nflTeam(ESPN_TEAMS[player.proTeamId]) };
    playersByName.set(projectionKey(fullName), record);
    if (Number(player.defaultPositionId) === 16 && record.nflTeam) defensesByTeam.set(record.nflTeam, record);
  };
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
        addPlayer(player);
      }
    }
  }
  for (const entry of payload.players || []) addPlayer(entry.playerPoolEntry?.player || entry.player);

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
    url.searchParams.append("view", "kona_player_info");
    url.searchParams.set("scoringPeriodId", String(week));
    const headers = {
      Accept: "application/json",
      Cookie: `espn_s2=${this.espnS2}; SWID=${this.swid}`,
      "x-fantasy-filter": JSON.stringify({ players: { filterStatus: { value: ["FREEAGENT", "WAIVERS", "ONTEAM"] }, limit: 2000, sortPercOwned: { sortPriority: 1, sortAsc: false } } }),
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
