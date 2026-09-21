import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore, validateSnapshot } from "../server/store.js";
import { DashboardService, currentMatchups } from "../server/service.js";
import { createApp } from "../server/app.js";
import { fetchSleeperSeason, cutoffCompletedWeek } from "../src/sleeper.js";
import { PlayerDirectory } from "../server/players.js";
import { DraftBoard, normalizeDraft } from "../server/draft.js";
import { EspnFantasyProjections } from "../server/espn-fantasy.js";

test("draft grid follows actual snake slots and retains compound last names", () => {
  const raw = { draft_id: "123", season: "2026", type: "snake", status: "complete", settings: { rounds: 2, teams: 2 }, slot_to_roster_id: { 1: 2, 2: 1 } };
  const picks = [[1, 1], [1, 2], [2, 2], [2, 1]].map(([round, draft_slot], i) => ({ round, draft_slot, pick_no: i + 1, metadata: { first_name: "Amon-Ra", last_name: "St. Brown", position: "WR", team: "DET" } }));
  const board = normalizeDraft(raw, picks);
  assert.equal(board.columns[0].rosterId, 2);
  assert.equal(board.picks[2].slot, 2);
  assert.equal(board.picks[2].lastName, "St. Brown");
  assert.throws(() => normalizeDraft(raw, picks.slice(1)), /Incomplete/);
  assert.throws(() => normalizeDraft(raw, [picks[0], picks[0]]), /duplicate/);
});

test("draft cache survives restart and failures, with mapped manager headers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sleeper-draft-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let time = 100000;
  let failed = false;
  let calls = 0;
  const raw = { draft_id: "123", status: "complete", settings: { rounds: 1, teams: 1 }, slot_to_roster_id: { 1: 4 } };
  const picks = [{ round: 1, draft_slot: 1, pick_no: 1, metadata: { last_name: "Gibbs" } }];
  const cache = new DraftBoard(dir, "456", { now: () => time, log, fetchImpl: async (url) => {
    calls++;
    if (failed) throw new Error("Offline");
    return { ok: true, json: async () => url.endsWith("/picks") ? picks : raw };
  } });
  await cache.initialize();
  await cache.refresh("123");
  await cache.refresh("123");
  assert.equal(calls, 2);
  assert.equal(cache.dashboard("123", [{ rosterId: 4, managerName: "Alex" }]).columns[0].managerName, "Alex");
  const restored = new DraftBoard(dir, "456", { log });
  await restored.initialize();
  assert.equal(restored.dashboard("123", []).picks[0].lastName, "Gibbs");
  time += 86400001;
  failed = true;
  await cache.refresh("123");
  assert.equal(cache.dashboard("123", []).stale, true);
  assert.equal(cache.dashboard("123", []).picks.length, 1);
  assert.equal(cache.dashboard("999", []), null);
});

const id = "1395542220504854528";
const log = { info() {}, warn() {}, error() {} };
test("Tuesday 3am Eastern cutoff respects exact boundary, season and daylight saving", () => {
  const state = { season: "2026", season_start_date: "2026-09-09" };
  const completed = (date) => cutoffCompletedWeek(state, "2026", new Date(date));
  assert.equal(completed("2026-09-09T12:00:00Z"), 0);
  assert.equal(completed("2026-09-15T06:59:59Z"), 0);
  assert.equal(completed("2026-09-15T07:00:00Z"), 1);
  assert.equal(completed("2026-09-22T07:00:00Z"), 2);
  assert.equal(completed("2026-11-03T07:59:59Z"), 7);
  assert.equal(completed("2026-11-03T08:00:00Z"), 8);
  assert.equal(cutoffCompletedWeek(state, "2027", new Date("2027-09-20")), 0);
  assert.equal(cutoffCompletedWeek({ season: "2026" }, "2026", new Date()), 0);
});

