import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { History, validateArchive } from "../server/history.js";
import { leagueRecords, headToHead, eligibleSeasons, ownerMatchups } from "../server/records.js";
import { createApp } from "../server/app.js";
import { owners } from "../server/identities.js";

const history = await History.load();

function season(year, teamCount, scores, source = "espn") {
  return { snapshot: { metadata: { season: String(year), teamCount, source, startWeek: 1, regularSeasonEnd: 14 },
    teams: ["gaurav", "jake"].map((id, index) => ({ rosterId: index + 1, canonicalOwnerIds: [id], ownerIds: [owners.find((owner) => owner.id === id).sleeperId], teamName: `${id} ${year}`, managerName: owners.find((owner) => owner.id === id).name })),
    completedWeeks: scores.map(([a, b], index) => ({ week: index + 1, status: "final", entries: [{ rosterId: 1, matchupId: index + 1, score: a }, { rosterId: 2, matchupId: index + 1, score: b }] })), liveWeek: { week: 5, entries: [{ rosterId: 1, matchupId: 1, score: 9999 }, { rosterId: 2, matchupId: 1, score: 9998 }] },
  }, recap: { postseason: { matchups: [{ matchupRef: `${year}:15:1`, week: 15, homeRosterId: 1, awayRosterId: 2, homeScore: 999, awayScore: 200, winner: "HOME", margin: 799, tier: "WINNERS_BRACKET", scorePrecision: "source-html" }] } } };
}

test("records filter actual team counts, provisional/postseason scores and preserve precision", () => {
  const archive = { seasons: [season(2020, 10, [[110.1234, 110.12], [100, 101]]), season(2025, 12, [[2000, 1000]])] };
  const current = season(2026, 10, [[130, 120]], "sleeper").snapshot;
  current.completedWeeks.push({ ...current.liveWeek, status: "live" }, { ...current.liveWeek, week: 15, status: "final" });
  const value = leagueRecords(archive, current);
  assert.equal(value.era, "ten-team");
  assert.deepEqual(value.qualifyingSeasons.map((row) => row.season), ["2026", "2020"]);
  assert.equal(value.records.highestScore[0].value, 130);
  assert.equal(value.records.highestLosingScore[0].value, 120);
  assert.equal(value.records.lowestWinningScore[0].value, 101);
  assert.equal(value.records.closestMatchup[0].value, 110.1234 - 110.12);
  assert.equal(value.records.closestMatchup[0].home.ownerName, "Gaurav Gandhi");
  assert.equal(value.records.closestMatchup[0].away.ownerName, "Jake Herman");
  assert.equal(value.records.closestMatchup.length, 3);
  assert.equal(value.records.mostSeasonPoints[0].value, 211.12);
  assert.equal(value.records.mostSeasonPoints.find((row) => row.season === "2026").ongoing, true);
  assert.equal(leagueRecords(archive, current, { era: "all" }).records.highestScore[0].value, 2000);
  assert.throws(() => eligibleSeasons(archive, null, "invalid"), /Era/);
});

test("record ranks retain cutoff ties and win streaks span seasons but reset on ties", () => {
  const archive = { seasons: [season(2024, 10, [[110, 100], [110, 100], [110, 100]]), season(2025, 10, [[110, 100], [100, 100], [110, 100]])] };
  const result = leagueRecords(archive, null);
  assert.equal(result.records.lowestScore.length, 7);
  assert.ok(result.records.lowestScore.every((row) => row.rank === 1));
  assert.equal(result.records.longestWinStreak[0].value, 4);
  assert.equal(result.records.longestWinStreak[0].startSeason, "2024");
  assert.equal(result.records.longestWinStreak[0].season, "2025");
  assert.equal(result.records.closestMatchup[0].value, 0);
  const tiedSeason = result.records.bestWinPercentage.find((row) => row.ownerId === "gaurav" && row.season === "2025");
  assert.equal(tiedSeason.value, 2.5 / 3);
  assert.equal(result.records.bestMedianWinPercentage.find((row) => row.ownerId === "gaurav" && row.season === "2025").value, 2.5 / 3);
});

