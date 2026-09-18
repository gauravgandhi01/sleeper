import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { History } from "../server/history.js";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const archive = await History.load();
const catalog = archive.seasons("2026");
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

function environment(t, url = "http://localhost/") {
  const dom = new JSDOM(html, { url });
  for (const key of ["window", "document", "Node", "location", "history"]) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else delete globalThis[key]; });
  }
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  t.after(() => dom.window.close());
  return dom.window.document;
}

test("season UI: archive recap, owner profiles, links, visible-tab keyboard navigation and preferences", async (t) => {
  const doc = environment(t);
  const ui = await import(`../src/ui.js?test=${Date.now()}`);
  const selections = [];
  ui.initializeUi({ onRefresh() {}, onSeasonChange: (...args) => selections.push(args) });
  ui.renderSeasons(catalog, "2025");
  doc.getElementById("liveTab").click();
  ui.prepareSeason("2025", true, null);
  const payload = archive.dashboard("2025");
  ui.renderDashboard(payload.stats, payload);
  assert.equal(doc.getElementById("overviewTab").getAttribute("aria-selected"), "true");
  assert.equal(doc.getElementById("liveTab").hidden, true);
  assert.equal(doc.getElementById("draftTab").hidden, true);
  assert.equal(doc.getElementById("refreshButton").hidden, true);
  assert.equal(doc.getElementById("statusTitle").textContent, "ESPN archive");
  assert.match(doc.getElementById("seasonRange").textContent, /14.*10 teams/);
  assert.equal(doc.querySelectorAll("#matrixTable tbody tr").length, 10);
  assert.match(doc.getElementById("seasonRecap").textContent, /Champion/);
  doc.getElementById("overviewTab").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(doc.activeElement.id, "weeklyTab");
  doc.getElementById("weeklyTab").dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  assert.equal(doc.activeElement.id, "ownersTab");
  const mode = [...doc.querySelectorAll("#matrixControls button")].find((button) => button.textContent.includes("Rank"));
  mode.click();
  const chosen = [...doc.querySelectorAll("#trendControls input:checked")].map((input) => input.parentElement.textContent);
  const ownerIds = payload.stats.teams.filter((team) => chosen.includes(team.managerName)).flatMap((team) => team.canonicalOwnerIds);
  const past = archive.dashboard("2018");
  ui.prepareSeason("2018", true, "gaurav");
  ui.renderDashboard(past.stats, past);
  assert.match(doc.getElementById("seasonRange").textContent, /13.*12 teams/);
  assert.equal(doc.querySelectorAll("#matrixTable tbody tr").length, 12);
  assert.match(doc.querySelector("#matrixTable .owner-highlight").textContent, /Gaurav/);
  assert.match(doc.querySelector("#matrixTable caption").textContent, /rank/);
  const selectedNames = [...doc.querySelectorAll("#trendControls input:checked")].map((input) => input.parentElement.textContent);
  assert.deepEqual(past.stats.teams.filter((team) => selectedNames.includes(team.managerName)).flatMap((team) => team.canonicalOwnerIds).sort(), ownerIds.sort());
  ui.renderOwners(archive.careers(null, { currentSeason: "2026" }));
  assert.equal(doc.querySelectorAll("#ownersContent tbody tr").length, 14);
  const filter = doc.getElementById("currentOwnersOnly");
  filter.checked = true;
  filter.dispatchEvent(new window.Event("change"));
  assert.equal(doc.querySelectorAll("#ownersContent tbody tr").length, 10);
  const gaurav = [...doc.querySelectorAll(".owner-button")].find((button) => button.textContent.includes("Gaurav"));
  gaurav.click();
  assert.equal(doc.querySelector("#ownersContent h3").textContent, "Gaurav Gandhi");
  const link = doc.querySelector("#ownersContent a");
  assert.match(link.href, /season=2025&owner=gaurav/);
  link.click();
  assert.deepEqual(selections.at(-1), ["2025", "gaurav"]);
  ui.prepareSeason("2026", false, null);
  assert.equal(doc.getElementById("draftTab").hidden, false);
  assert.equal(doc.getElementById("refreshButton").hidden, false);
});

