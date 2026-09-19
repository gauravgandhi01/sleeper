import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { History, validateArchive, seasonRecords } from "../server/history.js";
import { owners, linkCurrentOwners } from "../server/identities.js";
import { importHistory } from "../scripts/import-history.mjs";
import { applyPrecision, normalizeEspnScores } from "../scripts/espn-precision.mjs";
import { createApp } from "../server/app.js";

const archive = JSON.parse(await readFile(new URL("../data/history.json", import.meta.url)));
const history = new History(archive);
const precise = JSON.parse(await readFile(new URL("../data/espn-scores.json", import.meta.url)));

test("all eight archive seasons reconcile, with correct team counts and week lengths", () => {
  assert.equal(validateArchive(archive), archive);
  assert.equal(archive.seasons.reduce((sum, { snapshot }) => sum + snapshot.completedWeeks.reduce((n, week) => n + week.entries.length, 0), 0), 1224);
  for (const { snapshot, recap } of archive.seasons) {
    const year = +snapshot.metadata.season;
    const stats = history.dashboard(year).stats;
    assert.equal(stats.teams.length, year <= 2022 ? 12 : 10);
    assert.equal(stats.weeks.length, year <= 2020 ? 13 : 14);
    for (const team of stats.teams) {
      const raw = snapshot.completedWeeks.map((week) => week.entries.find((entry) => entry.rosterId === team.rosterId).score);
      assert.equal(team.total, raw.reduce((a, b) => a + b, 0));
      assert.equal(team.average, team.total / raw.length);
    }
    assert.equal(recap.standings.filter((row) => row.isChampion).length, 1);
  }
  const corrected = history.dashboard("2022").recap.standings.find((row) => row.isChampion);
  assert.equal(corrected.managerName, "Gaurav Gandhi");
  assert.notEqual(corrected.finalRank, 1);
  assert.match(corrected.championNote, /correction/i);
});

test("archive rejects missing/duplicate entries, invalid opponents, unknown owners and mismatched totals", () => {
  for (const mutate of [
    (s) => s.snapshot.completedWeeks.pop(),
    (s) => s.snapshot.completedWeeks[0].entries.pop(),
    (s) => { s.snapshot.completedWeeks[0].entries[0].rosterId = s.snapshot.completedWeeks[0].entries[1].rosterId; },
    (s) => { s.snapshot.completedWeeks[0].entries[0].matchupId = null; },
    (s) => { s.snapshot.completedWeeks[0].entries[0].score = NaN; },
    (s) => { s.snapshot.teams[0].canonicalOwnerIds = ["unknown"]; },
    (s) => { s.recap.standings[0].pointsFor += 2; },
  ]) {
    const copy = structuredClone(archive); mutate(copy.seasons[0]);
    assert.throws(() => validateArchive(copy));
  }
});

test("original precision resolves the 2020 rounded tie and true ties still count", () => {
  const snapshot = archive.seasons.find((item) => item.snapshot.metadata.season === "2020").snapshot;
  const records = seasonRecords(snapshot);
  assert.deepEqual([records.find((row) => row.rosterId === 2).wins, records.find((row) => row.rosterId === 2).ties], [7, 0]);
  const week = snapshot.completedWeeks.find((week) => week.entries.some((entry) => week.entries.some((opponent) => opponent.rosterId !== entry.rosterId && opponent.matchupId === entry.matchupId && opponent.score !== entry.score && opponent.score.toFixed(1) === entry.score.toFixed(1))));
  assert.ok(week);
  const tied = structuredClone(snapshot);
  tied.completedWeeks = [{ week: 1, entries: [{ rosterId: 2, matchupId: 1, score: 100, result: "ties" }, { rosterId: 6, matchupId: 1, score: 100, result: "ties" }] }];
  assert.equal(seasonRecords(tied).find((row) => row.rosterId === 2).ties, 1);
});

test("ten explicit Sleeper links and separate former Ethan identity", () => {
  const active = owners.filter((owner) => owner.sleeperId);
  assert.equal(active.length, 10);
  const snapshot = linkCurrentOwners({ teams: active.map((owner, index) => ({ rosterId: index + 1, ownerIds: [owner.sleeperId], teamName: "Different team name", managerName: "Renamed user" })) });
  assert.deepEqual(snapshot.teams.map((team) => team.canonicalOwnerIds[0]), active.map((owner) => owner.id));
  const careers = history.careers(null, { currentSeason: "2026" });
  assert.equal(careers.owners.find((owner) => owner.id === "ethan").seasonsPlayed, 8);
  const former = careers.owners.find((owner) => owner.id === "pyo-ethan-former");
  assert.equal(former.current, false);
  assert.deepEqual(former.seasons.map((row) => row.season), ["2020", "2019", "2018"]);
});

