import { initializeUi, renderDashboard, renderLiveWeek, renderError, renderLoading, setRefreshState, renderConnectionWarning, renderSeasons, renderOwners, prepareSeason, prepareOwnerEra, selectTab, prepareRecords, renderRecords, prepareRivalry, renderRivalry } from "./ui.js";
import { liveAutoEnabled, updateLiveRoute, updateLiveHealth } from "./live.js";
import { shouldRefreshLive } from "./live-state.js";

let catalog = null;
let selectedSeason = new URL(location.href).searchParams.get("season");
let requestVersion = 0;
let pendingRefresh = false;
let hasData = false;
let displayedSeason = null;
let ownersVersion = 0;
let ownerEra = "all";
let activeTab = new URL(location.href).searchParams.get("tab") || "scoreboard";
let recordsEra = new URL(location.href).searchParams.get("recordsEra") || "ten-team";
let rivalry = readRivalry();
let recordsVersion = 0;
let rivalryVersion = 0;
let lastLiveAttempt = -Infinity;
let liveStatus = null;
let dashboardPending = 0;
let latestDashboard = null;
let dashboardNeedsRender = false;

function readRivalry() {
  const params = new URL(location.href).searchParams;
  return { era: params.get("h2hEra") || "ten-team", stage: params.get("h2hStage") || "all", ownerA: params.get("ownerA") || "", ownerB: params.get("ownerB") || "" };
}

function updateViewUrl() {
  const url = new URL(location.href);
  if (activeTab === "scoreboard") url.searchParams.delete("tab");
  else url.searchParams.set("tab", activeTab);
  url.searchParams.set("recordsEra", recordsEra);
  url.searchParams.set("h2hEra", rivalry.era);
  if (rivalry.stage === "all") url.searchParams.delete("h2hStage");
  else url.searchParams.set("h2hStage", rivalry.stage);
  for (const key of ["ownerA", "ownerB"]) {
    if (rivalry[key]) url.searchParams.set(key, rivalry[key]); else url.searchParams.delete(key);
  }
  if (url.href !== location.href) history.pushState(null, "", url);
}

async function loadRecords() {
  const version = ++recordsVersion;
  prepareRecords(recordsEra);
  try {
    const payload = await json(`/api/records?era=${encodeURIComponent(recordsEra)}`);
    if (version === recordsVersion) renderRecords(payload);
  } catch (error) { if (version === recordsVersion) renderRecords(null, error); }
}

async function loadRivalry() {
  const version = ++rivalryVersion;
  prepareRivalry(rivalry);
  const params = new URLSearchParams({ era: rivalry.era, stage: rivalry.stage });
  for (const key of ["ownerA", "ownerB"]) if (rivalry[key]) params.set(key, rivalry[key]);
  try {
    const payload = await json(`/api/head-to-head?${params}`);
    if (version === rivalryVersion) renderRivalry(payload);
  } catch (error) { if (version === rivalryVersion) renderRivalry(null, error); }
}

function loadActiveResearch() {
  if (activeTab === "records") void loadRecords();
  if (activeTab === "head-to-head") void loadRivalry();
}

async function json(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(60000), ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not load league data.");
  return payload;
}

async function loadOwners() {
  const version = ++ownersVersion;
  try { const payload = await json(ownerEra === "all" ? "/api/owners" : `/api/owners?era=${ownerEra}`); if (version === ownersVersion) renderOwners(payload); }
  catch { if (version === ownersVersion) renderOwners(null); }
}

async function requestDashboard(refresh = false, background = false) {
  if (refresh && (selectedSeason !== catalog?.currentSeason || pendingRefresh)) return;
  if (refresh) pendingRefresh = true;
  if (refresh) lastLiveAttempt = Date.now();
  dashboardPending++;
  const version = ++requestVersion;
  const year = selectedSeason;
  setRefreshState(true);
  try {
    const payload = await json(refresh ? "/api/refresh" : `/api/dashboard${year ? `?season=${encodeURIComponent(year)}` : ""}`, { method: refresh ? "POST" : "GET" });
    if (version !== requestVersion) return;
    if (payload.schemaVersion !== 1 || !payload.stats) throw new Error("Unexpected dashboard response.");
    liveStatus = payload.currentWeekMatchups?.status;
    const context = { isStale: payload.stale, cachedAt: payload.lastSuccessfulFetchAt, warnings: payload.warnings, currentWeekMatchups: payload.currentWeekMatchups, nflStatus: payload.nflStatus, draftBoard: payload.draftBoard, source: payload.source, recap: payload.recap, provenance: payload.provenance };
    latestDashboard = { stats: payload.stats, context };
    dashboardNeedsRender = background && hasData && displayedSeason === year;
    if (dashboardNeedsRender) renderLiveWeek(payload.stats, context);
    else renderDashboard(payload.stats, context);
    hasData = true;
    displayedSeason = year;
    if (!background) { void loadOwners(); loadActiveResearch(); }
  } catch (error) {
    if (version !== requestVersion) return;
    if (hasData && displayedSeason === year) { renderConnectionWarning(); updateLiveHealth(true); }
    else renderError(error);
  } finally {
    dashboardPending--;
    if (refresh) pendingRefresh = false;
    if (version === requestVersion) setRefreshState(false);
  }
}

