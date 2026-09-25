const CACHE_MS = 60_000;
const STALE_MS = 180_000;

const positions = ["QB", "RB", "WR", "TE", "K", "DEF"];

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function kickerProjection(stats) {
  if (!stats) return null;
  const madeUnder40 = number(stats.fgm_0_19) + number(stats.fgm_20_29) + number(stats.fgm_30_39);
  const made40 = number(stats.fgm_40_49);
  const made50 = number(stats.fgm_50p);
  const missed = number(stats.fgmiss) + number(stats.fgmiss_0_19) + number(stats.fgmiss_20_29) + number(stats.fgmiss_30_39) + number(stats.fgmiss_40_49) + number(stats.fgmiss_50p);
  const value = (madeUnder40 * 2) + (made40 * 3) + (made50 * 4) + number(stats.xpm) - missed - number(stats.xpmiss);
  return value ? round(value) : null;
}

export function sleeperProjection(stats) {
  if (!stats || typeof stats !== "object") return null;
  return kickerProjection(stats) ?? round(Number(stats.pts_ppr ?? stats.pts_half_ppr ?? stats.pts_std));
}

export class SleeperWeeklyProjections {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, log = console } = {}) {
    Object.assign(this, { fetchImpl, now, log });
    this.entries = new Map();
  }

  refresh(season, week) {
    const key = `${season}/${week}`;
    let entry = this.entries.get(key);
    if (!entry) { entry = { lastAttempt: -Infinity, fetchedAt: null, playersById: new Map(), pending: null }; this.entries.set(key, entry); }
    if (entry.pending) return entry.pending;
    if (this.now() - entry.lastAttempt < CACHE_MS) return Promise.resolve();
    entry.lastAttempt = this.now();
    entry.pending = (async () => {
      try {
        const url = new URL(`https://api.sleeper.app/v1/projections/nfl/regular/${encodeURIComponent(season)}/${encodeURIComponent(week)}`);
        positions.forEach((position) => url.searchParams.append("position[]", position));
        url.searchParams.set("order_by", "ppr");
        const response = await this.fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Sleeper projections HTTP ${response.status}`);
        const payload = await response.json();
        const playersById = new Map();
        for (const [playerId, stats] of Object.entries(payload || {})) {
          const projectedPoints = sleeperProjection(stats);
          if (Number.isFinite(projectedPoints)) playersById.set(String(playerId), { projectedPoints, source: "Sleeper" });
        }
        Object.assign(entry, { playersById, fetchedAt: this.now(), failed: false });
      } catch (error) {
        entry.failed = true;
        this.log.warn?.("sleeper_projection_unavailable", error.message);
      }
    })().finally(() => { entry.pending = null; });
    return entry.pending;
  }

  dashboard(season, week) {
    const entry = this.entries.get(`${season}/${week}`);
    return {
      season: String(season),
      week,
      source: "Sleeper",
      playersById: entry?.playersById || new Map(),
      fetchedAt: entry?.fetchedAt == null ? null : new Date(entry.fetchedAt).toISOString(),
      stale: entry?.fetchedAt == null || this.now() - entry.fetchedAt >= STALE_MS,
      unavailable: !entry?.fetchedAt,
      failed: Boolean(entry?.failed),
    };
  }
}
