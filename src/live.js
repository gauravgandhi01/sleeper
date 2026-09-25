import { LiveActivity, gameFor, starterCounts, statusFresh } from "./live-state.js";
import { OWNER_ICONS, OWNER_ICON_VERSIONS } from "./owner-icons.js";

const activity = new LiveActivity();
let order = [];
let orderKey = "";
let auto = true;
let busy = false;
let latest = null;
let lastFresh = false;
let headerObserver = null;
let observedHeader = null;
let navigateBack = false;
const points = (value) => Number.isFinite(value) ? value.toFixed(2) : "\u2014";
const time = (value) => value ? new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "Unavailable";
const recordText = (record) => record ? `${record.wins}-${record.losses}${record.ties ? `-${record.ties}` : ""}` : "";
const safeFilename = (value) => String(value || "export").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "export";
const ESPN_NFL_LOGO_BASE = "https://a.espncdn.com/i/teamlogos/nfl/500";
const NFL_LOGO_CODES = {
  ARI: "ari", ATL: "atl", BAL: "bal", BUF: "buf", CAR: "car", CHI: "chi", CIN: "cin", CLE: "cle",
  DAL: "dal", DEN: "den", DET: "det", GB: "gb", HOU: "hou", IND: "ind", JAX: "jax", KC: "kc",
  LV: "lv", LAC: "lac", LAR: "lar", MIA: "mia", MIN: "min", NE: "ne", NO: "no", NYG: "nyg",
  NYJ: "nyj", PHI: "phi", PIT: "pit", SEA: "sea", SF: "sf", TB: "tb", TEN: "ten", WAS: "wsh",
};
function node(tag, cls = "", text) {
  const element = document.createElement(tag);
  element.className = cls;
  if (text !== undefined) element.textContent = text;
  return element;
}
function iconButton(icon, label, action, id) {
  const button = node("button", "live-icon-button");
  button.type = "button";
  button.id = id;
  button.title = label;
  button.setAttribute("aria-label", label);
  const library = globalThis.lucide;
  if (library?.[icon]) {
    const svg = library.createElement(library[icon]);
    svg.setAttribute("width", "18"); svg.setAttribute("height", "18"); svg.setAttribute("aria-hidden", "true");
    button.append(svg);
  } else button.append(node("span", "", { ArrowLeft: "\u2190", ChevronLeft: "\u2039", ChevronRight: "\u203a", RefreshCw: "\u21bb" }[icon]));
  button.addEventListener("click", action);
  return button;
}

function exportButton(label, action) {
  const button = node("button", "refresh-button export-button live-export-button", "Export");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", action);
  return button;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function downloadUrl(url, filename) {
  const link = node("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

async function inlineImages(root) {
  await Promise.all([...root.querySelectorAll("img")].map(async (image) => {
    try {
      const response = await fetch(new URL(image.getAttribute("src"), window.location.href));
      if (!response.ok) throw new Error("image fetch failed");
      image.src = await blobToDataUrl(await response.blob());
    } catch {
      image.remove();
    }
  }));
}

async function exportElementAsPng(element, filename) {
  const clone = element.cloneNode(true);
  await inlineImages(clone);
  const width = Math.ceil(element.scrollWidth || element.getBoundingClientRect().width || 1100);
  const height = Math.ceil(element.scrollHeight || element.getBoundingClientRect().height || 700);
  const css = [...document.styleSheets].map((sheet) => {
    try { return [...sheet.cssRules].map((rule) => rule.cssText).join("\n"); }
    catch { return ""; }
  }).join("\n");
  const wrapper = document.createElement("div");
  wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  wrapper.style.background = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim() || "#ffffff";
  wrapper.style.color = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() || "#111111";
  wrapper.style.padding = "18px";
  wrapper.style.width = `${width}px`;
  const style = document.createElement("style");
  style.textContent = `${css}\n.live-detail-summary{position:static}.live-matchup-export{background:transparent}`;
  wrapper.append(style, clone);
  const serialized = new XMLSerializer().serializeToString(wrapper);
  const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 36}" height="${height + 36}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
  const image = new Image();
  const svgBlob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  image.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width + 36;
      canvas.height = height + 36;
      canvas.getContext("2d").drawImage(image, 0, 0);
      downloadUrl(canvas.toDataURL("image/png"), filename);
    } catch {
      downloadUrl(URL.createObjectURL(svgBlob), filename.replace(/\.png$/i, ".svg"));
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    downloadUrl(URL.createObjectURL(svgBlob), filename.replace(/\.png$/i, ".svg"));
  };
  image.src = url;
}
export function liveAutoEnabled() { return auto; }
export function setLiveBusy(value) {
  busy = value;
  const button = document.getElementById("liveRefresh");
  if (button) { button.disabled = value; button.setAttribute("aria-busy", String(value)); }
}
export function updateLiveRoute() { if (latest) draw(); }
export function updateLiveHealth(failed = false) {
  if (!latest) return;
  if (failed) latest.context.isStale = true;
  if (failed || statusFresh(latest.context.nflStatus) !== lastFresh) draw();
}

function navigate(matchupId, week, replace = false) {
  const url = new URL(window.location.href);
  if (matchupId == null) { url.searchParams.delete("matchup"); url.searchParams.delete("week"); }
  else { url.searchParams.set("matchup", matchupId); url.searchParams.set("week", week); url.searchParams.set("tab", "live"); }
  window.history[replace ? "replaceState" : "pushState"](null, "", url);
  draw();
  document.getElementById(matchupId == null ? "liveTitle" : "matchupDetailTitle")?.focus({ preventScroll: true });
}

function ownerInitials(team) {
  const source = team.managerName || team.teamName || "Owner";
  const parts = source.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "OW").toUpperCase();
}