test("earliest of Sleeper completion and calendar cutoff finalizes even zero scores", async () => {
  const fetchAt = (date, last = 0, partial = false) => fetchSleeperSeason({ leagueId: id, strict: true, now: new Date(date), fetchImpl: async (url) => {
    const response = await adapterFetch({ last, partial })(url);
    const data = await response.json();
    if (url.endsWith("/state/nfl")) data.season_start_date = "2026-09-09";
    return { ...response, json: async () => data };
  } });
  assert.equal((await fetchAt("2026-09-15T06:59:59Z")).completedWeeks.length, 0);
  const cutoff = await fetchAt("2026-09-15T07:00:00Z");
  assert.equal(cutoff.completedWeeks.length, 1);
  assert.equal(cutoff.currentWeekData.status, "final");
  assert.equal(cutoff.liveWeek, null);
  assert.equal((await fetchAt("2026-09-14T12:00:00Z", 1)).completedWeeks.length, 1);
  assert.equal((await fetchAt("2027-01-01T12:00:00Z")).completedWeeks.length, 14);
  await assert.rejects(fetchAt("2026-09-15T07:00:00Z", 0, true), /incomplete/);
});
function fixture() {
  return {
    metadata: { leagueId: id, name: "True League", season: "2026", teamCount: 2, startWeek: 1, regularSeasonEnd: 14, currentWeek: 2, lastCompletedWeek: 1, fetchedAt: "2026-09-09T12:00:00Z" },
    teams: [1, 2].map((rosterId) => ({ rosterId, teamName: `Team ${rosterId}`, managerName: `Manager ${rosterId}`, avatarUrl: null })),
    completedWeeks: [{ week: 1, status: "final", entries: [{ rosterId: 1, matchupId: 1, score: 100 }, { rosterId: 2, matchupId: 1, score: 90 }] }],
    liveWeek: null,
    currentWeekData: { week: 2, status: "awaiting_scoring", entries: [{ rosterId: 1, matchupId: 1, score: 0 }, { rosterId: 2, matchupId: 1, score: 0 }] },
    warnings: [],
  };
}
async function setup(t, fetchSeason = async () => fixture()) {
  const dir = await mkdtemp(join(tmpdir(), "sleeper-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SnapshotStore(dir, id, log);
  let clock = Date.parse("2026-09-09T12:00:00Z");
  const service = new DashboardService({ store, leagueId: id, fetchSeason, now: () => clock, log });
  await service.initialize();
  return { dir, store, service, advance: (ms) => { clock += ms; } };
}

test("scheduled, provisional, final, tied and unpaired matchup states", () => {
  const snapshot = fixture();
  assert.equal(currentMatchups(snapshot).status, "awaiting_scoring");
  assert.equal(currentMatchups(snapshot).matchups[0].leaderRosterId, null);
  snapshot.currentWeekData.status = "live";
  snapshot.currentWeekData.entries[0].score = 12.5;
  assert.equal(currentMatchups(snapshot).status, "provisional");
  assert.equal(currentMatchups(snapshot).matchups[0].margin, 12.5);
  snapshot.currentWeekData.status = "final";
  assert.equal(currentMatchups(snapshot).status, "final");
  snapshot.currentWeekData.entries[1].matchupId = null;
  assert.equal(currentMatchups(snapshot).matchups.length, 0);
  assert.equal(currentMatchups(snapshot).unpairedTeams.length, 2);
  snapshot.metadata.currentWeek = 15;
  assert.equal(currentMatchups(snapshot).status, "season_complete");
});

test("ESPN fantasy projections merge into current Sleeper matchups", async () => {
  const payload = {
    teams: [{ id: 1, owners: ["{26A72411-1823-4B1B-A724-1118237B1BD4}"] }, { id: 2, owners: ["{492B6C02-FE6E-462C-AB6C-02FE6E762CA9}+{7D0CEB2A-FD69-4B44-A332-D439AB4DECC1}"] }],
    schedule: [{
      home: { teamId: 1, totalProjectedPointsLive: 101.25, rosterForCurrentScoringPeriod: { entries: [{ playerPoolEntry: { player: { fullName: "Davante Adams", defaultPositionId: 4, proTeamId: 20, stats: [{ seasonId: 2026, scoringPeriodId: 2, statSourceId: 1, statSplitTypeId: 0, appliedTotal: 14.44 }] } } }] } },
      away: { teamId: 2, totalProjectedPointsLive: 88.1, rosterForCurrentScoringPeriod: { entries: [] } },
    }],
  };
  let calls = 0;
  const espn = new EspnFantasyProjections({ espnS2: "s2", swid: "swid", now: () => Date.parse("2026-09-20T12:00:00Z"), log, fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => payload };
  } });
  await espn.refresh("2026", 2);
  await espn.refresh("2026", 2);
  assert.equal(calls, 1);

  const snapshot = fixture();
  snapshot.metadata.startingSlots = ["WR"];
  snapshot.teams[0].canonicalOwnerIds = ["harrison"];
  snapshot.teams[1].canonicalOwnerIds = ["alex"];
  snapshot.currentWeekData.entries[0].starters = [{ playerId: "p1", points: 0 }];
  snapshot.currentWeekData.entries[1].starters = [{ playerId: "p2", points: 0 }];
  const matchups = currentMatchups(snapshot, { p1: { name: "Davante Adams", nflTeam: "NYJ" }, p2: { name: "Other Player", nflTeam: "BUF" } }, espn.dashboard("2026", 2));
  assert.equal(matchups.matchups[0].teams[0].projectedScore, 101.25);
  assert.equal(matchups.matchups[0].teams[0].starters[0].projectedPoints, 14.44);
  assert.equal(matchups.matchups[0].teams[1].projectedScore, 88.1);
});

