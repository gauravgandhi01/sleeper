import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { NflScoreboard, normalizeScoreboard } from "../server/nfl.js";
import { LiveActivity, starterCounts, shouldRefreshLive } from "../src/live-state.js";

function scoreboard(name = "STATUS_IN_PROGRESS", state = "in", completed = false) {
  return { season: { year: 2026, type: 2 }, week: { number: 2 }, events: [{ id: "1", season: { year: 2026, type: 2 }, week: { number: 2 }, date: "2026-09-20T17:00:00Z", status: { type: { name, state, completed, shortDetail: name } }, competitions: [{ competitors: [{ team: { abbreviation: "JAC" }, homeAway: "home" }, { team: { abbreviation: "WSH" }, homeAway: "away" }] }] }] };
}
test("NFL adapter validates weeks, normalizes teams, and distinguishes game states", () => {
  for (const [name, state, completed, expected] of [["STATUS_SCHEDULED", "pre", false, "scheduled"], ["STATUS_IN_PROGRESS", "in", false, "live"], ["STATUS_HALFTIME", "in", false, "live"], ["STATUS_END_PERIOD", "in", false, "live"], ["STATUS_OVERTIME", "in", false, "live"], ["STATUS_FINAL", "post", true, "final"], ["STATUS_POSTPONED", "pre", false, "postponed"], ["STATUS_CANCELED", "post", false, "canceled"], ["UNRECOGNIZED", "other", false, "unknown"]]) {
    const games = normalizeScoreboard(scoreboard(name, state, completed), "2026", 2);
    assert.equal(games.JAX.state, expected);
    assert.equal(games.JAX.opponent, "WAS");
    assert.equal(games.WAS.home, false);
  }
  assert.throws(() => normalizeScoreboard(scoreboard(), "2025", 2), /mismatch/);
  const wrong = scoreboard(); wrong.events[0].week.number = 1;
  assert.throws(() => normalizeScoreboard(wrong, "2026", 2), /mismatch/);
  assert.throws(() => normalizeScoreboard({ ...scoreboard(), events: [] }, "2026", 2), /empty/);
});

test("NFL cache deduplicates, cools down, retains last good data and isolates weeks", async () => {
  let now = 1000000; let calls = 0; let fail = false;
  const adapter = new NflScoreboard({ now: () => now, log: { warn() {} }, fetchImpl: async () => { calls++; if (fail) throw Error("offline"); return { ok: true, json: async () => scoreboard() }; } });
  await Promise.all([adapter.refresh("2026", 2), adapter.refresh("2026", 2)]);
  await adapter.refresh("2026", 2); assert.equal(calls, 1);
  const stamp = adapter.dashboard("2026", 2).fetchedAt;
  fail = true; now += 60000; await adapter.refresh("2026", 2);
  assert.equal(adapter.dashboard("2026", 2).fetchedAt, stamp);
  assert.equal(adapter.dashboard("2026", 2).stale, false);
  now += 120000;
  assert.equal(adapter.dashboard("2026", 2).stale, true);
  assert.equal(adapter.dashboard("2026", 3).unavailable, true);
  assert.ok(adapter.dashboard("2026", 2).games.JAX);
});

test("starter counts exclude empty slots and do not equate zero scores with completion", () => {
  const now = Date.now();
  const nfl = { fetchedAt: new Date(now).toISOString(), games: { JAX: { state: "live" }, WAS: { state: "scheduled" }, NYJ: { state: "final" }, PIT: { state: "postponed" } } };
  const team = { starters: [{ playerId: "1", nflTeam: "JAC", points: 0 }, { playerId: "2", nflTeam: "WAS", points: 0 }, { playerId: null, nflTeam: "JAX" }, { playerId: "3", nflTeam: "NYJ" }, { playerId: "PIT", nflTeam: "PIT" }, { playerId: "unknown" }] };
  assert.deepEqual(starterCounts(team, nfl, now), { final: 1, live: 1, scheduled: 1, unknown: 2 });
  assert.equal(starterCounts(team, nfl, now + 180000), null);
  assert.equal(starterCounts({}, nfl, now), null);
});