function ownerName(team) {
  return team.managerName || team.teamName || "Owner";
}

function shortOwnerName(name) {
  if (!name) return "Owner";
  return String(name).split(/\s*\/\s*/).map((part) => part.trim().split(/\s+/)[0] || part.trim()).filter(Boolean).join(" / ");
}

function ownerDisplayName(team) {
  return shortOwnerName(ownerName(team));
}

function lockIcon(label = "Score locked") {
  const icon = node("span", "live-lock", "\ud83d\udd12");
  icon.title = label;
  icon.setAttribute("aria-label", label);
  return icon;
}

function teamLocked(team, nfl) {
  const counts = starterCounts(team, nfl);
  return Boolean(counts?.final > 0 && counts.live === 0 && counts.scheduled === 0 && counts.unknown === 0);
}

function ownerIconSrc(team) {
  const ownerId = team.canonicalOwnerIds?.find((id) => OWNER_ICONS[id]);
  if (!ownerId) return null;
  const version = OWNER_ICON_VERSIONS[ownerId];
  return `./${OWNER_ICONS[ownerId]}${version ? `?v=${version}` : ""}`;
}

function ownerAvatar(team) {
  const avatar = node("span", "team-avatar owner-avatar", ownerInitials(team));
  const imageUrl = ownerIconSrc(team);
  if (imageUrl) {
    const image = node("img");
    image.src = imageUrl;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => { image.hidden = true; }, { once: true });
    avatar.append(image);
  }
  return avatar;
}

function nflLogoUrl(team) {
  const code = NFL_LOGO_CODES[String(team || "").toUpperCase()];
  return code ? `${ESPN_NFL_LOGO_BASE}/${code}.png` : null;
}

function nflLogo(team, extraClass = "") {
  const imageUrl = nflLogoUrl(team);
  if (!imageUrl) return null;
  const image = node("img", `live-nfl-logo${extraClass ? ` ${extraClass}` : ""}`);
  image.src = imageUrl;
  image.alt = `${String(team).toUpperCase()} logo`;
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("error", () => image.remove(), { once: true });
  return image;
}