test("rivalry totals are owner-relative, include archived playoffs, exclude current provisional games", () => {
  const archive = { seasons: [season(2025, 10, [[100, 90], [80, 120], [110, 110]])] };
  const current = season(2026, 10, [[100, 100]], "sleeper").snapshot;
  current.completedWeeks.push({ ...current.liveWeek, status: "live" }, { ...current.liveWeek, week: 15, status: "final" });
  const result = headToHead(archive, current, { ownerA: "gaurav", ownerB: "jake" });
  assert.equal(result.summary.games, 5);
  assert.deepEqual([result.summary.wins, result.summary.losses, result.summary.ties], [2, 1, 2]);
  assert.equal(result.summary.playoffMeetings, 1);
  assert.equal(result.summary.pointsFor, 1389);
  assert.equal(result.summary.pointsAgainst, 620);
  assert.equal(result.summary.averagePointsFor, 1389 / 5);
  assert.equal(result.summary.pointDifferential, 769);
  assert.equal(result.summary.biggestWinA.margin, 799);
  assert.equal(result.summary.biggestWinB.margin, 40);
  assert.equal(result.summary.closestGame.margin, 0);
  assert.equal(result.summary.currentStreak.count, 0);
  assert.equal(result.matchups[0].season, "2026");
  const swapped = headToHead(archive, current, { ownerA: "jake", ownerB: "gaurav" });
  assert.equal(swapped.summary.pointsFor, result.summary.pointsAgainst);
  assert.equal(swapped.summary.wins, result.summary.losses);
  assert.ok(swapped.matchups.every((row) => row.margin >= 0));
  const missing = headToHead(archive, null, { ownerA: "gaurav" });
  assert.equal(missing.summary, null);
  assert.equal(missing.ownerA.id, "gaurav");
  assert.equal(missing.ownerB, null);
  assert.equal(headToHead(archive, null, { ownerA: "gaurav", ownerB: "kyle" }).summary.games, 0);
  current.completedWeeks.push({ week: 2, status: "final", entries: [{ rosterId: 1, matchupId: 1, score: 80 }, { rosterId: 2, matchupId: 1, score: 90 }] });
  assert.deepEqual(headToHead(archive, current, { ownerA: "gaurav", ownerB: "jake" }).summary.currentStreak, { ownerId: "jake", count: 1 });
});

test("rivalry stage filter recomputes totals and streaks from only the selected games", () => {
  const archive = { seasons: [season(2025, 10, [[100, 90], [80, 120]])] };
  const options = { ownerA: "gaurav", ownerB: "jake" };
  const all = headToHead(archive, null, options);
  const regular = headToHead(archive, null, { ...options, stage: "regular" });
  const playoff = headToHead(archive, null, { ...options, stage: "playoff" });
  assert.equal(all.stage, "all");
  assert.equal(regular.summary.games, 2);
  assert.equal(regular.summary.pointsFor, 180);
  assert.equal(regular.summary.playoffMeetings, 0);
  assert.equal(regular.summary.currentStreak.ownerId, "jake");
  assert.equal(playoff.summary.games, 1);
  assert.equal(playoff.summary.pointsFor, 999);
  assert.equal(playoff.summary.averagePointsAgainst, 200);
  assert.equal(playoff.summary.currentStreak.ownerId, "gaurav");
  assert.ok(regular.matchups.every((game) => game.stage === "regular"));
  assert.ok(playoff.matchups.every((game) => game.stage === "playoff"));
  assert.equal(all.summary.pointsFor, regular.summary.pointsFor + playoff.summary.pointsFor);
  assert.throws(() => headToHead(archive, null, { ...options, stage: "bad" }), /Stage/);
});

test("former shared Ethan identity remains separate in rivalry and records", () => {
  const former = headToHead(history.archive, null, { era: "all", ownerA: "pyo-ethan-former", ownerB: "ethan" });
  assert.ok(former.summary.games > 0);
  assert.ok(former.matchups.every((game) => Number(game.season) <= 2020 && game.ownerA.ownerIds.includes("pyo-ethan-former") && game.ownerB.ownerIds.includes("ethan")));
  assert.equal(headToHead(history.archive, null, { ownerA: "pyo-ethan-former", ownerB: "ethan" }).summary.games, 0);
});