function current(a = 10, b = 9, week = 2) {
  return { week, status: "provisional", unpairedTeams: [], matchups: [{ matchupId: 1, margin: Math.abs(a - b), leaderRosterId: a === b ? null : a > b ? 1 : 2, teams: [{ rosterId: 1, managerName: "Avery Owner", teamName: "Alpha", score: a, projectedScore: 18, starters: [{ playerId: "1", slot: "QB", name: "Starter One", nflTeam: "JAX", points: a, projectedPoints: 12, statLine: "12/18, 145 pass yd, 1 TD" }] }, { rosterId: 2, managerName: "Blake Owner", teamName: "Beta", score: b, projectedScore: 16, starters: [{ playerId: "2", slot: "QB", name: "Starter Two", nflTeam: "WAS", points: b, projectedPoints: 10, statLine: "14 rush yd" }] }] }] };
}
test("activity groups score changes, handles ties/decreases, rejects late snapshots and caps the feed", () => {
  const feed = new LiveActivity();
  const stamp = (n) => new Date(1000000 + n * 60000).toISOString();
  feed.observe("2026", current(), stamp(0)); assert.equal(feed.entries.size, 0);
  feed.observe("2026", current(8, 11), stamp(1));
  assert.equal(feed.entries.get(1)[0].changes.length, 2);
  assert.equal(feed.entries.get(1)[0].changes[0].delta, -2);
  assert.equal(feed.entries.get(1)[0].leader, "Beta");
  feed.observe("2026", current(8, 11), stamp(2)); assert.equal(feed.entries.get(1).length, 1);
  feed.observe("2026", current(100, 11), stamp(1)); assert.equal(feed.entries.get(1).length, 1);
  feed.observe("2026", current(11, 11), stamp(3)); assert.equal(feed.entries.get(1)[0].leader, null);
  for (let i = 4; i < 40; i++) feed.observe("2026", current(i, 11), stamp(i));
  assert.equal(feed.entries.get(1).length, 30);
  feed.observe("2026", current(0, 0, 3), stamp(40)); assert.equal(feed.entries.size, 0);
  feed.observe("2027", current(1, 1, 3), stamp(41)); assert.equal(feed.entries.size, 0);
});

test("auto refresh only runs when visible, online, current, due and unfinished", () => {
  const ready = { auto: true, visible: true, online: true, active: true, currentSeason: true, status: "provisional", pending: false, lastAttempt: 0, now: 60000 };
  assert.equal(shouldRefreshLive(ready), true);
  for (const key of ["auto", "visible", "online", "active", "currentSeason"]) assert.equal(shouldRefreshLive({ ...ready, [key]: false }), false);
  assert.equal(shouldRefreshLive({ ...ready, pending: true }), false);
  assert.equal(shouldRefreshLive({ ...ready, now: 59999 }), false);
  for (const status of ["final", "season_complete"]) assert.equal(shouldRefreshLive({ ...ready, status }), false);
});