async function selectSeason(year, ownerId = null, updateUrl = true) {
  if (year !== selectedSeason) { liveStatus = null; lastLiveAttempt = -Infinity; }
  selectedSeason = year;
  const url = new URL(location.href);
  if (updateUrl) { url.searchParams.delete("matchup"); url.searchParams.delete("week"); }
  if (year === catalog?.currentSeason) url.searchParams.delete("season");
  else url.searchParams.set("season", year);
  if (ownerId) url.searchParams.set("owner", ownerId);
  else url.searchParams.delete("owner");
  if (ownerId && updateUrl) { activeTab = "scoreboard"; url.searchParams.delete("tab"); }
  if (updateUrl) history.pushState(null, "", url);
  prepareSeason(year, catalog?.seasons.find((item) => item.season === year)?.source === "espn", ownerId, updateUrl);
  if (!updateUrl) selectTab(activeTab);
  if (year !== displayedSeason) { hasData = false; renderLoading(); }
  await requestDashboard();
  if (year === selectedSeason && year === catalog?.currentSeason) void requestDashboard(true);
}

function refreshLiveWhenDue() {
  if (activeTab === "live") updateLiveHealth();
  if (shouldRefreshLive({ auto: liveAutoEnabled(), visible: document.visibilityState !== "hidden", online: navigator.onLine !== false, active: activeTab === "live" && !document.getElementById("liveView").hidden, currentSeason: selectedSeason === catalog?.currentSeason, status: liveStatus, pending: dashboardPending > 0, lastAttempt: lastLiveAttempt })) void requestDashboard(true, true);
}

function renderLatestDashboard() {
  if (dashboardNeedsRender && latestDashboard && displayedSeason === selectedSeason && activeTab !== "live") {
    renderDashboard(latestDashboard.stats, latestDashboard.context);
    dashboardNeedsRender = false;
  }
}

initializeUi({ onRefresh: () => requestDashboard(true, activeTab === "live"), onSeasonChange: selectSeason,
  onTabChange: (tab) => { activeTab = tab; updateViewUrl(); renderLatestDashboard(); loadActiveResearch(); refreshLiveWhenDue(); },
  onRecordsEraChange: (era) => { recordsEra = era; updateViewUrl(); void loadRecords(); },
  onRivalryChange: (selection) => { rivalry = selection; updateViewUrl(); void loadRivalry(); },
  onOwnerEraChange: (era) => {
  ownerEra = era;
  prepareOwnerEra(era);
  void loadOwners();
} });
renderLoading();
selectTab(activeTab);
loadActiveResearch();
try {
  catalog = await json("/api/seasons");
  selectedSeason ||= catalog.currentSeason;
  renderSeasons(catalog, selectedSeason);
} catch { renderConnectionWarning(); }
void loadOwners();
await selectSeason(selectedSeason || "2026", new URL(location.href).searchParams.get("owner"), false);
window.addEventListener("popstate", () => {
  const url = new URL(location.href);
  activeTab = url.searchParams.get("tab") || "scoreboard";
  recordsEra = url.searchParams.get("recordsEra") || "ten-team";
  rivalry = readRivalry();
  const year = url.searchParams.get("season") || catalog?.currentSeason || "2026";
  if (year === displayedSeason && (activeTab === "live" || document.getElementById("liveTab").getAttribute("aria-selected") === "true")) { selectTab(activeTab); renderLatestDashboard(); updateLiveRoute(); loadActiveResearch(); refreshLiveWhenDue(); return; }
  void selectSeason(url.searchParams.get("season") || catalog?.currentSeason || "2026", url.searchParams.get("owner"), false);
  selectTab(activeTab);
  loadActiveResearch();
});
window.setInterval(refreshLiveWhenDue, 1000);
document.addEventListener("visibilitychange", refreshLiveWhenDue);
window.addEventListener("online", refreshLiveWhenDue);
window.addEventListener("live-auto-change", refreshLiveWhenDue);
