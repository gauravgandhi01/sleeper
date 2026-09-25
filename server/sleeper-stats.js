const CACHE_MS = 60_000;
const STALE_MS = 180_000;

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const display = (value) => Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");

function push(parts, value, label) {
  if (value) parts.push(`${display(value)} ${label}`);
}

export function sleeperStatLine(stats, mode = "player") {
  if (!stats || typeof stats !== "object") return null;
  const parts = [];
  if (mode === "defense") {
    push(parts, number(stats.def_sack), "sack");
    push(parts, number(stats.def_int) + number(stats.def_fr), "takeaway");
    push(parts, number(stats.def_td) + number(stats.def_st_td) + number(stats.def_pr_td) + number(stats.def_kr_td), "TD");
    push(parts, number(stats.def_safe), "safety");
    if (Number.isFinite(Number(stats.pts_allow))) parts.push(`${display(number(stats.pts_allow))} PA`);
    return parts.join(", ") || null;
  }

  const passAtt = number(stats.pass_att);
  const passCmp = number(stats.pass_cmp);
  const touchdownTotal = number(stats.pass_td) + number(stats.rush_td) + number(stats.rec_td);
  if (passAtt || passCmp || stats.pass_yd || stats.pass_td || stats.pass_int) {
    if (passAtt) parts.push(`${display(passCmp)}/${display(passAtt)}`);
    push(parts, number(stats.pass_yd), "pass yd");
    push(parts, number(stats.pass_int), "INT");
  }

  if (stats.rush_att || stats.rush_yd || stats.rush_td) {
    push(parts, number(stats.rush_yd), "rush yd");
  }

  if (stats.rec || stats.rec_tgt || stats.rec_yd || stats.rec_td) {
    const receptions = number(stats.rec);
    push(parts, receptions, "rec");
    push(parts, number(stats.rec_yd), "rec yd");
  }
  push(parts, touchdownTotal, "TD");

  const fgMade = number(stats.fgm);
  const fgAtt = number(stats.fga);
  const xpMade = number(stats.xpm);
  const xpAtt = number(stats.xpa);
  if (fgMade || fgAtt) parts.push(`FG ${display(fgMade)}/${display(fgAtt)}`);
  if (xpMade || xpAtt) parts.push(`XP ${display(xpMade)}/${display(xpAtt)}`);

  push(parts, number(stats.rec_2pt) + number(stats.rush_2pt) + number(stats.pass_2pt), "2PT");
  push(parts, number(stats.fum_lost), "fum lost");
  return parts.join(", ") || null;
}

export class SleeperWeeklyStats {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, log = console } = {}) {
    Object.assign(this, { fetchImpl, now, log });
    this.entries = new Map();
  }

  refresh(season, week) {
    const key = `${season}/${week}`;
    let entry = this.entries.get(key);
    if (!entry) { entry = { lastAttempt: -Infinity, fetchedAt: null, lines: new Map(), pending: null }; this.entries.set(key, entry); }
    if (entry.pending) return entry.pending;
    if (this.now() - entry.lastAttempt < CACHE_MS) return Promise.resolve();
    entry.lastAttempt = this.now();
    entry.pending = (async () => {
      try {
        const response = await this.fetchImpl(`https://api.sleeper.app/v1/stats/nfl/regular/${encodeURIComponent(season)}/${encodeURIComponent(week)}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Sleeper stats HTTP ${response.status}`);
        const payload = await response.json();
        const lines = new Map();
        for (const [playerId, stats] of Object.entries(payload || {})) {
          const line = sleeperStatLine(stats, String(playerId).startsWith("TEAM_") ? "defense" : "player");
          if (line) lines.set(String(playerId), line);
        }
        Object.assign(entry, { lines, fetchedAt: this.now(), failed: false });
      } catch (error) {
        entry.failed = true;
        this.log.warn?.("sleeper_stats_unavailable", error.message);
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
      lines: entry?.lines || new Map(),
      fetchedAt: entry?.fetchedAt == null ? null : new Date(entry.fetchedAt).toISOString(),
      stale: entry?.fetchedAt == null || this.now() - entry.fetchedAt >= STALE_MS,
      unavailable: !entry?.fetchedAt,
      failed: Boolean(entry?.failed),
    };
  }
}
