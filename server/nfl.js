const aliases = { JAC: "JAX", LA: "LAR", WSH: "WAS" };
export function nflTeam(value) {
  const team = String(value || "").toUpperCase();
  return aliases[team] || team;
}

export function normalizeScoreboard(raw, season, week) {
  if (Number(raw?.season?.year) !== Number(season) || Number(raw?.season?.type) !== 2 || Number(raw?.week?.number) !== Number(week) || !Array.isArray(raw.events) || !raw.events.length) {
    throw new Error("NFL scoreboard season/week mismatch or empty schedule");
  }
  const games = {};
  for (const event of raw.events) {
    if (Number(event.season?.year) !== Number(season) || Number(event.week?.number) !== Number(week) || Number(event.season?.type) !== 2) throw new Error("NFL event season/week mismatch");
    const competition = event.competitions?.[0];
    const teams = competition?.competitors;
    if (teams?.length !== 2 || teams.some((item) => !item.team?.abbreviation)) throw new Error("Incomplete NFL game");
    const status = event.status || competition.status;
    const name = status?.type?.name || "";
    const state = /POSTPONED|DELAYED|SUSPENDED/.test(name) ? "postponed"
      : /CANCEL/.test(name) ? "canceled"
      : status?.type?.completed ? "final"
      : status?.type?.state === "in" ? "live"
      : status?.type?.state === "pre" ? "scheduled" : "unknown";
    teams.forEach((side, i) => {
      const team = nflTeam(side.team.abbreviation);
      if (games[team]) throw new Error("Duplicate NFL team");
      games[team] = { id: String(event.id), opponent: nflTeam(teams[1 - i].team.abbreviation), home: side.homeAway === "home", kickoff: event.date, state, detail: status?.type?.shortDetail || status?.type?.description || "Status unavailable" };
    });
  }
  return games;
}

export class NflScoreboard {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, log = console } = {}) {
    Object.assign(this, { fetchImpl, now, log });
    this.entries = new Map();
  }
  refresh(season, week) {
    const key = `${season}/2/${week}`;
    let entry = this.entries.get(key);
    if (!entry) { entry = { lastAttempt: -Infinity, fetchedAt: null, games: null, pending: null }; this.entries.set(key, entry); }
    if (entry.pending) return entry.pending;
    if (this.now() - entry.lastAttempt < 60000) return Promise.resolve();
    entry.lastAttempt = this.now();
    entry.pending = (async () => {
      try {
        const response = await this.fetchImpl(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${encodeURIComponent(season)}&seasontype=2&week=${encodeURIComponent(week)}`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`NFL HTTP ${response.status}`);
        const games = normalizeScoreboard(await response.json(), season, week);
        Object.assign(entry, { games, fetchedAt: this.now(), failed: false });
      } catch (error) { entry.failed = true; this.log.warn("nfl_status_unavailable", error.message); }
    })().finally(() => { entry.pending = null; });
    return entry.pending;
  }
  dashboard(season, week) {
    const entry = this.entries.get(`${season}/2/${week}`);
    return { season: String(season), week, source: "ESPN", games: entry?.games || {}, fetchedAt: entry?.fetchedAt == null ? null : new Date(entry.fetchedAt).toISOString(), stale: entry?.fetchedAt == null || this.now() - entry.fetchedAt >= 180000, unavailable: !entry?.games, failed: Boolean(entry?.failed) };
  }
}