test("career metrics weight all finalized games and exclude live scores", () => {
  const owner = owners.find((owner) => owner.id === "gaurav");
  const snapshot = linkCurrentOwners({ metadata: { season: "2026" }, teams: [{ rosterId: 1, ownerIds: [owner.sleeperId], teamName: "Current" }, { rosterId: 2, ownerIds: [owners[0].sleeperId], teamName: "Opponent" }], completedWeeks: [{ entries: [{ rosterId: 1, matchupId: 1, score: 120 }, { rosterId: 2, matchupId: 1, score: 120 }] }], liveWeek: { entries: [{ rosterId: 1, score: 999 }] } });
  const before = history.careers(null).owners.find((row) => row.id === owner.id);
  const after = history.careers(snapshot).owners.find((row) => row.id === owner.id);
  assert.equal(after.pointsFor, before.pointsFor + 120);
  assert.equal(after.games, before.games + 1);
  assert.equal(after.ties, before.ties + 1);
  assert.equal(after.pointsPerGame, after.pointsFor / after.games);
  assert.equal(after.winPct, (after.wins + after.ties / 2) / (after.wins + after.losses + after.ties));
  assert.equal(after.championships, before.championships);
  assert.equal(after.seasons[0].ongoing, true);
});

test("archive and careers remain available on cold Sleeper failure; assets stay private", async (t) => {
  let calls = 0;
  const service = { saved: null, dashboard: () => null, refresh: async () => { calls++; }, store: { health: async () => {} } };
  const app = await createApp({ service, history });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path) => fetch(base + path);
  const seasons = await (await get("/api/seasons")).json();
  assert.equal(seasons.seasons.length, 9);
  assert.equal(seasons.seasons[0].season, "2026");
  const past = await get("/api/dashboard?season=2018");
  assert.equal(past.status, 200);
  assert.equal(past.headers.get("cache-control"), "no-store");
  const payload = await past.json();
  assert.equal(payload.source, "espn");
  assert.equal(payload.stale, false);
  assert.equal(payload.currentWeekMatchups, null);
  assert.equal(calls, 0);
  const careers = await (await get("/api/owners")).json();
  assert.equal(careers.era, "all");
  assert.equal((await get("/api/owners?era=invalid")).status, 400);
  assert.equal((await get("/api/owners?era=all&era=ten-team")).status, 400);
  const era = await (await get("/api/owners?era=ten-team")).json();
  assert.deepEqual(era.qualifyingSeasons.map((item) => item.season), ["2025", "2024", "2023"]);
  assert.equal(careers.owners.length, 14);
  assert.equal(careers.currentDataAvailable, false);
  for (const path of ["/api/dashboard?season=2000", "/api/dashboard?season=../index", "/api/dashboard?season=2025&season=2024", "/data/history.json", "/server/identities.js", "/scripts/import-history.mjs"]) assert.equal((await get(path)).status, 404);
  assert.equal((await get("/api/dashboard")).status, 503);
  assert.equal((await fetch(`${base}/api/refresh?season=2025`, { method: "POST" })).status, 503);
  assert.equal(calls, 2);
});

