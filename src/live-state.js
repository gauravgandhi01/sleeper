export function gameFor(starter, nfl) {
  const aliases = { JAC: "JAX", LA: "LAR", WSH: "WAS" };
  const team = starter?.nflTeam;
  return nfl?.games?.[aliases[team] || team] || null;
}

export function statusFresh(nfl, now = Date.now()) {
  return Boolean(nfl?.fetchedAt && !nfl.stale && !nfl.unavailable && now - Date.parse(nfl.fetchedAt) < 180000);
}

export function starterCounts(team, nfl, now = Date.now()) {
  if (!statusFresh(nfl, now) || !team.starters?.length) return null;
  const counts = { final: 0, live: 0, scheduled: 0, unknown: 0 };
  for (const starter of team.starters) {
    if (starter.playerId == null) continue;
    const state = gameFor(starter, nfl)?.state;
    if (state === "final" || state === "live" || state === "scheduled") counts[state]++;
    else if (state !== "final") counts.unknown++;
  }
  return counts;
}

export class LiveActivity {
  constructor() { this.key = null; this.previous = new Map(); this.entries = new Map(); this.changed = new Map(); this.timestamp = null; }
  observe(season, current, timestamp) {
    const key = `${season}/${current?.week}`;
    if (this.key !== key) { this.key = key; this.previous.clear(); this.entries.clear(); this.changed.clear(); this.timestamp = null; }
    if (!timestamp || !current || (this.timestamp && Date.parse(timestamp) <= Date.parse(this.timestamp))) return;
    const observedAt = new Date().toISOString();
    for (const matchup of current.matchups || []) {
      const prior = this.previous.get(matchup.matchupId);
      const changes = [];
      if (prior) {
        for (const team of matchup.teams) {
          const before = prior.teams.find((item) => item.rosterId === team.rosterId);
          if (before && Number.isFinite(team.score) && Number.isFinite(before.score) && Math.abs(team.score - before.score) > 0.0001) {
            changes.push({ team: team.teamName, delta: team.score - before.score, score: team.score });
            this.changed.set(team.rosterId, Date.now());
          }
        }
        if (changes.length) {
          const leadChanged = prior.leaderRosterId !== matchup.leaderRosterId;
          const leader = matchup.teams.find((team) => team.rosterId === matchup.leaderRosterId)?.teamName || null;
          const entries = this.entries.get(matchup.matchupId) || [];
          this.entries.set(matchup.matchupId, [{ observedAt, changes, leadChanged, leader }, ...entries].slice(0, 30));
        }
      }
      this.previous.set(matchup.matchupId, structuredClone(matchup));
    }
    this.timestamp = timestamp;
  }
}

export function shouldRefreshLive({ auto, visible, online, active, currentSeason, status, pending, lastAttempt, now = Date.now() }) {
  return auto && visible && online && active && currentSeason && !pending && !["final", "season_complete"].includes(status) && now - lastAttempt >= 60000;
}
