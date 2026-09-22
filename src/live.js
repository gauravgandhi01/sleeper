import { LiveActivity, gameFor, starterCounts, statusFresh } from "./live-state.js";
import { OWNER_ICONS, OWNER_ICON_VERSIONS } from "./owner-icons.js";

const activity = new LiveActivity();
let sortMode = "order";
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

function teamSide(team, context, makeAvatar) {
  const side = node("div", "live-team");
  side.append(makeAvatar(team));
  const copy = node("div", "live-team-copy");
  const name = node("strong", "", team.teamName);
  if (team.managerName && team.managerName !== team.teamName) name.append(" ", node("span", "live-team-owner", team.managerName));
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

function scoreBar(matchup) {
  const bar = node("div", "live-score-bar");
  const [a, b] = matchup.teams;
  const scores = matchup.teams.map((team) => Number.isFinite(team.score) ? Math.max(0, team.score) : 0);
  const total = scores[0] + scores[1];
  const widths = total > 0 ? scores.map((score) => Math.max(6, score / total * 100)) : [50, 50];
  const sum = widths[0] + widths[1];
  const labels = [`${a.teamName}: ${points(a.score)}`, `${b.teamName}: ${points(b.score)}`];
  matchup.teams.forEach((team, index) => {
    const segment = node("span", team.rosterId === matchup.leaderRosterId ? "is-leading" : "");
    segment.style.flexBasis = `${widths[index] / sum * 100}%`;
    segment.title = labels[index];
    bar.append(segment);
  });
  const leaderIndex = matchup.teams.findIndex((team) => team.rosterId === matchup.leaderRosterId);
  if (leaderIndex >= 0) {
    const marker = node("span", "live-score-bar-marker");
    const leader = matchup.teams[leaderIndex];
    const split = widths[0] / sum * 100;
    marker.style.left = `${split}%`;
    marker.title = `${leader.teamName} leads`;
    marker.setAttribute("aria-hidden", "true");
    marker.append(ownerAvatar(leader));
    bar.append(marker);
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
    return `${ownerName(leader)} beat ${loser ? ownerName(loser) : "opponent"} by ${points(matchup.margin)}`;
  }
  return `${ownerName(leader)} ${status === "final" ? "won" : "leads"} by ${points(matchup.margin)}`;
}

function statusText(starter, nfl) {
  if (starter.playerId == null) return "Empty slot";
  const game = gameFor(starter, nfl);
  if (!game) return [starter.nflTeam, "Game unavailable"].filter(Boolean).join(" \u00b7 ");
  const opponent = `${game.home ? "vs" : "@"} ${game.opponent}`;
  if (!statusFresh(nfl)) return `${opponent} \u00b7 Status unavailable`;
  if (game.state === "scheduled") {
    const date = new Date(game.kickoff);
    return `${opponent} \u00b7 ${Number.isNaN(date.valueOf()) ? "Scheduled" : date.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
  }
  return game.state === "final" ? opponent : `${opponent} \u00b7 ${game.detail}`;
}

function starterCell(starter, nfl) {
  const cell = node("div", "live-starter");
  if (!starter) { cell.append(node("span", "live-player-name", "Unavailable")); return cell; }
  const copy = node("div", "live-player-copy");
  const state = starter.playerId != null && statusFresh(nfl) ? gameFor(starter, nfl)?.state : null;
  const score = state === "scheduled" && starter.points === 0 ? "\u2014" : points(starter.points);
  const scoreStack = node("span", "live-player-score-stack");
  const name = node("strong", "live-player-name", starter.name);
  if (state === "final") name.append(" ", lockIcon("Player score locked"));
  copy.append(name);
  if (["live", "final", "scheduled"].includes(state)) cell.dataset.gameState = state;
  copy.append(node("span", "live-player-status", statusText(starter, nfl)));
  scoreStack.append(node("strong", "live-player-points", starter.playerId == null ? "\u2014" : score));
  if (state !== "final" && Number.isFinite(starter.projectedPoints)) scoreStack.append(node("span", "live-player-projected", points(starter.projectedPoints)));
  cell.append(copy, scoreStack);
  return cell;
}

function renderDetail(root, matchup, current, context, makeAvatar) {
  const navigation = node("div", "live-detail-nav");
  navigation.append(iconButton("ArrowLeft", "Back to Live Scores", () => { navigateBack = true; navigate(null); }, "liveBack"));
  const title = node("h3", "", "Starters"); title.id = "matchupDetailTitle"; title.tabIndex = -1;
  navigation.append(title);
  const index = current.matchups.indexOf(matchup);
  const previous = iconButton("ChevronLeft", "Previous matchup", () => navigate(current.matchups[index - 1].matchupId, current.week, true), "livePrevious");
  const next = iconButton("ChevronRight", "Next matchup", () => navigate(current.matchups[index + 1].matchupId, current.week, true), "liveNext");
  previous.disabled = index === 0; next.disabled = index === current.matchups.length - 1;
  navigation.append(previous, next);
  root.append(navigation);
  const summary = node("div", "live-detail-summary");
  matchup.teams.forEach((team) => {
    const side = teamSide(team, context, makeAvatar);
    side.classList.toggle("is-leading", team.rosterId === matchup.leaderRosterId);
    side.classList.toggle("is-winner", team.rosterId === matchup.leaderRosterId && matchup.teams.every((item) => teamLocked(item, context.nflStatus)));
    summary.append(side);
  });
  summary.append(node("p", "live-detail-margin", marginLabel(matchup, current.status, context.nflStatus)));
  root.append(summary);
  const roster = node("div", "live-roster");
  roster.setAttribute("role", "table"); roster.setAttribute("aria-label", "Starting lineup comparison");
  const [a, b] = matchup.teams.map((team) => team.starters || []);
  if (!a.length && !b.length) root.append(node("p", "section-note", "Starter details unavailable"));
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
    root.append(roster);
  }
  const section = node("section", "live-activity");
  section.append(node("h3", "", "Scoring activity"));
  const entries = activity.entries.get(matchup.matchupId) || [];
  if (!entries.length) section.append(node("p", "section-note", "No score changes observed yet."));
  const list = node("ol");
  for (const entry of entries) {
    const item = node("li");
    const stamp = node("time", "", `Observed ${time(entry.observedAt)}`); stamp.dateTime = entry.observedAt;
    item.append(stamp);
    const changes = node("div");
    for (const change of entry.changes) changes.append(node("p", "", `${change.team} ${change.delta > 0 ? "+" : ""}${points(change.delta)} \u2192 ${points(change.score)}`));
    if (entry.leadChanged) changes.append(node("strong", "", entry.leader ? `${entry.leader} takes the lead` : "Matchup tied"));
    item.append(changes); list.append(item);
  }
  section.append(list); root.append(section);
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
  heading.append(title, node("span", `live-state live-state-${current?.status}`, { provisional: "Live \u00b7 Provisional", awaiting_scoring: "Awaiting scoring", final: "Final", season_complete: "Regular season complete" }[current?.status] || "Unavailable"));
  header.append(heading);
  const actions = node("div", "live-actions");
  const freshness = node("div", "live-freshness");
  freshness.append(node("span", "", `Scores ${time(context.cachedAt)}${context.isStale ? " \u00b7 Saved" : ""}`));
  const nfl = context.nflStatus;
  lastFresh = statusFresh(nfl);
  freshness.append(node("span", "", `NFL ${time(nfl?.fetchedAt)}${!statusFresh(nfl) ? " \u00b7 Stale" : nfl?.failed ? " \u00b7 Saved" : ""}`));
  const projections = context.espnFantasyStatus;
  if (projections) freshness.append(node("span", "", projections.unavailable && !projections.fetchedAt ? "Proj Off" : `Proj ${projections.fetchedAt ? time(projections.fetchedAt) : "Unavailable"}${projections.stale ? " \u00b7 Stale" : projections.failed ? " \u00b7 Saved" : ""}`));
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
    const toolbar = node("div", "live-toolbar");
    toolbar.append(node("span", "", `${current.matchups.length} matchups`));
    const sort = node("select", "live-sort"); sort.id = "liveSort"; sort.setAttribute("aria-label", "Sort matchups");
    for (const [value, label] of [["order", "Matchup order"], ["closest", "Closest score"]]) { const option = node("option", "", label); option.value = value; sort.append(option); }
    sort.value = sortMode;
    sort.addEventListener("change", () => { sortMode = sort.value; order = [...current.matchups].sort((a, b) => sortMode === "closest" ? a.margin - b.margin || a.matchupId - b.matchupId : a.matchupId - b.matchupId).map((m) => m.matchupId); draw(); });
    toolbar.append(sort); root.append(toolbar);
    const key = `${stats.metadata.season}/${current.week}`;
    if (orderKey !== key) { orderKey = key; order = []; sortMode = "order"; sort.value = sortMode; }
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