function teamSide(team, context, makeAvatar) {
  const side = node("div", "live-team");
  side.append(makeAvatar(team));
  const copy = node("div", "live-team-copy");
  const name = node("strong", "", team.teamName);
  if (team.managerName && team.managerName !== team.teamName) {
    const owner = node("span", "live-team-owner", shortOwnerName(team.managerName));
    owner.title = team.managerName;
    name.append(" ", owner);
  }
  const record = recordText(team.record);
  if (record) name.append(" ", node("span", "live-team-record", `(${record})`));
  copy.append(name);
  const counts = starterCounts(team, context.nflStatus);
  const status = node("span", "live-team-status", counts ? `Finished ${counts.final} \u00b7 Live ${counts.live} \u00b7 Remaining ${counts.scheduled}${counts.unknown ? ` \u00b7 Unknown ${counts.unknown}` : ""}` : "Game status unavailable");
  copy.append(status);
  const scoreStack = node("span", "live-score-stack");
  const scoreLine = node("span", "live-score-line");
  const score = node("strong", "live-score-value", points(team.score));
  if (Date.now() - (activity.changed.get(team.rosterId) || 0) < 2500) score.classList.add("score-changed");
  scoreLine.append(score);
  if (teamLocked(team, context.nflStatus)) scoreLine.append(lockIcon("Team score locked"));
  scoreStack.append(scoreLine);
  if (Number.isFinite(team.projectedScore)) scoreStack.append(node("span", "live-projected-value", points(team.projectedScore)));
  side.append(copy, scoreStack);
  return side;
}

function splitFor(values) {
  const sanitized = values.map((value) => Number.isFinite(value) ? Math.max(0, value) : 0);
  const total = sanitized[0] + sanitized[1];
  if (!total) return { widths: [50, 50], split: 50 };
  const raw = sanitized.map((value) => value / total * 100);
  const widths = raw.map((value) => Math.max(6, value));
  const sum = widths[0] + widths[1];
  return { widths: widths.map((value) => value / sum * 100), split: widths[0] / sum * 100 };
}

function leaderFor(matchup, key = "score") {
  const [a, b] = matchup.teams;
  const av = Number.isFinite(a?.[key]) ? a[key] : null;
  const bv = Number.isFinite(b?.[key]) ? b[key] : null;
  if (av == null || bv == null || av === bv) return null;
  return av > bv ? a : b;
}

function barMarker(team, split, kind) {
  const marker = node("span", `live-score-bar-marker live-score-bar-marker-${kind}`);
  marker.style.left = `${split}%`;
  marker.title = `${team.teamName} ${kind === "projected" ? "projected lead" : "leads"}`;
  marker.setAttribute("aria-hidden", "true");
  marker.append(ownerAvatar(team));
  return marker;
}

function scoreBar(matchup) {
  const bar = node("div", "live-score-bar");
  const [a, b] = matchup.teams;
  const current = splitFor(matchup.teams.map((team) => team.score));
  const projectedScores = matchup.teams.map((team) => Number.isFinite(team.projectedScore) ? team.projectedScore : null);
  const hasProjected = projectedScores.every(Number.isFinite);
  const projected = hasProjected ? splitFor(projectedScores) : null;
  const labels = [`${a.teamName}: ${points(a.score)}${Number.isFinite(a.projectedScore) ? ` projected ${points(a.projectedScore)}` : ""}`, `${b.teamName}: ${points(b.score)}${Number.isFinite(b.projectedScore) ? ` projected ${points(b.projectedScore)}` : ""}`];
  if (projected) {
    const projectionTrack = node("div", "live-score-bar-layer live-score-bar-projected");
    matchup.teams.forEach((team, index) => {
      const segment = node("span", leaderFor(matchup, "projectedScore")?.rosterId === team.rosterId ? "is-projected-leading" : "");
      segment.style.flexBasis = `${projected.widths[index]}%`;
      projectionTrack.append(segment);
    });
    bar.append(projectionTrack);
  }
  const currentTrack = node("div", "live-score-bar-layer live-score-bar-current");
  matchup.teams.forEach((team, index) => {
    const segment = node("span", team.rosterId === matchup.leaderRosterId ? "is-leading" : "");
    segment.style.flexBasis = `${current.widths[index]}%`;
    segment.title = labels[index];
    currentTrack.append(segment);
  });
  bar.append(currentTrack);
  const leaderIndex = matchup.teams.findIndex((team) => team.rosterId === matchup.leaderRosterId);
  if (leaderIndex >= 0) bar.append(barMarker(matchup.teams[leaderIndex], current.split, "current"));
  const projectedLeader = projected ? leaderFor(matchup, "projectedScore") : null;
  if (projectedLeader && projectedLeader.rosterId !== matchup.leaderRosterId) {
    bar.append(barMarker(projectedLeader, projected.split, "projected"));
  }
  bar.setAttribute("aria-label", labels.join(" versus "));
  return bar;
}