test("store persists, deduplicates timestamps, archives corrections, recovers corrupted latest", async (t) => {
  const { store, dir } = await setup(t);
  const snapshot = fixture();
  await store.save(snapshot, "2026-09-09T12:00:00Z");
  snapshot.metadata.fetchedAt = "2026-09-09T12:01:00Z";
  await store.save(snapshot, "2026-09-09T12:01:00Z");
  const revisions = join(dir, id, "revisions");
  assert.equal((await readdir(revisions)).length, 1);
  snapshot.completedWeeks[0].entries[0].score = 101;
  await store.save(snapshot, "2026-09-09T12:02:00Z");
  assert.equal((await readdir(revisions)).length, 2);
  assert.equal((await new SnapshotStore(dir, id, log).load()).lastSuccessfulFetchAt, "2026-09-09T12:02:00Z");
  await writeFile(join(dir, id, "latest.json"), "broken");
  assert.equal((await new SnapshotStore(dir, id, log).load()).snapshot.completedWeeks[0].entries[0].score, 101);
  assert.ok((await readdir(join(dir, id))).every((name) => !name.endsWith(".tmp")));
});

test("validation rejects incomplete weeks, unexpected identities, duplicate teams and invalid scores", () => {
  for (const mutate of [
    (s) => s.completedWeeks.pop(),
    (s) => { s.completedWeeks[0].entries[0].rosterId = 99; },
    (s) => { s.teams[1].rosterId = 1; },
    (s) => { s.currentWeekData.entries[0].score = null; },
    (s) => { s.completedWeeks[0].entries[1].rosterId = 1; },
  ]) {
    const s = fixture(); mutate(s);
    assert.throws(() => validateSnapshot(s, id));
  }
});

test("refreshes deduplicate and cooldown applies after success and failure", async (t) => {
  let calls = 0;
  let fail = false;
  const { service, advance } = await setup(t, async () => { calls++; if (fail) throw new Error("offline"); return fixture(); });
  await Promise.all([service.refresh(), service.refresh(), service.refresh()]);
  assert.equal(calls, 1);
  await service.refresh(); assert.equal(calls, 1);
  advance(60000); fail = true;
  await service.refresh(); await service.refresh();
  assert.equal(calls, 2);
  assert.equal(service.dashboard().stale, true);
  assert.equal(service.dashboard().stats.teams[0].total, 100);
  advance(60000); fail = false; await service.refresh();
  assert.equal(service.dashboard().stale, false);
  advance(20 * 60000 + 1); assert.equal(service.dashboard().stale, true);
});

test("invalid refresh and disk write failure preserve saved data and timestamp", async (t) => {
  const { service, store, advance } = await setup(t);
  await service.refresh();
  const saved = service.saved;
  service.fetchSeason = async () => { const s = fixture(); s.completedWeeks = []; return s; };
  advance(60000); await service.refresh(); assert.equal(service.saved, saved);
  service.fetchSeason = async () => fixture();
  store.save = async () => { throw new Error("disk full"); };
  advance(60000); await service.refresh(); assert.equal(service.saved, saved);
});

