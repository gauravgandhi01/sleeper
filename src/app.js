import { initializeUi, renderDashboard, renderError, renderLoading, setRefreshState, renderConnectionWarning, renderSeasons, renderOwners, prepareSeason, prepareOwnerEra } from "./ui.js";

let catalog = null;
let selectedSeason = new URL(location.href).searchParams.get("season");
let requestVersion = 0;
let pendingRefresh = false;
let hasData = false;
let displayedSeason = null;
let ownersVersion = 0;
let ownerEra = "all";

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

async function requestDashboard(refresh = false) {
  if (refresh && (selectedSeason !== catalog?.currentSeason || pendingRefresh)) return;
  if (refresh) pendingRefresh = true;
  const version = ++requestVersion;
  const year = selectedSeason;
  setRefreshState(true);
  try {
    const payload = await json(refresh ? "/api/refresh" : `/api/dashboard${year ? `?season=${encodeURIComponent(year)}` : ""}`, { method: refresh ? "POST" : "GET" });
    if (version !== requestVersion) return;
    if (payload.schemaVersion !== 1 || !payload.stats) throw new Error("Unexpected dashboard response.");
    renderDashboard(payload.stats, { isStale: payload.stale, cachedAt: payload.lastSuccessfulFetchAt, warnings: payload.warnings, currentWeekMatchups: payload.currentWeekMatchups, draftBoard: payload.draftBoard, source: payload.source, recap: payload.recap, provenance: payload.provenance });
    hasData = true;
    displayedSeason = year;
    void loadOwners();
  } catch (error) {
    if (version !== requestVersion) return;
    if (hasData && displayedSeason === year) renderConnectionWarning();
    else renderError(error);
  } finally {
    if (refresh) pendingRefresh = false;
    if (version === requestVersion) setRefreshState(false);
  }
}

async function selectSeason(year, ownerId = null, updateUrl = true) {
  selectedSeason = year;
  const url = new URL(location.href);
  if (year === catalog?.currentSeason) url.searchParams.delete("season");
  else url.searchParams.set("season", year);
  if (ownerId) url.searchParams.set("owner", ownerId);
  else url.searchParams.delete("owner");
  if (updateUrl) history.pushState(null, "", url);
  prepareSeason(year, catalog?.seasons.find((item) => item.season === year)?.source === "espn", ownerId);
  if (year !== displayedSeason) { hasData = false; renderLoading(); }
  await requestDashboard();
  if (year === selectedSeason && year === catalog?.currentSeason) void requestDashboard(true);
}

initializeUi({ onRefresh: () => requestDashboard(true), onSeasonChange: selectSeason, onOwnerEraChange: (era) => {
  ownerEra = era;
  prepareOwnerEra(era);
  void loadOwners();
} });
renderLoading();
try {
  catalog = await json("/api/seasons");
  selectedSeason ||= catalog.currentSeason;
  renderSeasons(catalog, selectedSeason);
} catch { renderConnectionWarning(); }
void loadOwners();
await selectSeason(selectedSeason || "2026", new URL(location.href).searchParams.get("owner"), false);
window.addEventListener("popstate", () => {
  const url = new URL(location.href);
  void selectSeason(url.searchParams.get("season") || catalog?.currentSeason || "2026", url.searchParams.get("owner"), false);
});