test("client ignores late season/refresh responses and handles deep links and back navigation", async (t) => {
  const doc = environment(t);
  let resolveOldSeason;
  let resolveRefresh;
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const current = archive.dashboard("2025");
  current.source = "sleeper";
  current.stats.metadata.season = "2026";
  current.recap = null;
  const response = (body) => ({ ok: true, json: async () => body });
  globalThis.fetch = async (url) => {
    if (url === "/api/seasons") return response(catalog);
    if (url === "/api/owners") return response(archive.careers(null, { currentSeason: "2026" }));
    if (url === "/api/refresh") return new Promise((resolve) => { resolveRefresh = () => resolve(response(current)); });
    if (url.endsWith("season=2018")) return new Promise((resolve) => { resolveOldSeason = () => resolve(response(archive.dashboard("2018"))); });
    if (url.endsWith("season=2025")) return response(archive.dashboard("2025"));
    return response(current);
  };
  const source = (await readFile(new URL("../src/app.js", import.meta.url), "utf8")).replace('"./ui.js"', JSON.stringify(`${new URL("../src/ui.js", import.meta.url).href}?race=${Date.now()}`));
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.match(doc.getElementById("brandSeason").textContent, /2026/);
  const select = doc.getElementById("seasonSelect");
  select.value = "2018";
  select.dispatchEvent(new window.Event("change"));
  select.value = "2025";
  select.dispatchEvent(new window.Event("change"));
  await flush();
  assert.match(doc.getElementById("brandSeason").textContent, /2025/);
  resolveOldSeason(); resolveRefresh(); await flush();
  assert.match(doc.getElementById("brandSeason").textContent, /2025/);
  assert.equal(doc.querySelectorAll("#matrixTable tbody tr").length, 10);
  assert.equal(doc.getElementById("refreshButton").hidden, true);
  history.pushState(null, "", "?season=2018&owner=gaurav");
  window.dispatchEvent(new window.PopStateEvent("popstate"));
  resolveOldSeason(); await flush();
  assert.match(doc.getElementById("brandSeason").textContent, /2018/);
  assert.match(doc.querySelector(".owner-highlight").textContent, /Gaurav/);
  assert.equal(doc.getElementById("seasonSelect").value, "2018");
});

test("initial archive deep link loads highlighted owner without refreshing Sleeper", async (t) => {
  const doc = environment(t, "http://localhost/?season=2022&owner=gaurav");
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const payload = url === "/api/seasons" ? catalog : url === "/api/owners" ? archive.careers(null, { currentSeason: "2026" }) : archive.dashboard("2022");
    return { ok: true, json: async () => payload };
  };
  const source = (await readFile(new URL("../src/app.js", import.meta.url), "utf8")).replace('"./ui.js"', JSON.stringify(`${new URL("../src/ui.js", import.meta.url).href}?deep=${Date.now()}`));
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  await flush();
  assert.equal(calls.includes("/api/refresh"), false);
  assert.equal(doc.getElementById("seasonSelect").value, "2022");
  assert.match(doc.querySelector(".owner-highlight").textContent, /Gaurav/);
  assert.match(doc.getElementById("seasonRecap").textContent, /Manual True League title correction/);
  assert.match(doc.getElementById("ownersStatus").textContent, /Current-season contributions are unavailable/);
});

test("trend sums weekly score-minus-median with full precision and excludes provisional weeks", async (t) => {
  const doc = environment(t);
  const ui = await import(`../src/ui.js?cumulative=${Date.now()}`);
  ui.initializeUi({ onRefresh() {} });
  const payload = archive.dashboard("2025");
  payload.stats.weeks = payload.stats.weeks.slice(0, 2);
  const team = payload.stats.teams[0];
  payload.stats.weeks[0].entries.find((entry) => entry.rosterId === team.rosterId).score = 12.34;
  payload.stats.weeks[1].entries.find((entry) => entry.rosterId === team.rosterId).score = 23.45;
  payload.stats.weeks[0].leagueMedian = 10;
  payload.stats.weeks[1].leagueMedian = 30;
  payload.stats.liveWeek = { ...structuredClone(payload.stats.weeks[1]), week: 3, status: "live" };
  ui.renderDashboard(payload.stats, payload);
  const titles = [...doc.querySelectorAll("#trendChart .chart-dot title")].map((node) => node.textContent);
  assert.ok(titles.includes(`${team.managerName}, through Week 1: +2.34 cumulative vs median`));
  assert.ok(titles.includes(`${team.managerName}, through Week 2: -4.21 cumulative vs median`));
  assert.ok(titles.every((title) => !title.includes("Week 3")));
  assert.ok(doc.querySelector("#trendChart .chart-median"));
  payload.stats.weeks = payload.stats.weeks.slice(0, 1);
  ui.renderDashboard(payload.stats, payload);
  assert.ok(!doc.querySelector("#trendChart svg").outerHTML.includes("NaN"));
  payload.stats.weeks = [];
  ui.renderDashboard(payload.stats, payload);
  assert.match(doc.getElementById("trendChart").textContent, /No finalized trends yet/);
});