function marginLabel(matchup, status, nfl) {
  if (status === "awaiting_scoring") return "Awaiting scoring";
  const leader = matchup.teams.find((team) => team.rosterId === matchup.leaderRosterId);
  const locked = matchup.teams.length === 2 && matchup.teams.every((team) => teamLocked(team, nfl));
  if (!leader) return locked || status === "final" ? "Finished tied" : "Tied";
  if (locked) {
    const loser = matchup.teams.find((team) => team.rosterId !== leader.rosterId);
    return `${ownerDisplayName(leader)} beat ${loser ? ownerDisplayName(loser) : "opponent"} by ${points(matchup.margin)}`;
  }
  return `${ownerDisplayName(leader)} ${status === "final" ? "won" : "leads"} by ${points(matchup.margin)}`;
}

function gameStatus(starter, nfl) {
  if (starter.playerId == null) return { text: "Empty slot" };
  const game = gameFor(starter, nfl);
  if (!game) return { text: "Game unavailable" };
  const relation = game.home ? "vs" : "@";
  if (!statusFresh(nfl)) return { relation, opponent: game.opponent, text: "Status unavailable" };
  if (game.state === "scheduled") {
    const date = new Date(game.kickoff);
    return { relation, opponent: game.opponent, text: Number.isNaN(date.valueOf()) ? "Scheduled" : date.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) };
  }
  return { relation, opponent: game.opponent, text: game.state === "final" ? "" : game.detail };
}

function starterCell(starter, nfl) {
  const cell = node("div", "live-starter");
  if (!starter) { cell.append(node("span", "live-player-name", "Unavailable")); return cell; }
  const copy = node("div", "live-player-copy");
  const state = starter.playerId != null && statusFresh(nfl) ? gameFor(starter, nfl)?.state : null;
  const score = state === "scheduled" && starter.points === 0 ? "\u2014" : points(starter.points);
  const scoreStack = node("span", "live-player-score-stack");
  const name = node("strong", "live-player-name");
  name.append(node("span", "live-player-name-text", starter.name));
  const teamLogo = nflLogo(starter.nflTeam, "live-player-team-logo");
  if (teamLogo) name.append(" ", teamLogo);
  if (["live", "final"].includes(state) && starter.statLine) name.append(" ", node("span", "live-player-statline", starter.statLine));
  if (state === "final") name.append(" ", lockIcon("Player score locked"));
  copy.append(name);
  if (["live", "final", "scheduled"].includes(state)) cell.dataset.gameState = state;
  const status = node("span", "live-player-status");
  const game = gameStatus(starter, nfl);
  if (game.opponent) {
    status.classList.add("has-matchup");
    status.append(node("span", "live-game-relation", game.relation));
    const opponentLogo = nflLogo(game.opponent);
    if (opponentLogo) status.append(opponentLogo);
    else status.append(node("span", "live-game-opponent", game.opponent));
  }
  if (game.text) status.append(node("span", "live-game-detail", game.text));
  copy.append(status);
  scoreStack.append(node("strong", "live-player-points", starter.playerId == null ? "\u2014" : score));
  if (state !== "final" && Number.isFinite(starter.projectedPoints)) scoreStack.append(node("span", "live-player-projected", points(starter.projectedPoints)));
  cell.append(copy, scoreStack);
  return cell;
}

function matchupPicker(matchups, selected, week) {
  const picker = node("div", "live-matchup-picker");
  picker.setAttribute("aria-label", "Choose matchup");
  matchups.forEach((matchup) => {
    const button = node("button", `live-matchup-picker-button${matchup.matchupId === selected.matchupId ? " is-selected" : ""}`);
    button.type = "button";
    button.id = `liveMatchupPick-${matchup.matchupId}`;
    button.setAttribute("aria-label", matchup.teams.map((team) => team.teamName).join(" versus "));
    button.setAttribute("aria-current", String(matchup.matchupId === selected.matchupId));
    button.addEventListener("click", () => navigate(matchup.matchupId, week, true));
    matchup.teams.forEach((team) => button.append(ownerAvatar(team)));
    picker.append(button);
  });
  return picker;
}