test("live UI preserves focus, stable order, routes, and paired starters", async (t) => {
  const dom = new JSDOM('<div id="liveWeekRegion"></div>', { url: "http://localhost/?tab=live" });
  for (const key of ["window", "document"]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  t.after(() => dom.window.close());
  const { renderLiveScores, updateLiveRoute } = await import(`../src/live.js?test=${Date.now()}`);
  const doc = dom.window.document;
  const stats = { metadata: { season: "2026" } };
  const data = current();
  data.matchups[0].teams.forEach((team) => { team.record = { wins: 0, losses: 0, ties: 0 }; });
  const second = structuredClone(data.matchups[0]); second.matchupId = 2; second.margin = 0;
  data.matchups.push(second);
  const context = { currentWeekMatchups: data, cachedAt: new Date().toISOString(), nflStatus: { fetchedAt: new Date().toISOString(), games: normalizeScoreboard(scoreboard(), "2026", 2) } };
  context.nflStatus.games.NYJ = { state: "final", opponent: "MIA", home: true };
  const avatar = () => doc.createElement("span");
  renderLiveScores(stats, context, avatar, () => {});
  assert.match(doc.querySelector(".live-projected-value").textContent, /18.00/);
  assert.equal(doc.querySelector(".live-team-owner")?.textContent, "Avery");
  assert.equal(doc.querySelector(".live-team-record")?.textContent, "(0-0)");
  assert.equal(doc.querySelector(".live-state")?.textContent, "Live");
  assert.match(doc.querySelector(".live-card-footer").textContent, /Avery leads by 1.00/);
  assert.doesNotMatch(doc.querySelector(".live-card-footer").textContent, /Alpha leads/);
  assert.equal(doc.getElementById("liveSort"), null);
  assert.equal(doc.querySelector(".live-matchup-card").id, "matchup-1");
  doc.getElementById("matchup-1").focus();
  data.matchups[0].margin = 0; data.matchups[1].margin = 20;
  renderLiveScores(stats, context, avatar, () => {});
  assert.equal(doc.activeElement.id, "matchup-1");
  assert.equal(doc.querySelector(".live-matchup-card").id, "matchup-1");
  doc.getElementById("matchup-1").click();
  assert.equal(new URL(dom.window.location.href).searchParams.get("matchup"), "1");
  assert.equal(doc.querySelector(".live-detail-nav .export-button")?.title, "Export matchup");
  assert.ok(doc.getElementById("liveMatchupExport"));
  assert.match(doc.querySelector(".live-player-projected").textContent, /12.00/);
  const playerLogo = doc.querySelector(".live-starter .live-player-name .live-nfl-logo");
  const opponentLogo = doc.querySelector(".live-starter .live-player-status .live-nfl-logo");
  assert.match(playerLogo?.getAttribute("src"), /\/jax\.png$/);
  assert.equal(playerLogo?.getAttribute("alt"), "JAX logo");
  assert.match(opponentLogo?.getAttribute("src"), /\/wsh\.png$/);
  assert.equal(opponentLogo?.getAttribute("alt"), "WAS logo");
  data.matchups[0].teams[0].starters[0].nflTeam = "NYJ";
  renderLiveScores(stats, context, avatar, () => {});
  assert.equal(doc.querySelector(".live-starter[data-game-state='final'] .live-player-projected"), null);
  assert.equal(doc.querySelector(".live-starter[data-game-state='final'] .live-lock")?.getAttribute("aria-label"), "Player score locked");
  assert.equal(doc.querySelector(".live-starter[data-game-state='final'] .live-player-statline")?.textContent, "12/18, 145 pass yd, 1 TD");
  assert.equal(doc.querySelector(".live-starter[data-game-state='scheduled'] .live-player-statline"), null);
  assert.equal(doc.querySelectorAll(".live-starter-row:not(.live-roster-labels)").length, 1);
  assert.equal(doc.querySelector(".live-matchup-picker-button.is-selected")?.id, "liveMatchupPick-1");
  doc.getElementById("liveMatchupPick-2").click();
  assert.equal(new URL(dom.window.location.href).searchParams.get("matchup"), "2");
  doc.getElementById("liveMatchupPick-1").click();
  const newer = { ...context, currentWeekMatchups: current(8, 11), cachedAt: new Date(Date.now() + 60000).toISOString() };
  renderLiveScores(stats, newer, avatar, () => {});
  assert.equal(doc.querySelector(".live-activity"), null);
  doc.getElementById("liveBack").click();
  assert.equal(doc.querySelectorAll(".live-matchup-card").length, 1);
  data.matchups[0].margin = 1;
  data.matchups[0].teams[1].starters[0].nflTeam = "NYJ";
  renderLiveScores(stats, context, avatar, () => {});
  assert.equal(doc.querySelector(".live-team-status .live-lock"), null);
  assert.ok([...doc.querySelectorAll(".live-score-line .live-lock")].some((icon) => icon.getAttribute("aria-label") === "Team score locked"));
  assert.match(doc.querySelector(".live-card-footer").textContent, /Avery beat Blake by 1.00/);
  assert.ok(doc.querySelector(".live-matchup-card.is-complete"));
  assert.equal(doc.querySelector(".live-team.is-winner .live-score-value")?.textContent, "10.00");
  dom.window.history.replaceState(null, "", "?tab=live&matchup=1&week=2"); updateLiveRoute();
  assert.ok(doc.getElementById("matchupDetailTitle"));
  dom.window.history.replaceState(null, "", "?tab=live&matchup=99&week=1"); updateLiveRoute();
  assert.equal(new URL(dom.window.location.href).searchParams.has("matchup"), false);
});