test("scored playoff archive preserves source outcomes, precision and 2022 correction", async () => {
  const source = JSON.parse((await readFile(new URL("../../index.html", import.meta.url), "utf8").catch(() => "")).match(/\bconst DATA = (\{[^\n]+\});/)?.[1] || "null");
  const games = ownerMatchups(eligibleSeasons(history.archive, null, "all"), { playoffs: true }).filter((game) => game.stage === "playoff");
  assert.equal(games.length, 40);
  if (source) {
    const expected = source.matchups.filter((game) => game.stage === "playoff" && game.bracket_type === "playoff" && game.completed && game.home && game.away);
    assert.equal(games.length, expected.length);
    for (const game of games) {
      const raw = expected.find((row) => row.matchup_ref === game.id);
      assert.equal(game.home.score, raw.home.score);
      assert.equal(game.away.score, raw.away.score);
      assert.equal(game.winner, raw.winner);
    }
  }
  const final = games.find((game) => game.id === "2022:17:98");
  assert.equal(final.away.ownerIds[0], "gaurav");
  assert.equal(final.winner, "AWAY");
  assert.equal(final.corrections.length, 1);
  assert.equal(history.dashboard("2022").recap.standings.find((row) => row.isChampion).managerName, "Gaurav Gandhi");
  for (const mutate of [
    (games) => { games[0].homeScore = null; },
    (games) => { games[0].homeOwnerId = "jake-invalid"; },
    (games) => { games[0].margin = -1; },
    (games) => { games.push(games[0]); },
  ]) { const copy = structuredClone(history.archive); mutate(copy.seasons[0].recap.postseason.matchups); assert.throws(() => validateArchive(copy), /postseason/); }
});

test("records and rivalry HTTP endpoints validate queries and work through a Sleeper outage", async (t) => {
  let calls = 0;
  const service = { saved: null, dashboard: () => null, refresh: async () => { calls++; } };
  const app = await createApp({ service, history });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = (url) => fetch(`http://127.0.0.1:${server.address().port}${url}`);
  for (const path of ["/api/records", "/api/head-to-head"]) {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json();
    assert.equal(payload.era, "ten-team");
    assert.equal(payload.currentDataAvailable, false);
    assert.equal(payload.stale, true);
    assert.equal(payload.qualifyingSeasons.length, 3);
    assert.equal((await get(`${path}?era=bad`)).status, 400);
    assert.equal((await get(`${path}?era=all&era=ten-team`)).status, 400);
  }
  for (const query of ["ownerA=gaurav&ownerB=gaurav", "ownerA=unknown", "ownerA=gaurav&ownerA=jake", "ownerB=unknown"]) assert.equal((await get(`/api/head-to-head?${query}`)).status, 400);
  const matchup = await (await get("/api/head-to-head?era=all&ownerA=gaurav&ownerB=alex")).json();
  assert.ok(matchup.matchups.some((game) => game.id === "2022:17:98"));
  const playoffs = await (await get("/api/head-to-head?era=all&ownerA=gaurav&ownerB=alex&stage=playoff")).json();
  assert.equal(playoffs.stage, "playoff");
  assert.ok(playoffs.matchups.length > 0 && playoffs.matchups.every((game) => game.stage === "playoff"));
  assert.equal((await get("/api/head-to-head?stage=bad")).status, 400);
  assert.equal((await get("/api/head-to-head?stage=regular&stage=playoff")).status, 400);
  const empty = await (await get("/api/head-to-head")).json();
  assert.equal(empty.summary, null);
  assert.ok(empty.owners.some((owner) => owner.id === "pyo-ethan-former"));
  assert.equal(calls, 0);
  service.saved = { snapshot: season(2026, 10, [[100, 90]], "sleeper").snapshot };
  service.dashboard = () => ({ stale: false });
  const live = await (await get("/api/head-to-head?ownerA=gaurav&ownerB=jake")).json();
  assert.equal(live.currentDataAvailable, true);
  assert.equal(live.stale, false);
  assert.equal(live.matchups[0].season, "2026");
});