function renderDetail(root, matchup, current, context, makeAvatar) {
  const navigation = node("div", "live-detail-nav");
  navigation.append(iconButton("ArrowLeft", "Back to Live Scores", () => { navigateBack = true; navigate(null); }, "liveBack"));
  const title = node("h3", "", "Starters"); title.id = "matchupDetailTitle"; title.tabIndex = -1;
  navigation.append(title, matchupPicker(current.matchups, matchup, current.week), exportButton("Export matchup", () => {
    const target = document.getElementById("liveMatchupExport");
    if (target) void exportElementAsPng(target, `${safeFilename(`matchup-week-${current.week}-${matchup.teams.map((team) => shortOwnerName(ownerName(team))).join("-vs-")}`)}.png`);
  }));
  root.append(navigation);
  const exportWrap = node("article", "live-matchup-export");
  exportWrap.id = "liveMatchupExport";
  const summary = node("div", "live-detail-summary");
  matchup.teams.forEach((team) => {
    const side = teamSide(team, context, makeAvatar);
    side.classList.toggle("is-leading", team.rosterId === matchup.leaderRosterId);
    side.classList.toggle("is-winner", team.rosterId === matchup.leaderRosterId && matchup.teams.every((item) => teamLocked(item, context.nflStatus)));
    summary.append(side);
  });
  summary.append(node("p", "live-detail-margin", marginLabel(matchup, current.status, context.nflStatus)));
  exportWrap.append(summary);
  const roster = node("div", "live-roster");
  roster.setAttribute("role", "table"); roster.setAttribute("aria-label", "Starting lineup comparison");
  const [a, b] = matchup.teams.map((team) => team.starters || []);
  if (!a.length && !b.length) exportWrap.append(node("p", "section-note", "Starter details unavailable"));
  else {
    const labels = node("div", "live-starter-row live-roster-labels"); labels.setAttribute("role", "row");
    for (const text of [matchup.teams[0].teamName, "Slot", matchup.teams[1].teamName]) {
      const label = node("span", "", text); label.setAttribute("role", "columnheader"); labels.append(label);
    }
    roster.append(labels);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const row = node("div", "live-starter-row"); row.setAttribute("role", "row");
      const left = starterCell(a[i], context.nflStatus);
      const right = starterCell(b[i], context.nflStatus);
      const slot = node("span", "live-slot", a[i]?.slot || b[i]?.slot || "\u2014");
      for (const cell of [left, slot, right]) cell.setAttribute("role", "cell");
      row.append(left, slot, right); roster.append(row);
    }
    exportWrap.append(roster);
  }
  root.append(exportWrap);
}