test("HTTP serves isolated assets, freshness, initialization failures and durable fallback", async (t) => {
  const { service, advance, dir } = await setup(t, async () => { throw new Error("offline"); });
  const app = await createApp({ service, publicBaseUrl: "https://league.example" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/dashboard`)).status, 503);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const html = await (await fetch(base)).text();
  assert.match(html, /https:\/\/league.example\//);
  for (const path of ["/server/index.js", "/src/sleeper.js", "/src/config.js", "/tests/backend.test.js", "/package.json", "/.data/latest.json", "/render.yaml", "/build_true_league_dashboard.py"]) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(`${base}/src/ui.js`)).status, 200);
  service.fetchSeason = async () => fixture(); advance(60000);
  const fresh = await fetch(`${base}/api/refresh`, { method: "POST" });
  assert.equal(fresh.headers.get("cache-control"), "no-store");
  assert.equal((await fresh.json()).currentWeekMatchups.matchups.length, 1);
  service.fetchSeason = async () => { throw new Error("Sleeper outage"); }; advance(60000);
  const stale = await fetch(`${base}/api/refresh`, { method: "POST" });
  assert.equal(stale.status, 200); assert.equal((await stale.json()).stale, true);
  const restarted = new DashboardService({ store: new SnapshotStore(dir, id, log), leagueId: id, log });
  await restarted.initialize(); assert.equal(restarted.dashboard().stats.teams[0].total, 100);
  service.store.health = async () => { throw new Error("disk unavailable"); };
  assert.equal((await fetch(`${base}/healthz`)).status, 503);
});

function adapterFetch({ season = "2026", type = "regular", leg = 1, last = null, partial = false, override = null, score = 0 } = {}) {
  const routes = {
    [`/league/${id}`]: { league_id: id, name: "Test", season: "2026", total_rosters: 2, status: "in_season", settings: { leg, start_week: 1, playoff_week_start: 15, last_scored_leg: last } },
    [`/league/${id}/users`]: [],
    [`/league/${id}/rosters`]: [{ roster_id: 1 }, { roster_id: 2 }],
    "/state/nfl": { season, season_type: type, leg },
  };
  return async (url) => {
    const path = url.replace("https://api.sleeper.app/v1", "");
    const body = routes[path] || (path.includes("/matchups/") ? [{ roster_id: 1, matchup_id: 1, points: score, custom_points: override }, ...partial ? [] : [{ roster_id: 2, matchup_id: 1, points: 0 }]] : null);
    return { ok: Boolean(body), status: body ? 200 : 404, json: async () => body };
  };
}
test("adapter preserves zero schedules and custom zero, rejects partial refreshes", async () => {
  const fetchSeason = (options) => fetchSleeperSeason({ leagueId: id, strict: true, fetchImpl: adapterFetch(options) });
  const waiting = await fetchSeason({});
  assert.equal(waiting.currentWeekData.status, "awaiting_scoring");
  assert.equal(waiting.completedWeeks.length, 0);
  assert.equal(waiting.liveWeek, null);
  const live = await fetchSeason({ score: 40, override: 0 });
  assert.equal(live.currentWeekData.entries[0].score, 0);
  assert.equal(live.currentWeekData.status, "live");
  await assert.rejects(fetchSeason({ partial: true }), /incomplete/);
  const final = await fetchSeason({ last: 1 });
  assert.equal(final.currentWeekData.status, "final");
  assert.equal(final.completedWeeks.length, 1);
});
test("adapter distinguishes preseason, explicit zero completion, and postseason", async () => {
  for (const options of [{ type: "post", leg: 18 }, { season: "2027", type: "pre", leg: 1 }, { leg: 15 }]) {
    const s = await fetchSleeperSeason({ leagueId: id, strict: true, fetchImpl: adapterFetch(options) });
    assert.ok(s.metadata.currentWeek > 14);
    assert.equal(s.completedWeeks.length, 14);
    assert.equal(s.liveWeek, null);
    assert.equal(currentMatchups(s).status, "season_complete");
  }
  const pre = await fetchSleeperSeason({ leagueId: id, strict: true, fetchImpl: adapterFetch({ season: "2025", type: "post", leg: 18 }) });
  assert.equal(pre.completedWeeks.length, 0);
  assert.equal(pre.metadata.currentWeek, 1);
  const explicit = await fetchSleeperSeason({ leagueId: id, strict: true, fetchImpl: adapterFetch({ leg: 2, last: 0 }) });
  assert.equal(explicit.completedWeeks.length, 0);
});

test("browser entrypoint only fetches local APIs", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /api\.sleeper|localStorage/);
  assert.match(source, /\/api\/refresh/);
});

test("starter normalization excludes bench and preserves order, zero and negative points", async () => {
  const base = adapterFetch();
  const snapshot = await fetchSleeperSeason({ leagueId: id, strict: true, fetchImpl: async (url) => {
    const response = await base(url);
    const data = await response.json();
    if (url.endsWith(`/league/${id}`)) data.roster_positions = ["QB", "FLEX", "DEF", "K", "BN"];
    if (url.includes("/matchups/")) data.forEach((entry) => {
      entry.starters = ["p1", "p2", "PIT", "0"];
      entry.starters_points = [0, -2, 9, 0];
      entry.players = ["p1", "p2", "PIT", "bench"];
      entry.players_points = { p1: 5, p2: 4, PIT: 8, bench: 100 };
    });
    return { ...response, json: async () => data };
  }});
  const result = currentMatchups(snapshot, { p1: { name: "Starter One", position: "QB", nflTeam: "BUF" }, PIT: { name: "Pittsburgh Steelers", position: "DEF", nflTeam: "PIT" } });
  const starters = result.matchups[0].teams[0].starters;
  assert.deepEqual(starters.map((s) => s.playerId), ["p1", "p2", "PIT", null]);
  assert.deepEqual(starters.map((s) => s.points), [0, -2, 9, 0]);
  assert.deepEqual(starters.map((s) => s.slot), ["QB", "FLEX", "DEF", "K"]);
  assert.equal(starters[1].name, "Player p2");
  assert.equal(starters[2].name, "Pittsburgh Steelers");
  assert.equal(starters[3].name, "Empty slot");
  assert.equal(result.matchups[0].teams[0].score, 0);
});

test("missing or misaligned starter scores use ID lookup, not a shifted lineup", async () => {
  const base = adapterFetch();
  const snapshot = await fetchSleeperSeason({ leagueId: id, strict: true, fetchImpl: async (url) => {
    const response = await base(url);
    const data = await response.json();
    if (url.includes("/matchups/")) data.forEach((entry) => {
      entry.starters = ["a", "b", "c"];
      entry.starters_points = [99];
      entry.players_points = { a: 0, b: -1 };
    });
    return { ...response, json: async () => data };
  }});
  assert.deepEqual(snapshot.currentWeekData.entries[0].starters.map((s) => s.points), [0, -1, null]);
  assert.equal(currentMatchups(fixture()).matchups[0].teams[0].starters, null);
});

test("player directory caches daily, survives restart and retains names on upstream failure", async (t) => {
  const { dir } = await setup(t);
  let calls = 0;
  let now = Date.now();
  let fail = false;
  const fetchImpl = async () => {
    calls++;
    return { ok: !fail, status: fail ? 404 : 200, json: async () => ({ p1: { full_name: "Starter", position: "QB", team: "BUF" }, PIT: { first_name: "Pittsburgh", last_name: "Steelers", position: "DEF" } }) };
  };
  const directory = new PlayerDirectory(dir, { fetchImpl, now: () => now, log });
  await directory.initialize();
  await Promise.all([directory.refresh(), directory.refresh()]);
  assert.equal(calls, 1);
  assert.equal(directory.players.PIT.name, "Pittsburgh Steelers");
  const restored = new PlayerDirectory(dir, { fetchImpl, now: () => now, log });
  await restored.initialize(); await restored.refresh();
  assert.equal(calls, 1);
  now += 24 * 3600000; fail = true;
  await restored.refresh();
  assert.equal(calls, 2);
  assert.equal(restored.players.p1.name, "Starter");
});