test("career era uses actual team counts and recomputes median metrics and pooled deviation", () => {
  const all = history.careers(null);
  const ten = history.careers(null, { era: "ten-team" });
  assert.equal(ten.owners.filter((owner) => owner.seasons.length).length, 10);
  assert.equal(ten.owners.find((owner) => owner.id === "pyo-ethan-former").seasons.length, 0);
  assert.ok(all.owners.find((owner) => owner.id === "gaurav").championships > ten.owners.find((owner) => owner.id === "gaurav").championships);
  for (const owner of ten.owners.filter((owner) => owner.seasons.length)) {
    assert.ok(owner.seasons.every((season) => season.teamCount === 10 && Number(season.season) >= 2023));
    assert.equal(owner.seasonsPlayed, 3);
    assert.equal(owner.games, 42);
    assert.equal(owner.medianWins + owner.medianLosses + owner.medianTies, 42);
    assert.equal(owner.medianWinPct, (owner.medianWins + owner.medianTies / 2) / 42);
    assert.equal(owner.averageDeltaMedian, owner.cumulativeDeltaMedian / 42);
    const scores = archive.seasons.filter((season) => season.snapshot.metadata.teamCount === 10).flatMap(({ snapshot }) => {
      const roster = snapshot.teams.find((team) => team.canonicalOwnerIds.includes(owner.id));
      return snapshot.completedWeeks.map((week) => week.entries.find((entry) => entry.rosterId === roster.rosterId).score);
    });
    const mean = scores.reduce((a, b) => a + b) / scores.length;
    const deviation = Math.sqrt(scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / (scores.length - 1));
    assert.ok(Math.abs(owner.scoreDeviation - deviation) < 1e-10);
    assert.equal(owner.bestScore, Math.max(...scores));
    assert.equal(owner.worstScore, Math.min(...scores));
  }
  // A future year with twelve teams is not part of the ten-team era.
  const twelve = structuredClone(archive.seasons[0].snapshot);
  twelve.metadata.season = "2027";
  twelve.metadata.source = "sleeper";
  assert.equal(history.careers(twelve, { era: "ten-team" }).qualifyingSeasons.length, 3);
  const current = { metadata: { season: "2026", teamCount: 10 }, teams: [{ rosterId: 1, canonicalOwnerIds: ["new-owner"], managerName: "New owner" }, { rosterId: 2, canonicalOwnerIds: ["opponent"], managerName: "Opponent" }], completedWeeks: [{ entries: [{ rosterId: 1, matchupId: 1, score: 0 }, { rosterId: 2, matchupId: 1, score: 0 }] }] };
  const one = history.careers(current, { era: "ten-team" }).owners.find((owner) => owner.id === "new-owner");
  assert.equal(one.medianWinPct, 0.5);
  assert.equal(one.averageDeltaMedian, 0);
  assert.equal(one.scoreDeviation, null);
  current.completedWeeks.push({ entries: [{ rosterId: 1, matchupId: 1, score: -10 }, { rosterId: 2, matchupId: 1, score: 10 }] });
  const two = history.careers(current, { era: "ten-team" }).owners.find((owner) => owner.id === "new-owner");
  assert.equal(two.averageDeltaMedian, -5);
  assert.equal(two.medianWinPct, 0.25);
});

test("offline importer exactly reproduces checked-in archive when source is present", async (t) => {
  let html;
  try { html = await readFile(new URL("../../index.html", import.meta.url), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return t.skip("Standalone deployment has no root historical source"); throw error; }
  assert.deepEqual(importHistory(html, precise), archive);
  assert.throws(() => importHistory("const DATA = alert('not JSON');"));
});

test("original API scores and totals are preserved without rounding", () => {
  assert.equal(archive.provenance.scorePrecision, "original-api");
  let fractionalScores = 0;
  for (const { snapshot, recap } of archive.seasons) {
    const source = precise.seasons.find((item) => String(item.year) === snapshot.metadata.season);
    for (const week of snapshot.completedWeeks) {
      for (const entry of week.entries) {
        assert.equal(entry.score, source.weeks.find((item) => item.week === week.week).entries.find((item) => item.rosterId === entry.rosterId).score);
        if (Math.abs(entry.score * 10 - Math.round(entry.score * 10)) > 1e-6) fractionalScores++;
      }
    }
    for (const row of seasonRecords(snapshot)) {
      const standing = recap.standings.find((item) => item.rosterId === row.rosterId);
      assert.ok(Math.abs(row.pointsFor - standing.pointsFor) < 1e-6);
      assert.ok(Math.abs(row.pointsAgainst - standing.pointsAgainst) < 1e-6);
    }
  }
  assert.ok(fractionalScores > 0);
  const broken = structuredClone(archive);
  broken.seasons[0].recap.standings[0].pointsFor += 0.01;
  assert.throws(() => validateArchive(broken), /reconciliation/);
});

test("precision replacement rejects missing teams, duplicate weeks and wrong opponents", () => {
  for (const mutate of [
    (data) => data.seasons.pop(),
    (data) => data.seasons[0].weeks[0].entries.pop(),
    (data) => { data.seasons[0].weeks[1].week = 1; },
    (data) => { data.seasons[0].weeks[0].entries[0].opponentRosterId = 999; },
    (data) => { data.seasons[0].weeks[0].entries[0].score = null; },
  ]) {
    const data = structuredClone(precise); mutate(data);
    assert.throws(() => applyPrecision(archive, data));
  }
  assert.throws(() => normalizeEspnScores({ id: 1 }, 2025), /Invalid ESPN/);
});