function draw() {
  const { stats, context, makeAvatar, onRefresh } = latest;
  const root = document.getElementById("liveWeekRegion");
  const focusId = root.contains(document.activeElement) ? document.activeElement.id : null;
  root.replaceChildren();
  const current = context.currentWeekMatchups;
  const header = node("header", "live-header");
  const heading = node("div", "live-heading");
  const title = node("h2", "", current?.week ? `Week ${current.week}` : "Live Scores"); title.id = "liveTitle"; title.tabIndex = -1;
  heading.append(title, node("span", `live-state live-state-${current?.status}`, { provisional: "Live", awaiting_scoring: "Awaiting scoring", final: "Final", season_complete: "Regular season complete" }[current?.status] || "Unavailable"));
  header.append(heading);
  const actions = node("div", "live-actions");
  const freshness = node("div", "live-freshness");
  freshness.append(node("span", "", `Scores ${time(context.cachedAt)}${context.isStale ? " \u00b7 Saved" : ""}`));
  const nfl = context.nflStatus;
  lastFresh = statusFresh(nfl);
  freshness.append(node("span", "", `NFL ${time(nfl?.fetchedAt)}${!statusFresh(nfl) ? " \u00b7 Stale" : nfl?.failed ? " \u00b7 Saved" : ""}`));
  const projections = context.projectionStatus || context.espnFantasyStatus;
  if (projections) freshness.append(node("span", "", projections.unavailable && !projections.fetchedAt ? "Proj Off" : `Proj ${projections.source ? `${projections.source} ` : ""}${projections.fetchedAt ? time(projections.fetchedAt) : "Unavailable"}${projections.stale ? " \u00b7 Stale" : projections.failed ? " \u00b7 Saved" : ""}`));
  const label = node("label", "live-auto", "Auto-refresh");
  const input = node("input"); input.type = "checkbox"; input.id = "liveAuto"; input.checked = auto; input.setAttribute("role", "switch");
  input.addEventListener("change", () => { auto = input.checked; window.dispatchEvent(new window.Event("live-auto-change")); });
  label.append(input);
  const refresh = iconButton("RefreshCw", "Refresh scores", () => onRefresh(), "liveRefresh"); refresh.disabled = busy;
  actions.append(freshness, label, refresh); header.append(actions); root.append(header);
  if (!current?.matchups?.length) {
    root.append(node("p", "live-empty", current?.status === "season_complete" ? "Regular season complete" : "Matchups unavailable"));
    return;
  }
  const params = new URL(window.location.href).searchParams;
  const requested = params.get("matchup");
  const selected = params.get("week") === String(current.week) && current.matchups.find((item) => String(item.matchupId) === requested);
  if (requested && !selected) {
    const url = new URL(window.location.href); url.searchParams.delete("matchup"); url.searchParams.delete("week"); window.history.replaceState(null, "", url);
  }
  if (selected) renderDetail(root, selected, current, context, makeAvatar);
  else {
    const key = `${stats.metadata.season}/${current.week}`;
    if (orderKey !== key) { orderKey = key; order = []; }
    const ids = current.matchups.map((m) => m.matchupId);
    order = [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))];
    const grid = node("div", "live-matchup-grid");
    for (const id of order) {
      const matchup = current.matchups.find((m) => m.matchupId === id);
      const card = node("button", "live-matchup-card"); card.type = "button"; card.id = `matchup-${id}`;
      card.setAttribute("aria-label", `${matchup.teams.map((team) => team.teamName).join(" versus ")}, view starters`);
      card.addEventListener("click", () => navigate(id, current.week));
      const locked = matchup.teams.every((team) => teamLocked(team, context.nflStatus));
      card.classList.toggle("is-complete", locked);
      matchup.teams.forEach((team) => { const side = teamSide(team, context, makeAvatar); side.classList.toggle("is-leading", team.rosterId === matchup.leaderRosterId); side.classList.toggle("is-winner", locked && team.rosterId === matchup.leaderRosterId); card.append(side); });
      card.append(scoreBar(matchup));
      const footer = node("span", "live-card-footer");
      footer.append(node("span", "", marginLabel(matchup, current.status, context.nflStatus)), node("span", "live-chevron", "\u203a")); card.append(footer); grid.append(card);
    }
    root.append(grid);
    if (current.unpairedTeams?.length) root.append(node("p", "section-note", `Opponent unavailable: ${current.unpairedTeams.map((team) => team.teamName).join(", ")}`));
  }
  if (focusId && !navigateBack) document.getElementById(focusId)?.focus({ preventScroll: true });
  navigateBack = false;
}

export function renderLiveScores(stats, context, makeAvatar, onRefresh) {
  const header = document.querySelector(".site-header");
  if (header && header !== observedHeader && window.ResizeObserver) {
    headerObserver?.disconnect();
    observedHeader = header;
    const measure = () => document.getElementById("liveWeekRegion")?.style.setProperty("--live-sticky-top", `${Math.ceil(header.getBoundingClientRect().height)}px`);
    headerObserver = new window.ResizeObserver(measure);
    headerObserver.observe(header);
    measure();
  }
  latest = { stats, context, makeAvatar, onRefresh };
  activity.observe(stats.metadata.season, context.currentWeekMatchups, context.cachedAt);
  draw();
}
