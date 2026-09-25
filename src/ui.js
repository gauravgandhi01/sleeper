import { OWNER_ICONS, OWNER_ICON_VERSIONS } from "./owner-icons.js";
import { renderLiveScores, setLiveBusy } from "./live.js";

const COLORS = [
  "#27785b", "#d46a55", "#6676d8", "#c48b22", "#8b5fc7",
  "#2e91a3", "#b65686", "#58843c", "#a86637", "#476f95",
];

const uiState = {
  statSort: { key: "total", direction: "desc" },
  matrixMode: "score",
};

let refreshHandler = () => {};
let seasonHandler = () => {};
let tabHandler = () => {};
let highlightedOwner = null;
let ownerData = null;
let selectedOwner = null;
let ownerEra = "all";
const ownerSort = { key: "name", direction: "asc" };
const ownerSeasonSort = { key: "season", direction: "desc" };
const ownerCache = new Map();
const statbookHiddenTeams = new Set();
const trendHiddenOwners = new Set();
const ownerTrendHiddenOwners = new Set();
const OWNER_ORDER = ["jake", "dylan", "gaurav", "zach", "kyle", "alex", "harrison", "will", "ben", "ethan", "cameron", "pyo-ethan-former", "ben-stanish", "zane"];

function ownerLineStyle(team) {
  const id = team.canonicalOwnerIds?.[0] || `roster:${team.rosterId}`;
  const known = OWNER_ORDER.indexOf(id);
  const index = known >= 0 ? known : [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return { color: COLORS[index % COLORS.length], dash: ["", "7 3", "2 3"][Math.floor(index / COLORS.length) % 3] };
}

function trendOwnerId(team) {
  return String(team.canonicalOwnerIds?.[0] || team.id || `roster:${team.rosterId}`);
}

function el(tag, className = "", text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

function svgEl(tag, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

function safeFilename(value) {
  return String(value || "true-league").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "true-league";
}

function downloadUrl(url, filename) {
  const link = el("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function svgStringToPng(svgText, filename) {
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }));
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext("2d");
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim() || "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    URL.revokeObjectURL(url);
    downloadUrl(canvas.toDataURL("image/png"), filename);
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    downloadUrl(URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" })), filename.replace(/\.png$/i, ".svg"));
  };
  image.src = url;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function inlineSvgImages(svg) {
  await Promise.all([...svg.querySelectorAll("image")].map(async (image) => {
    const href = image.getAttribute("href") || image.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    if (!href || href.startsWith("data:")) return;
    try {
      const response = await fetch(href);
      if (!response.ok) return;
      image.setAttribute("href", await blobToDataUrl(await response.blob()));
    } catch {
      // Keep the original href; the PNG export may still work in same-origin browsers.
    }
  }));
}

function truncatedText(value, limit = 145) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function addExportHeader(svg, width, height, header = {}) {
  if (!header.title && !header.subtitle) return { svg, width, height };
  const headerHeight = 74;
  const output = svgEl("svg", { xmlns: "http://www.w3.org/2000/svg", width, height: height + headerHeight, viewBox: `0 0 ${width} ${height + headerHeight}` });
  output.append(svgEl("rect", { x: 0, y: 0, width, height: height + headerHeight, fill: getComputedStyle(document.documentElement).getPropertyValue("--panel").trim() || "#ffffff" }));
  if (header.title) {
    const title = svgEl("text", { x: 56, y: 30, fill: getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() || "#111111", "font-family": "system-ui, sans-serif", "font-size": 22, "font-weight": 800 });
    title.textContent = truncatedText(header.title, 90);
    output.append(title);
  }
  if (header.subtitle) {
    const subtitle = svgEl("text", { x: 56, y: 53, fill: getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#66726a", "font-family": "system-ui, sans-serif", "font-size": 13, "font-weight": 600 });
    subtitle.textContent = truncatedText(header.subtitle);
    output.append(subtitle);
  }
  const group = svgEl("g", { transform: `translate(0 ${headerHeight})` });
  while (svg.firstChild) group.append(svg.firstChild);
  output.append(group);
  return { svg: output, width, height: height + headerHeight };
}

async function exportSvgAsPng(svg, filename, header = {}) {
  const clone = svg.cloneNode(true);
  const box = clone.viewBox?.baseVal;
  const width = box?.width || svg.getBoundingClientRect().width || 980;
  const height = box?.height || svg.getBoundingClientRect().height || 380;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  await inlineSvgImages(clone);
  const style = svgEl("style");
  style.textContent = ".chart-grid{stroke:#d8ded8}.chart-axis-label{fill:#66726a;font:700 11px system-ui}.chart-line{fill:none;stroke-width:3.25;stroke-linecap:round;stroke-linejoin:round}.chart-median{fill:none;stroke:#66726a;stroke-width:2;stroke-dasharray:7 7;opacity:.7}.chart-dot{stroke:#fff;stroke-width:2.5}.owner-trend-avatar{clip-path:circle(50%)}.owner-trend-grave{font:19px system-ui;dominant-baseline:middle}";
  clone.prepend(style);
  const prepared = addExportHeader(clone, width, height, header);
  svgStringToPng(new XMLSerializer().serializeToString(prepared.svg), filename);
}

function exportElementAsPng(element, filename) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll("button").forEach((button) => button.remove());
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
  style.textContent = css;
  wrapper.append(style, clone);
  const serialized = new XMLSerializer().serializeToString(wrapper);
  const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 36}" height="${height + 36}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
  svgStringToPng(svgText, filename);
}

function exportStatbookAsPng(stats, teams, columns) {
  const teamWidth = 170;
  const colWidth = 92;
  const rowHeight = 30;
  const headerHeight = 94;
  const width = teamWidth + (columns.length * colWidth) + 36;
  const height = headerHeight + ((teams.length + 1) * rowHeight) + 30;
  const svg = svgEl("svg", { xmlns: "http://www.w3.org/2000/svg", width, height, viewBox: `0 0 ${width} ${height}` });
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim() || "#ffffff";
  const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() || "#111111";
  const muted = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#66726a";
  const line = getComputedStyle(document.documentElement).getPropertyValue("--line").trim() || "#d8ded8";
  svg.append(svgEl("rect", { width, height, fill: bg }));
  const title = svgEl("text", { x: 18, y: 30, fill: ink, "font-family": "system-ui, sans-serif", "font-size": 22, "font-weight": 800 });
  title.textContent = `Stat book · ${stats.metadata?.season || "Season"}`;
  svg.append(title);
  const subtitle = svgEl("text", { x: 18, y: 54, fill: muted, "font-family": "system-ui, sans-serif", "font-size": 13, "font-weight": 600 });
  subtitle.textContent = truncatedText(`${teams.length} selected teams · Finalized regular-season weeks only`, 130);
  svg.append(subtitle);
  const top = headerHeight;
  svg.append(svgEl("line", { x1: 18, x2: width - 18, y1: top - 16, y2: top - 16, stroke: line }));
  const addText = (text, x, y, options = {}) => {
    const node = svgEl("text", {
      x,
      y,
      fill: options.fill || ink,
      "font-family": "system-ui, sans-serif",
      "font-size": options.size || 12,
      "font-weight": options.weight || 500,
      "text-anchor": options.anchor || "start",
    });
    node.textContent = truncatedText(text, options.limit || 20);
    svg.append(node);
    return node;
  };
  addText("Team", 18, top, { fill: muted, weight: 800, size: 11 });
  columns.forEach((column, index) => addText(column.label, teamWidth + 18 + (index * colWidth) + colWidth - 8, top, { fill: muted, weight: 800, size: 11, anchor: "end", limit: 14 }));
  teams.forEach((team, rowIndex) => {
    const y = top + ((rowIndex + 1) * rowHeight);
    if (rowIndex % 2 === 0) svg.append(svgEl("rect", { x: 12, y: y - 20, width: width - 24, height: rowHeight, fill: "rgba(100,112,106,.06)" }));
    addText(team.teamName, 18, y, { weight: 700, limit: 22 });
    addText(shortOwnerName(team.managerName), 18, y + 13, { fill: muted, size: 10, limit: 24 });
    columns.forEach((column, index) => {
      const rendered = column.format.length > 1 ? column.format(team[column.key], team) : column.format(team[column.key]);
      addText(rendered, teamWidth + 18 + (index * colWidth) + colWidth - 8, y, { anchor: "end", limit: 16 });
    });
  });
  svgStringToPng(new XMLSerializer().serializeToString(svg), `${safeFilename(`statbook-${stats.metadata?.season || "season"}`)}.png`);
}

function exportButton(label, onClick) {
  const button = el("button", "refresh-button export-button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = "Export";
  button.addEventListener("click", onClick);
  return button;
}

function byId(id) {
  return document.getElementById(id);
}

function setEraSwitch(id, era) {
  byId(id).querySelectorAll("button[data-era]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.era === era));
  });
}

function point(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "—";
}

function rank(value) {
  return Number.isFinite(value) ? Number(value).toFixed(1) : "—";
}

function integer(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : "—";
}

function percentage(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function signed(value, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return Number(value).toFixed(digits);
  return `${value > 0 ? "+" : ""}${Number(value).toFixed(digits)}`;
}

function shortOwnerName(name) {
  if (!name) return "Owner";
  return String(name).split(/\s*\/\s*/).map((part) => part.trim().split(/\s+/)[0] || part.trim()).filter(Boolean).join(" / ");
}

function makeOwnerIcon(owner) {
  const src = ownerIconSrc(owner?.id);
  if (!src) return null;
  const portrait = el("img", "owner-icon");
  portrait.src = src;
  portrait.alt = "";
  portrait.width = 32;
  portrait.height = 32;
  portrait.loading = "lazy";
  portrait.decoding = "async";
  portrait.addEventListener("error", () => portrait.remove(), { once: true });
  return portrait;
}

function ownerIconSrc(ownerId) {
  const icon = OWNER_ICONS[ownerId];
  if (!icon) return null;
  const version = OWNER_ICON_VERSIONS[ownerId];
  return `./${icon}${version ? `?v=${version}` : ""}`;
}

function compactOwner(owner) {
  const label = el("span", "owner-icon-label");
  const portrait = makeOwnerIcon(owner);
  if (!portrait) { label.textContent = shortOwnerName(owner.name); label.title = owner.name; return label; }
  label.title = owner.name;
  label.tabIndex = 0;
  portrait.alt = owner.name;
  portrait.addEventListener("error", () => { label.textContent = shortOwnerName(owner.name); }, { once: true });
  label.append(portrait);
  return label;
}

function ownerNameWithTrophies(owner, includeFormer = false) {
  const wrap = el("span", "owner-name-wrap");
  const portrait = makeOwnerIcon(owner);
  if (portrait) wrap.append(portrait);
  wrap.append(document.createTextNode(owner?.name || "Owner career"));
  if (includeFormer && owner && !owner.current) {
    const former = el("span", "owner-former-marker", " 🪦");
    former.title = "Inactive owner";
    former.setAttribute("aria-label", "Inactive owner");
    wrap.append(former);
  }
  const championships = Math.max(0, Number(owner?.championships) || 0);
  if (championships) {
    const trophies = el("span", "owner-trophies", " " + "🏆".repeat(championships));
    trophies.title = `${championships} championship${championships === 1 ? "" : "s"}`;
    trophies.setAttribute("aria-label", `${championships} championship${championships === 1 ? "" : "s"}`);
    wrap.append(trophies);
  }
  return wrap;
}

function rivalryHeaderAvatar(owner) {
  const wrap = el("span", "rivalry-header-avatar");
  wrap.title = owner?.name || "Owner";
  wrap.setAttribute("aria-label", owner?.name || "Owner");
  const portrait = makeOwnerIcon(owner);
  if (portrait) {
    portrait.alt = "";
    wrap.append(portrait);
  } else {
    wrap.append(el("span", "", owner?.name?.slice(0, 2).toUpperCase() || "OW"));
  }
  return wrap;
}

function dateTime(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown time";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function teamInitials(team) {
  const parts = team.teamName.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "TL").toUpperCase();
}

function makeAvatar(team) {
  const avatar = el("span", "team-avatar", teamInitials(team));
  const ownerId = team.canonicalOwnerIds?.find((id) => OWNER_ICONS[id]);
  const imageUrl = ownerIconSrc(ownerId) || team.avatarUrl;
  if (imageUrl) {
    const image = el("img");
    image.src = imageUrl;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => { image.hidden = true; }, { once: true });
    avatar.append(image);
  }
  return avatar;
}

function makeTeamLabel(team) {
  const label = el("span", "team-label");
  const copy = el("span", "team-copy");
  copy.title = `${team.teamName} · ${team.managerName}`;
  const name = el("strong", "", team.teamName);
  const manager = el("span", "", shortOwnerName(team.managerName));
  if (team.record && team.record !== "—") manager.append(" ", el("span", "team-record-inline", `(${team.record})`));
  copy.append(name, manager);
  label.append(makeAvatar(team), copy);
  return label;
}

function emptyState(title, body, mark = "TW") {
  const node = el("div", "empty-state");
  node.append(el("span", "empty-mark", mark), el("h2", "", title), el("p", "", body));
  return node;
}

function compareValue(left, right, direction) {
  const a = left === null || left === undefined ? -Infinity : left;
  const b = right === null || right === undefined ? -Infinity : right;
  let result;
  if (typeof a === "string" || typeof b === "string") result = String(a).localeCompare(String(b));
  else result = a - b;
  return direction === "asc" ? result : -result;
}

function sortedTeams(teams, sort) {
  return [...teams].sort((a, b) => (
    compareValue(a[sort.key], b[sort.key], sort.direction)
    || a.teamName.localeCompare(b.teamName)
  ));
}

function sortButton(label, key, state, onChange) {
  const button = el("button", "sort-button");
  button.type = "button";
  button.dataset.active = String(state.key === key);
  const direction = state.key === key ? state.direction : null;
  button.setAttribute("aria-label", `Sort by ${label}${direction ? `, currently ${direction}ending` : ""}`);
  button.append(el("span", "", label));
  if (direction) button.append(el("span", "", direction === "asc" ? "↑" : "↓"));
  button.addEventListener("click", () => {
    const nextDirection = state.key === key && state.direction === "desc" ? "asc" : "desc";
    onChange({ key, direction: nextDirection });
  });
  return button;
}

function renderHeader(stats, context) {
  const { metadata } = stats;
  byId("brandName").textContent = "TrueWatch";
  byId("brandSeason").textContent = `${metadata.name} · ${metadata.season}`;
  const completed = metadata.completedWeekCount;

  if (stats.liveWeek) {
    byId("statusTitle").textContent = `Week ${stats.liveWeek.week} live`;
    byId("statusDetail").textContent = `${completed} finalized week${completed === 1 ? "" : "s"} included`;
  } else if (!completed) {
    byId("statusTitle").textContent = `Waiting for Week ${metadata.startWeek}`;
    byId("statusDetail").textContent = metadata.seasonStartDate
      ? `Regular season starts ${new Date(`${metadata.seasonStartDate}T00:00:00`).toLocaleDateString(undefined, { month: "long", day: "numeric" })}`
      : "No finalized scores yet";
  } else if (metadata.lastCompletedWeek >= metadata.regularSeasonEnd) {
    byId("statusTitle").textContent = "Regular season complete";
    byId("statusDetail").textContent = `${completed} finalized weeks included`;
  } else {
    byId("statusTitle").textContent = `Through Week ${metadata.lastCompletedWeek}`;
    byId("statusDetail").textContent = `${completed} finalized week${completed === 1 ? "" : "s"} included`;
  }

  byId("dataStatus").classList.toggle("is-stale", Boolean(context.isStale));
  if (context.source === "espn") {
    byId("statusTitle").textContent = "ESPN archive";
    byId("statusDetail").textContent = `${metadata.season} · ${completed} finalized weeks`;
  }
}

function renderNotice(stats, context) {
  const region = byId("noticeRegion");
  region.replaceChildren();
  const messages = [];
  if (context.isStale) messages.push(`Showing saved data from ${dateTime(context.cachedAt)}.`);
  else if (context.fromCache) messages.push(`Showing a recent local update from ${dateTime(context.cachedAt)}.`);
  messages.push(...(context.warnings || stats.warnings));
  if (!messages.length) return;

  const notice = el("div", "notice");
  const copy = el("div");
  copy.append(el("strong", "", context.isStale ? "Saved data" : "Heads up"), document.createTextNode(messages.join(" ")));
  const close = el("button", "", "Dismiss");
  close.type = "button";
  close.addEventListener("click", () => notice.remove());
  notice.append(copy, close);
  region.append(notice);
}

export function renderLiveWeek(stats, context) {
  renderHeader(stats, context);
  renderNotice(stats, context);
  renderLiveScores(stats, context, makeAvatar, refreshHandler);
}

function renderTrendControls(stats) {
  const root = byId("trendControls");
  root.replaceChildren();
  stats.teams.forEach((team) => {
    const id = trendOwnerId(team);
    const label = el("label", "trend-owner-key");
    const style = ownerLineStyle(team);
    label.style.setProperty("--team-color", style.color);
    label.title = team.managerName;
    const input = el("input");
    input.type = "checkbox";
    input.checked = !trendHiddenOwners.has(id);
    input.addEventListener("change", () => {
      if (input.checked) trendHiddenOwners.delete(id);
      else trendHiddenOwners.add(id);
      renderTrend(stats);
    });
    const swatch = svgEl("svg", { width: 28, height: 12, "aria-hidden": "true" });
    swatch.append(svgEl("line", { x1: 0, x2: 28, y1: 6, y2: 6, stroke: style.color, "stroke-width": 3, "stroke-dasharray": style.dash }));
    label.append(input, swatch, compactOwner({ id: team.canonicalOwnerIds?.length === 1 ? team.canonicalOwnerIds[0] : null, name: team.managerName }));
    root.append(label);
  });
}

function renderTrendChart(stats) {
  const root = byId("trendChart");
  root.replaceChildren();
  if (!stats.weeks.length) {
    root.append(emptyState("No finalized trends yet", "The chart will begin with the first finalized regular-season week.", "01"));
    return;
  }

  const series = stats.teams.filter((team) => !trendHiddenOwners.has(trendOwnerId(team))).map((team) => {
    let total = 0;
    const points = stats.weeks.map((week, index) => {
      const score = week.entries.find((entry) => entry.rosterId === team.rosterId)?.score;
      if (!Number.isFinite(score) || !Number.isFinite(week.leagueMedian)) return null;
      total += score - week.leagueMedian;
      return { week: week.week, index, score: total };
    }).filter(Boolean);
    return { team, points };
  });
  if (!series.length) {
    root.append(emptyState("No teams selected", "Use the owner filters above the chart to add teams back.", "–"));
    return;
  }
  const values = series.flatMap(({ points }) => points.map((entry) => entry.score));
  let yMin = Math.floor((Math.min(0, ...values) - 10) / 25) * 25;
  let yMax = Math.ceil((Math.max(0, ...values) + 10) / 25) * 25;
  if (yMin === yMax) { yMin -= 10; yMax += 10; }

  const width = 980;
  const height = 360;
  const margin = { top: 20, right: 24, bottom: 46, left: 56 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (index) => margin.left + (stats.weeks.length === 1 ? plotWidth / 2 : (index / (stats.weeks.length - 1)) * plotWidth);
  const y = (value) => margin.top + ((yMax - value) / (yMax - yMin)) * plotHeight;

  const wrap = el("div", "chart-wrap");
  const svg = svgEl("svg", {
    class: "trend-svg",
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-labelledby": "trendSvgTitle trendSvgDesc",
  });
  svg.append(svgEl("title", { id: "trendSvgTitle" }), svgEl("desc", { id: "trendSvgDesc" }));
  svg.querySelector("title").textContent = "Cumulative score versus median by owner";
  svg.querySelector("desc").textContent = "Each line sums an owner's weekly score minus that week's league median across finalized regular-season weeks. Above zero means cumulatively above median; below zero means below median. Live scores are excluded.";

  for (let step = 0; step <= 4; step += 1) {
    const value = yMin + ((yMax - yMin) * step / 4);
    const yPosition = y(value);
    svg.append(svgEl("line", { class: "chart-grid", x1: margin.left, x2: width - margin.right, y1: yPosition, y2: yPosition }));
    const label = svgEl("text", { class: "chart-axis-label", x: margin.left - 10, y: yPosition + 4, "text-anchor": "end" });
    label.textContent = Math.round(value);
    svg.append(label);
  }
  stats.weeks.forEach((week, index) => {
    const label = svgEl("text", { class: "chart-axis-label", x: x(index), y: height - 15, "text-anchor": "middle" });
    label.textContent = `W${week.week}`;
    svg.append(label);
  });

  svg.append(svgEl("line", { class: "chart-median", x1: margin.left, x2: width - margin.right, y1: y(0), y2: y(0), "aria-label": "Zero cumulative difference from weekly medians" }));
  series.forEach(({ team, points }) => {
    const { color, dash } = ownerLineStyle(team);
    const path = points.map((entry, index) => `${index ? "L" : "M"}${x(entry.index)},${y(entry.score)}`).join(" ");
    const ownerId = trendOwnerId(team);
    svg.append(svgEl("path", { class: "chart-line", d: path, stroke: color, "stroke-dasharray": dash, "data-owner": ownerId }));
    points.forEach((entry) => {
      const description = `${shortOwnerName(team.managerName)}, through Week ${entry.week}: ${signed(entry.score)} cumulative vs median`;
      const dot = svgEl("circle", { class: "chart-dot", cx: x(entry.index), cy: y(entry.score), r: 5, fill: color, tabindex: 0, "aria-label": description });
      const title = svgEl("title");
      title.textContent = description;
      dot.append(title);
      svg.append(dot);
    });
    const last = points.at(-1);
    if (!last) return;
    const cx = x(last.index);
    const cy = y(last.score);
    const src = ownerIconSrc(ownerId);
    const label = `${shortOwnerName(team.managerName)}: ${signed(last.score)} cumulative vs median`;
    if (src) {
      const image = svgEl("image", { class: "owner-trend-avatar", href: src, x: cx - 12, y: cy - 12, width: 24, height: 24, tabindex: 0, "aria-label": label });
      const title = svgEl("title");
      title.textContent = label;
      image.append(title);
      svg.append(image);
    } else {
      const grave = svgEl("text", { class: "owner-trend-grave", x: cx, y: cy + 6, "text-anchor": "middle", tabindex: 0, "aria-label": label });
      grave.textContent = "🪦";
      const title = svgEl("title");
      title.textContent = label;
      grave.append(title);
      svg.append(grave);
    }
  });
  const selectedTeams = series.map(({ team }) => `${team.teamName} (${shortOwnerName(team.managerName)})`).join(", ");
  const weekRange = stats.weeks.length ? `Weeks ${stats.weeks[0].week}-${stats.weeks.at(-1).week}` : "No finalized weeks";
  wrap.append(
    exportButton("Export chart", () => exportSvgAsPng(svg, `${safeFilename(`trends-${stats.metadata?.season || "season"}`)}.png`, {
      title: `Cumulative vs median · ${stats.metadata?.season || "Season"}`,
      subtitle: `${weekRange} · Teams: ${selectedTeams}`,
    })),
    svg,
    el("p", "chart-legend-note", "Selected owners · Running sum of score minus each week’s median · Above zero means cumulatively above median · Finalized weeks only"),
  );
  root.append(wrap);
}

function renderTrend(stats) {
  renderTrendControls(stats);
  renderTrendChart(stats);
}

function renderMatrixControls(stats) {
  const root = byId("matrixControls");
  root.replaceChildren();
  [
    ["score", "Scores"],
    ["delta", "Vs median"],
    ["rank", "Rank"],
  ].forEach(([mode, label]) => {
    const button = el("button", "segment-button", label);
    button.type = "button";
    button.setAttribute("aria-pressed", String(uiState.matrixMode === mode));
    button.addEventListener("click", () => {
      uiState.matrixMode = mode;
      renderMatrix(stats);
    });
    root.append(button);
  });
}

function matrixValue(mode, entry) {
  if (!entry) return "—";
  if (mode === "delta") return signed(entry.deltaMedian);
  if (mode === "rank") return integer(entry.rank);
  return point(entry.score);
}

function renderMatrixTable(stats) {
  const root = byId("matrixTable");
  root.replaceChildren();
  const weekNumbers = [];
  for (let week = stats.metadata.startWeek; week <= stats.metadata.regularSeasonEnd; week += 1) {
    weekNumbers.push(week);
  }
  const weeksByNumber = new Map(stats.weeks.map((week) => [week.week, week]));
  if (stats.liveWeek) weeksByNumber.set(stats.liveWeek.week, stats.liveWeek);
  const seasonScores = stats.weeks.flatMap((week) => week.entries.map((entry) => entry.score)).filter(Number.isFinite);
  const seasonMin = Math.min(...seasonScores);
  const seasonMax = Math.max(...seasonScores);
  const table = el("table", "data-table matrix-table");
  table.append(el("caption", "visually-hidden", `${uiState.matrixMode} by team for every regular-season week`));
  const thead = el("thead");
  const head = el("tr");
  const teamHead = el("th", "", "Team");
  teamHead.scope = "col";
  head.append(teamHead);
  weekNumbers.forEach((weekNumber) => {
    const week = weeksByNumber.get(weekNumber);
    const th = el("th", week?.status === "live" ? "matrix-live-head" : week ? "" : "matrix-future", `W${weekNumber}`);
    th.scope = "col";
    if (week?.status === "live") {
      th.append(el("span", "matrix-live-label", "Live"));
      th.title = "Provisional scores; excluded from season totals";
    }
    head.append(th);
  });
  const summaryLabel = uiState.matrixMode === "score" ? "Average" : uiState.matrixMode === "delta" ? "Avg ±" : "Avg rank";
  const summaryHead = el("th", "", summaryLabel);
  summaryHead.scope = "col";
  head.append(summaryHead);
  const totalHead = el("th", "", "Total PF");
  totalHead.scope = "col";
  totalHead.title = "Total points for across finalized regular-season weeks; live scores excluded";
  head.append(totalHead);
  thead.append(head);

  const tbody = el("tbody");
  sortedTeams(stats.teams, { key: "total", direction: "desc" }).forEach((team) => {
    const row = el("tr");
    if (highlightedOwner && team.canonicalOwnerIds?.includes(highlightedOwner)) row.className = "owner-highlight";
    const identity = el("td");
    identity.append(makeTeamLabel(team));
    row.append(identity);
    weekNumbers.forEach((weekNumber) => {
      const week = weeksByNumber.get(weekNumber);
      const entry = week?.entries.find((candidate) => candidate.rosterId === team.rosterId);
      const classNames = [
        week?.status === "live" ? "matrix-live-cell" : "",
        week ? "" : "matrix-future",
      ].filter(Boolean).join(" ");
      const cell = el("td", classNames, matrixValue(uiState.matrixMode, entry));
      if (week?.status === "live") cell.title = "Provisional; excluded from season aggregates and color scale";
      if (entry && week.status !== "live" && Number.isFinite(entry.score)) {
        const intensity = seasonMax === seasonMin ? 0.5 : (entry.score - seasonMin) / (seasonMax - seasonMin);
        cell.classList.add("matrix-scored");
        cell.style.setProperty("--score-color", intensity < 0.5 ? "var(--score-low)" : "var(--score-high)");
        cell.style.setProperty("--score-shade", `${(Math.abs(intensity - 0.5) * 60).toFixed(2)}%`);
        const aboveMedian = entry.score > week.leagueMedian;
        if (aboveMedian) {
          cell.classList.add("matrix-above-median");
          const marker = el("span", "matrix-median-marker", "▲");
          marker.setAttribute("aria-hidden", "true");
          cell.append(marker, el("span", "visually-hidden", "; above weekly median"));
        }
        const resultLabel = entry.outcome === "win" ? "Won matchup" : entry.outcome === "loss" ? "Lost matchup" : entry.outcome === "tie" ? "Tied matchup" : "";
        if (week.status !== "live" && ["win", "loss"].includes(entry.outcome)) {
          const result = el("span", `matrix-result-marker matrix-result-${entry.outcome}`, entry.outcome === "win" ? "✅" : "❌");
          result.setAttribute("aria-hidden", "true");
          cell.append(result, el("span", "visually-hidden", `; ${resultLabel}`));
        }
        cell.title = `Score ${point(entry.score)} · Weekly median ${point(week.leagueMedian)}${aboveMedian ? " · Above median" : ""}${resultLabel ? ` · ${resultLabel}` : ""}${week.status === "live" ? " · Provisional; excluded from aggregates" : ""}`;
      }
      if (uiState.matrixMode === "score" && Number.isFinite(entry?.score) && Number.isFinite(entry?.rank)) {
        cell.classList.add("matrix-ranked");
        const badge = el("span", "matrix-rank", `${entry.rank}`);
        badge.setAttribute("aria-hidden", "true");
        cell.append(badge, el("span", "visually-hidden", `; weekly points rank ${entry.rank}${week.status === "live" ? ", provisional" : ""}`));
        cell.title += ` · Weekly points rank ${entry.rank}`;
      }
      row.append(cell);
    });
    const summary = uiState.matrixMode === "score"
      ? point(team.average)
      : uiState.matrixMode === "delta"
        ? signed(team.averageDeltaMedian)
        : rank(team.averageRank);
    row.append(el("td", "", summary));
    row.append(el("td", "", point(team.total)));
    tbody.append(row);
  });

  const tfoot = el("tfoot");
  if (uiState.matrixMode !== "rank") {
    const rows = uiState.matrixMode === "score"
      ? [
          ["League average", (week) => point(week.leagueAverage), point(stats.league.weeklyAverageMean)],
          ["League median", (week) => point(week.leagueMedian), point(stats.league.medianOfWeeklyMedians)],
        ]
      : [
          ["Mean delta", (week) => signed((week.entries.reduce((total, entry) => total + entry.deltaMedian, 0) / week.entries.length)), signed(stats.league.meanDeltaMedian)],
          ["Median delta", () => point(0), signed(stats.league.medianDeltaMedian)],
        ];
    rows.forEach(([label, formatter, summary]) => {
      const row = el("tr");
      const th = el("th", "", label);
      th.scope = "row";
      row.append(th);
      weekNumbers.forEach((weekNumber) => {
        const week = weeksByNumber.get(weekNumber);
        const cell = el("td", week?.status === "live" ? "matrix-live-cell" : week ? "" : "matrix-future", week ? formatter(week) : "—");
        row.append(cell);
      });
      row.append(el("td", "", summary));
      row.append(el("td", "", "—"));
      tfoot.append(row);
    });
  }
  table.append(thead, tbody, tfoot);
  root.append(table);
}

function renderMatrix(stats) {
  renderMatrixControls(stats);
  renderMatrixTable(stats);
}

function renderWeekly(stats) {
  renderTrend(stats);
}

function renderBenchmarks(stats) {
  const root = byId("leagueBenchmarks");
  root.replaceChildren();
  const scoreEntries = stats.weeks.flatMap((week) => week.entries.filter((entry) => Number.isFinite(entry.score)));
  const scores = scoreEntries.map((entry) => entry.score);
  const seasonHigh = scoreEntries.reduce((best, entry) => !best || entry.score > best.score ? entry : best, null);
  const seasonLow = scoreEntries.reduce((worst, entry) => !worst || entry.score < worst.score ? entry : worst, null);
  const metrics = [
    ["Total mean", point(stats.league.overallMean)],
    ["Total median", point(stats.league.overallMedian)],
    ["Total deviation", point(stats.league.scoreDeviation)],
    ["Median weekly median", point(stats.league.medianOfWeeklyMedians)],
    ["Mean pts > median", signed(stats.league.meanDeltaMedian)],
    ["Season high", point(seasonHigh?.score), seasonHigh],
    ["Mean pts deviation", point(stats.league.deltaDeviation)],
    ["Season low", point(seasonLow?.score), seasonLow],
  ];
  metrics.forEach(([label, value, entry]) => {
    const card = el("article", "benchmark");
    card.append(el("span", "", label));
    const valueRow = el("div", "benchmark-value-row");
    valueRow.append(el("strong", "", value));
    if (entry?.team) valueRow.append(compactOwner({ id: entry.team.canonicalOwnerIds?.[0], name: entry.team.managerName }));
    card.append(valueRow);
    root.append(card);
  });
}

function statbookColumns() {
  return [
    { group: "Scoring", label: "Total", key: "total", format: point, color: "range", help: "Total points across finalized regular-season weeks; live scores are excluded." },
    { group: "Scoring", label: "Average", key: "average", format: point, color: "range", help: "Total points divided by finalized weeks." },
    { group: "Scoring", label: "Score SD", key: "scoreDeviation", format: point, color: "inverse", help: "Sample standard deviation of weekly scores. Lower means more consistent scoring; unavailable with fewer than two weeks." },
    { group: "Records", label: "W/L", key: "winPct", format: (_, team) => team.record, help: "Regular-season matchup record through finalized weeks." },
    { group: "Records", label: "Median", key: "medianWinPct", format: (_, team) => team.medianRecord, help: "Weekly median record: a win above the league median, a loss below it, and a tie at the median." },
    { group: "Records", label: "Lucky/Unlucky", key: "luckyWins", format: (_, team) => `${integer(team.luckyWins)} / ${integer(team.unluckyLosses)}`, help: "Lucky wins while scoring below that week's league median, slash unlucky losses while scoring above it." },
    { group: "Median", label: "Win %", key: "medianWinPct", format: percentage, color: "percent", help: "Median wins plus half of median ties, divided by finalized weeks." },
    { group: "Median", label: "Avg ±", key: "averageDeltaMedian", format: signed, color: "zero", help: "Average weekly score minus that week's league median." },
    { group: "Median", label: "Good/Avg/Bad", key: "greatWeeks", format: (_, team) => `${integer(team.greatWeeks)} / ${integer(team.averageWeeks)} / ${integer(team.badWeeks)}`, help: "Weeks above, within, and below one weekly sample standard deviation from the league median." },
    { group: "Rank", label: "Average", key: "averageRank", format: rank, color: "inverse", help: "Average weekly points rank. Highest score ranks first; tied scores share a competition rank." },
    { group: "Rank", label: "SD", key: "rankDeviation", format: point, color: "inverse", help: "Sample standard deviation of weekly points ranks. Lower means steadier placement; requires at least two weeks." },
  ];
}

function renderStatbookFilter(stats) {
  const controls = el("div", "team-filter statbook-filter");
  stats.teams.forEach((team) => {
    const id = trendOwnerId(team);
    const style = ownerLineStyle(team);
    const label = el("label", "trend-owner-key");
    label.style.setProperty("--team-color", style.color);
    label.title = team.managerName;
    const input = el("input");
    input.type = "checkbox";
    input.checked = !statbookHiddenTeams.has(id);
    input.addEventListener("change", () => {
      if (input.checked) statbookHiddenTeams.delete(id);
      else statbookHiddenTeams.add(id);
      renderStatbookTable(stats);
    });
    label.append(input, compactOwner({ id: team.canonicalOwnerIds?.length === 1 ? team.canonicalOwnerIds[0] : null, name: team.managerName }));
    controls.append(label);
  });
  return controls;
}

function renderStatbookTable(stats) {
  const root = byId("statbookTable");
  root.replaceChildren();
  const columns = statbookColumns();
  const table = el("table", "data-table statbook-table");
  table.append(el("caption", "visually-hidden", "Complete True League scoring statistics"));
  const thead = el("thead");
  const groupRow = el("tr");
  const teamHead = el("th", "group-head", "Team");
  teamHead.scope = "col";
  teamHead.rowSpan = 2;
  groupRow.append(teamHead);
  ["Scoring", "Records", "Median", "Rank"].forEach((group) => {
    const th = el("th", "group-head", group);
    th.scope = "colgroup";
    th.colSpan = columns.filter((column) => column.group === group).length;
    groupRow.append(th);
  });
  const labelRow = el("tr");
  columns.forEach((column) => {
    const th = el("th");
    th.scope = "col";
    const button = sortButton(column.label, column.key, uiState.statSort, (sort) => {
      uiState.statSort = sort;
      renderStatbookTable(stats);
    });
    button.title = column.help;
    const help = el("span", "visually-hidden", column.help);
    help.id = `statbook-help-${column.group}-${column.label.replace(/[^a-z0-9]+/gi, "-")}`;
    button.setAttribute("aria-describedby", help.id);
    th.append(button, help);
    labelRow.append(th);
  });
  thead.append(groupRow, labelRow);
  const tbody = el("tbody");
  const visibleTeams = sortedTeams(stats.teams, uiState.statSort).filter((team) => !statbookHiddenTeams.has(trendOwnerId(team)));
  visibleTeams.forEach((team) => {
    const row = el("tr");
    const identity = el("td");
    identity.append(makeTeamLabel(team));
    row.append(identity);
    columns.forEach((column) => {
      const cell = el("td");
      const rendered = column.format.length > 1 ? column.format(team[column.key], team) : column.format(team[column.key]);
      if (column.key === "averageDeltaMedian") cell.className = team[column.key] > 0 ? "positive" : team[column.key] < 0 ? "negative" : "";
      if (column.group === "Records") cell.append(el("span", "record-pill", rendered));
      else cell.textContent = rendered;
      colorPerformance(cell, team[column.key], column, stats.teams);
      row.append(cell);
    });
    tbody.append(row);
  });
  table.append(thead, tbody);
  const actions = el("div", "table-actions");
  actions.append(renderStatbookFilter(stats), exportButton("Export Stat book", () => exportStatbookAsPng(stats, visibleTeams, columns)));
  root.append(actions, table);
}


function renderStatbook(stats) {
  renderBenchmarks(stats);
  renderStatbookTable(stats);
}

export function initializeUi({ onRefresh, onSeasonChange = () => {}, onOwnerEraChange = () => {}, onTabChange = () => {}, onRecordsEraChange = () => {}, onRivalryChange = () => {} }) {
  refreshHandler = onRefresh;
  seasonHandler = onSeasonChange;
  tabHandler = onTabChange;
  byId("recordsEra").addEventListener("change", (event) => onRecordsEraChange(event.target.value));
  byId("recordsEraSwitch").querySelectorAll("button[data-era]").forEach((button) => {
    button.addEventListener("click", () => onRecordsEraChange(button.dataset.era));
  });
  const changeRivalry = (stage = rivalry.stage) => onRivalryChange({ era: byId("h2hEra").value, stage, ownerA: byId("h2hOwnerA").value, ownerB: byId("h2hOwnerB").value });
  for (const id of ["h2hEra", "h2hOwnerA", "h2hOwnerB"]) byId(id).addEventListener("change", () => changeRivalry());
  byId("h2hEraSwitch").querySelectorAll("button[data-era]").forEach((button) => {
    button.addEventListener("click", () => onRivalryChange({ era: button.dataset.era, stage: rivalry.stage, ownerA: byId("h2hOwnerA").value, ownerB: byId("h2hOwnerB").value }));
  });
  byId("h2hStageControls").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => changeRivalry(button.dataset.stage)));
  byId("seasonSelect").addEventListener("change", (event) => seasonHandler(event.target.value));
  byId("seasonButtons").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-season]");
    if (!button) return;
    seasonHandler(button.dataset.season);
  });
  byId("currentOwnersOnly").addEventListener("change", () => renderOwners(ownerData));
  byId("ownerEra").addEventListener("change", (event) => onOwnerEraChange(event.target.value));
  byId("ownerEraSwitch").querySelectorAll("button[data-era]").forEach((button) => {
    button.addEventListener("click", () => onOwnerEraChange(button.dataset.era));
  });
  byId("refreshButton").addEventListener("click", refreshHandler);
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.forEach((tab) => {
    tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('[role="tab"]')].filter((item) => !item.hidden);
      const index = tabs.indexOf(tab);
      let next = index;
      if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      tabs[next].focus();
      activateTab(tabs[next]);
    });
  });
}

function activateTab(activeTab, notify = true) {
  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    const active = tab === activeTab;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    byId(tab.dataset.view).hidden = !active;
  });
  if (notify) tabHandler(Object.keys(TAB_IDS).find((key) => TAB_IDS[key] === activeTab.id));
}

const TAB_IDS = { scoreboard: "overviewTab", live: "liveTab", trends: "weeklyTab", statbook: "statbookTab", owners: "ownersTab", records: "recordsTab", "head-to-head": "headToHeadTab", draft: "draftTab" };
export function selectTab(name) {
  const tab = byId(TAB_IDS[name] || "overviewTab");
  activateTab(tab.hidden ? byId("overviewTab") : tab, false);
}

export function setRefreshState(isLoading) {
  setLiveBusy(isLoading);
  const button = byId("refreshButton");
  button.disabled = isLoading;
  button.setAttribute("aria-busy", String(isLoading));
  button.setAttribute("aria-label", isLoading ? "Checking Sleeper" : "Refresh data");
  const icon = globalThis.lucide ? globalThis.lucide.createElement(globalThis.lucide.RefreshCw) : el("span", "", "↻");
  icon.setAttribute("class", "refresh-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("width", "18");
  icon.setAttribute("height", "18");
  button.replaceChildren(icon, el("span", "refresh-label", isLoading ? "Checking Sleeper…" : "Refresh data"));
}

function renderDraftBoard(board) {
  const root = byId("draftBoard");
  root.replaceChildren();
  byId("draftSummary").textContent = board ? `${board.season} · ${board.type} draft · ${board.rounds} rounds · ${board.picks.length} picks · ${board.status === "complete" ? "Complete" : "In progress / scheduled"}${board.stale ? " · Saved draft; latest update unavailable" : ""}` : "";
  if (!board) {
    root.append(emptyState("Draft unavailable", "Draft picks will appear here when available from Sleeper."));
    return;
  }
  const table = el("table", "data-table draft-table");
  const caption = el("caption", "visually-hidden", "Draft recap: rounds down the rows, managers in draft order across the columns.");
  const head = el("thead");
  const headers = el("tr");
  for (const label of ["Round", ...board.columns.map((column) => column.managerName)]) {
    const th = el("th", "", label);
    th.scope = "col";
    headers.append(th);
  }
  head.append(headers);
  const body = el("tbody");
  const picks = new Map(board.picks.map((pick) => [`${pick.round}/${pick.slot}`, pick]));
  for (let round = 1; round <= board.rounds; round++) {
    const row = el("tr");
    const label = el("th", "", String(round));
    label.scope = "row";
    row.append(label);
    for (const column of board.columns) {
      const pick = picks.get(`${round}/${column.slot}`);
      const cell = el("td");
      if (pick) {
        cell.title = `Pick ${pick.pickNo}: ${pick.fullName || pick.lastName}`;
        cell.append(el("span", "draft-pick-number", `#${pick.pickNo}`), el("strong", "draft-player", pick.lastName), el("small", "draft-player-meta", [pick.position, pick.nflTeam].filter(Boolean).join(" · ")));
      } else cell.append(el("span", "", "—"));
      row.append(cell);
    }
    body.append(row);
  }
  table.append(caption, head, body);
  root.append(table);
}

export function renderLoading() {
  byId("seasonRecap").replaceChildren();
  byId("trendChart").replaceChildren(el("p", "section-note", "Loading season…"));
  byId("trendControls").replaceChildren();
  byId("statbookTable").replaceChildren();
  byId("leagueBenchmarks").replaceChildren();
  byId("draftBoard").replaceChildren(el("p", "section-note", "Loading draft…"));
  byId("liveWeekRegion").replaceChildren(el("p", "section-note", "Loading matchups…"));
  byId("matrixControls").replaceChildren();
  byId("matrixTable").replaceChildren(emptyState("Loading weekly scores", "Loading selected season.", "↻"));
}

export function renderError(error) {
  byId("trendChart").replaceChildren(emptyState("Season unavailable", "Choose another season or retry."));
  byId("statbookTable").replaceChildren(emptyState("Season unavailable", "Choose another season or retry."));
  renderDraftBoard(null);
  byId("liveWeekRegion").replaceChildren(emptyState("Matchups unavailable", "Use Refresh to try again."));
  byId("noticeRegion").replaceChildren();
  byId("statusTitle").textContent = "Season unavailable";
  byId("statusDetail").textContent = "No saved league data is available";
  byId("matrixControls").replaceChildren();
  byId("matrixTable").replaceChildren(emptyState("Scores unavailable", error?.message || "Sleeper data could not be loaded.", "!"));
  const panel = el("section", "panel error-panel");
  panel.append(el("h2", "", "Could not load league statistics"), el("p", "", error?.message || "Sleeper data could not be loaded."));
  const retry = el("button", "primary-button", "Try again");
  retry.type = "button";
  retry.addEventListener("click", () => seasonHandler(byId("seasonSelect").value));
  panel.append(retry);
  byId("matrixTable").replaceChildren(panel);
}

export function renderDashboard(stats, context = {}) {
  byId("seasonRange").textContent = `Regular season · Weeks ${stats.metadata.startWeek}–${stats.metadata.regularSeasonEnd} · ${stats.metadata.teamCount} teams`;
  renderRecap(context);
  renderMatrix(stats);
  renderWeekly(stats);
  renderLiveWeek(stats, context);
  renderDraftBoard(context.draftBoard);
  renderStatbook(stats);
  if (highlightedOwner) byId("matrixTable").querySelector(".owner-highlight")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function renderSeasons(catalog, selected) {
  const select = byId("seasonSelect");
  const buttons = byId("seasonButtons");
  select.replaceChildren(...catalog.seasons.map((season) => {
    const option = el("option", "", `${season.season} · ${season.current ? "Current" : "ESPN"}`);
    option.value = season.season;
    return option;
  }));
  buttons.replaceChildren(...catalog.seasons.map((season) => {
    const button = el("button", "season-button");
    button.type = "button";
    button.dataset.season = season.season;
    button.setAttribute("aria-pressed", String(season.season === selected));
    button.append(el("span", "", season.season));
    if (season.current) button.append(el("small", "", "Current"));
    return button;
  }));
  if (![...select.options].some((option) => option.value === selected)) {
    const unknown = el("option", "", `${selected} · Unavailable`);
    unknown.value = selected;
    select.append(unknown);
    const button = el("button", "season-button");
    button.type = "button";
    button.dataset.season = selected;
    button.setAttribute("aria-pressed", "true");
    button.append(el("span", "", selected), el("small", "", "Unavailable"));
    buttons.append(button);
  }
  select.value = selected;
}

export function prepareSeason(year, archived, ownerId, notify = true) {
  byId("seasonSelect").value = year;
  byId("seasonButtons").querySelectorAll("button[data-season]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.season === year));
  });
  byId("brandSeason").textContent = `True League · ${year}`;
  highlightedOwner = ownerId;
  byId("refreshButton").hidden = archived;
  const active = document.querySelector('[role="tab"][aria-selected="true"]');
  for (const id of ["liveTab", "draftTab"]) byId(id).hidden = archived;
  if (ownerId || active?.hidden) activateTab(byId("overviewTab"), notify);
  byId("noticeRegion").replaceChildren();
}

function simpleTable(headers, rows, captionText) {
  const wrap = el("div", "table-scroll");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", captionText);
  const table = el("table", "data-table history-table");
  table.append(el("caption", "visually-hidden", captionText));
  const head = el("thead");
  const heading = el("tr");
  headers.forEach((label) => { const th = el("th", "", label); th.scope = "col"; heading.append(th); });
  head.append(heading);
  const body = el("tbody");
  rows.forEach((values) => {
    const row = el("tr");
    values.forEach((value, index) => {
      const cell = el(index === 0 ? "th" : "td");
      if (index === 0) cell.scope = "row";
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value;
      row.append(cell);
    });
    body.append(row);
  });
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

const recordText = (row) => `${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ""}`;

function renderRecap(context) {
  const root = byId("seasonRecap");
  root.replaceChildren();
  if (!context.recap) return;
  const section = el("section", "panel section-panel archive-recap");
  const champion = context.recap.standings.find((row) => row.isChampion);
  section.append(el("h2", "", champion ? `Champion · ${champion.managerName}` : "Season recap"));
  if (champion) section.append(el("p", "section-note", champion.teamName));
  const details = el("details");
  details.append(el("summary", "", "Final standings"));
  details.append(el("p", "section-note", "Finish is ESPN's source finishing position; the championship designation includes league corrections. PF and PA below are ESPN standings totals."));
  details.append(simpleTable(["Team / owner", "ESPN finish", "Record", "PF", "PA"], [...context.recap.standings].sort((a, b) => a.finalRank - b.finalRank).map((row) => {
    const team = el("span");
    team.append(el("strong", "starter-name", row.teamName), el("small", "starter-meta", row.managerName));
    return [team, row.finalRank, recordText(row), point(row.pointsFor), point(row.pointsAgainst)];
  }), "Archived final standings"));
  details.append(el("p", "section-note", context.provenance?.precisionNote || ""));
  section.append(details);
  root.append(section);
}

export function prepareOwnerEra(era) {
  ownerEra = era;
  byId("ownerEra").value = era;
  setEraSwitch("ownerEraSwitch", era);
  ownerData = ownerCache.get(era) || null;
  byId("ownerEraSummary").textContent = era === "ten-team" ? "10-team seasons only" : "All seasons";
  if (ownerData) renderOwners(ownerData);
  else byId("ownersContent").replaceChildren(el("p", "section-note", "Loading career data…"));
  byId("ownersStatus").textContent = "Updating career data…";
}

function colorPerformance(cell, value, column, rows) {
  if (!column.color || !Number.isFinite(value)) return;
  const values = rows.map((row) => row[column.key]).filter(Number.isFinite);
  let balance = 0;
  if (column.color === "percent") balance = (value - 0.5) * 2;
  else if (column.color === "zero") {
    const bound = Math.max(...values.map(Math.abs), 0);
    balance = bound ? value / bound : 0;
  } else {
    const min = Math.min(...values), max = Math.max(...values);
    balance = max > min ? (value - min) / (max - min) * 2 - 1 : 0;
    if (column.color === "inverse") balance *= -1;
  }
  balance = Math.max(-1, Math.min(1, balance));
  cell.classList.add("career-colored");
  cell.style.setProperty("--score-color", balance < 0 ? "var(--score-low)" : "var(--score-high)");
  cell.style.setProperty("--score-shade", `${(Math.abs(balance) * 30).toFixed(2)}%`);
}

function playoffTimeline(owner, seasons) {
  const wrap = el("span", "playoff-timeline");
  const rowsBySeason = new Map((owner.seasons || []).map((row) => [row.season, row]));
  for (const season of [...seasons].sort((a, b) => Number(a.season) - Number(b.season))) {
    const row = rowsBySeason.get(season.season);
    const known = row?.postseasonAppearance != null;
    const mark = !row || !known ? "—" : row.postseasonAppearance ? "✅" : "❌";
    const item = el("span", known && row.postseasonAppearance ? "made-playoffs" : known ? "missed-playoffs" : "unknown-playoffs", mark);
    item.title = `${season.season}: ${!row ? "no qualifying season" : !known ? "postseason not available" : row.postseasonAppearance ? "playoff appearance" : "missed playoffs"}`;
    wrap.append(item);
  }
  wrap.setAttribute("aria-label", [...wrap.children].map((item) => item.title).join("; "));
  return wrap;
}

function metricRank(row, rows, metric) {
  const key = metric.rankKey || metric.key;
  const value = row[key];
  if (!Number.isFinite(value)) return "Unranked";
  const values = rows.map((item) => item[key]).filter(Number.isFinite).sort((a, b) => (
    metric.color === "inverse" ? a - b : b - a
  ));
  const rank = values.findIndex((candidate) => candidate === value) + 1;
  return rank ? `#${rank} of ${values.length}` : "Unranked";
}

function seasonRange(seasons) {
  const years = seasons.map((item) => Number(item.season)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!years.length) return "No seasons";
  const short = (year) => `'${String(year).slice(-2)}`;
  return years.length === 1 ? short(years[0]) : `${short(years[0])}-${short(years.at(-1))}`;
}

function seasonPointsRank(row, owners) {
  const values = owners.flatMap((owner) => owner.seasons || [])
    .filter((season) => season.season === row.season && Number.isFinite(season.pointsFor))
    .map((season) => season.pointsFor)
    .sort((a, b) => b - a);
  const rank = values.findIndex((value) => value === row.pointsFor) + 1;
  return rank ? `#${rank}` : "—";
}

function ownerSeasonTimeline(owner, owners) {
  const timeline = el("div", "owner-season-timeline");
  timeline.setAttribute("aria-label", `${owner.name} season timeline`);
  for (const row of [...owner.seasons].sort((a, b) => Number(a.season) - Number(b.season))) {
    const rankText = seasonPointsRank(row, owners);
    const tile = el("span", `owner-season-tile${row.champion ? " champion-season" : row.postseasonAppearance ? " playoff-season" : ""}`);
    const year = el("span", "owner-season-year", `'${String(row.season).slice(-2)}`);
    const result = row.champion ? "🏆" : row.postseasonAppearance ? "✓" : row.postseasonAppearance === false ? "×" : "—";
    tile.append(year, el("strong", "", result), el("small", "", `PF ${rankText}`));
    tile.title = `${row.season}: ${row.teamName} · ${recordText(row)} · PF ${point(row.pointsFor)} (${rankText})${row.champion ? " · Champion" : row.postseasonAppearance ? " · Playoffs" : row.postseasonAppearance === false ? " · Missed playoffs" : ""}`;
    timeline.append(tile);
  }
  return timeline;
}

function careerTable(columns, rows, sort, captionText) {
  const sorted = [...rows].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    const missingA = av == null || (typeof av === "number" && !Number.isFinite(av));
    const missingB = bv == null || (typeof bv === "number" && !Number.isFinite(bv));
    if (missingA !== missingB) return missingA ? 1 : -1;
    const result = missingA ? 0 : typeof av === "string" && sort.key !== "season" ? av.localeCompare(bv) : Number(av) - Number(bv);
    return (sort.direction === "asc" ? result : -result) || String(a.name || a.teamName || "").localeCompare(String(b.name || b.teamName || "")) || Number(b.season || 0) - Number(a.season || 0);
  });
  const values = sorted.map((row) => columns.map((column) => {
    if (column.render) return column.render(row);
    return column.format.length > 1 ? column.format(row[column.key], row) : column.format(row[column.key]);
  }));
  const wrap = simpleTable(columns.map((column) => column.label), values, captionText);
  const table = wrap.querySelector("table");
  table.classList.add("owner-career-table");
  table.querySelectorAll("thead th").forEach((th, index) => {
    const column = columns[index];
    const buttonSort = { key: sort.column || columns.find((item) => item.key === sort.key)?.label, direction: sort.direction };
    const button = sortButton(column.label, column.label, buttonSort, (next) => {
      Object.assign(sort, { key: column.key, column: column.label, direction: next.direction });
      renderOwners(ownerData);
      [...byId("ownersContent").querySelectorAll('[role="region"]')].find((region) => region.getAttribute("aria-label") === captionText)?.querySelectorAll("thead button")[index]?.focus();
    });
    button.title = column.help;
    const help = el("span", "visually-hidden", column.help);
    help.id = `career-help-${captionText.replaceAll(" ", "-")}-${index}`;
    button.setAttribute("aria-describedby", help.id);
    th.replaceChildren(button, help);
    th.setAttribute("aria-sort", buttonSort.key === column.label ? sort.direction === "asc" ? "ascending" : "descending" : "none");
  });
  table.querySelectorAll("tbody tr").forEach((tr, rowIndex) => {
    [...tr.children].forEach((cell, index) => colorPerformance(cell, sorted[rowIndex][columns[index].key], columns[index], rows));
  });
  return wrap;
}

function ownerTrendFilter(owners) {
  const controls = el("div", "team-filter owner-trend-filter");
  owners.forEach((owner) => {
    const style = ownerLineStyle({ canonicalOwnerIds: [owner.id], rosterId: owner.id });
    const label = el("label", "trend-owner-key");
    label.style.setProperty("--team-color", style.color);
    label.title = owner.name;
    const input = el("input");
    input.type = "checkbox";
    input.checked = !ownerTrendHiddenOwners.has(owner.id);
    input.addEventListener("change", () => {
      if (input.checked) ownerTrendHiddenOwners.delete(owner.id);
      else ownerTrendHiddenOwners.add(owner.id);
      renderOwners(ownerData);
    });
    label.append(input, compactOwner(owner));
    controls.append(label);
  });
  return controls;
}

function renderOwnerMedianTrend(root, owners, qualifyingSeasons) {
  const years = [...(qualifyingSeasons || [])].map((row) => String(row.season)).sort((a, b) => Number(a) - Number(b));
  const rows = owners.filter((owner) => owner.seasons?.length);
  if (!years.length || !rows.length) return;
  const yearIndex = new Map(years.map((year, index) => [year, index]));
  const section = el("section", "owner-trend-section");
  const header = el("div", "owner-trend-header");
  const title = el("div", "owner-trend-title");
  title.append(el("h3", "", "Cumulative vs median"));
  header.append(title, ownerTrendFilter(rows));
  section.append(header);

  const visibleRows = rows.filter((owner) => !ownerTrendHiddenOwners.has(owner.id));
  if (!visibleRows.length) {
    section.append(emptyState("No owners selected", "Use the owner filters above the chart to add owners back.", "–"));
    root.append(section);
    return;
  }

  const series = visibleRows.map((owner) => {
    let total = 0;
    const seasons = [...owner.seasons].sort((a, b) => Number(a.season) - Number(b.season));
    const points = seasons.map((season) => {
      if (!yearIndex.has(String(season.season)) || !Number.isFinite(season.cumulativeDeltaMedian)) return null;
      total += season.cumulativeDeltaMedian;
      return { season: String(season.season), index: yearIndex.get(String(season.season)), score: total };
    }).filter(Boolean);
    return { owner, points };
  }).filter((item) => item.points.length);
  if (!series.length) return;
  const values = series.flatMap(({ points }) => points.map((point) => point.score));
  let yMin = Math.floor((Math.min(0, ...values) - 25) / 50) * 50;
  let yMax = Math.ceil((Math.max(0, ...values) + 25) / 50) * 50;
  if (yMin === yMax) { yMin -= 10; yMax += 10; }

  const width = 980;
  const height = 380;
  const margin = { top: 26, right: 54, bottom: 46, left: 62 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (index) => margin.left + (years.length === 1 ? plotWidth / 2 : (index / (years.length - 1)) * plotWidth);
  const y = (value) => margin.top + ((yMax - value) / (yMax - yMin)) * plotHeight;

  const wrap = el("div", "chart-wrap owner-trend-chart");
  const svg = svgEl("svg", { class: "trend-svg", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-labelledby": "ownerTrendTitle ownerTrendDesc" });
  svg.append(svgEl("title", { id: "ownerTrendTitle" }), svgEl("desc", { id: "ownerTrendDesc" }));
  svg.querySelector("title").textContent = "Owner cumulative score versus median";
  svg.querySelector("desc").textContent = "Each line sums an owner's season score versus weekly medians across the selected owner-career era.";

  for (let step = 0; step <= 4; step += 1) {
    const value = yMin + ((yMax - yMin) * step / 4);
    const yPosition = y(value);
    svg.append(svgEl("line", { class: "chart-grid", x1: margin.left, x2: width - margin.right, y1: yPosition, y2: yPosition }));
    const label = svgEl("text", { class: "chart-axis-label", x: margin.left - 10, y: yPosition + 4, "text-anchor": "end" });
    label.textContent = Math.round(value);
    svg.append(label);
  }
  years.forEach((year, index) => {
    const label = svgEl("text", { class: "chart-axis-label", x: x(index), y: height - 15, "text-anchor": "middle" });
    label.textContent = `'${year.slice(-2)}`;
    svg.append(label);
  });
  svg.append(svgEl("line", { class: "chart-median", x1: margin.left, x2: width - margin.right, y1: y(0), y2: y(0), "aria-label": "Zero cumulative difference from weekly medians" }));

  series.forEach(({ owner, points }) => {
    const style = ownerLineStyle({ canonicalOwnerIds: [owner.id], rosterId: owner.id });
    const path = points.map((point, index) => `${index ? "L" : "M"}${x(point.index)},${y(point.score)}`).join(" ");
    svg.append(svgEl("path", { class: "chart-line", d: path, stroke: style.color, "stroke-dasharray": style.dash, "data-owner": owner.id }));
    points.forEach((point) => {
      const description = `${shortOwnerName(owner.name)}, through ${point.season}: ${signed(point.score)} cumulative vs median`;
      const dot = svgEl("circle", { class: "chart-dot", cx: x(point.index), cy: y(point.score), r: 4, fill: style.color, tabindex: 0, "aria-label": description });
      const title = svgEl("title");
      title.textContent = description;
      dot.append(title);
      svg.append(dot);
    });
    const last = points.at(-1);
    const cx = x(last.index);
    const cy = y(last.score);
    const src = ownerIconSrc(owner.id);
    if (src) {
      const image = svgEl("image", { class: "owner-trend-avatar", href: src, x: cx - 12, y: cy - 12, width: 24, height: 24, tabindex: 0, "aria-label": `${shortOwnerName(owner.name)}: ${signed(last.score)} cumulative vs median` });
      image.append(svgEl("title"));
      image.querySelector("title").textContent = `${shortOwnerName(owner.name)}: ${signed(last.score)} cumulative vs median`;
      svg.append(image);
    } else {
      const grave = svgEl("text", { class: "owner-trend-grave", x: cx, y: cy + 6, "text-anchor": "middle", tabindex: 0, "aria-label": `${shortOwnerName(owner.name)}: ${signed(last.score)} cumulative vs median` });
      grave.textContent = "🪦";
      const title = svgEl("title");
      title.textContent = `${shortOwnerName(owner.name)}: ${signed(last.score)} cumulative vs median`;
      grave.append(title);
      svg.append(grave);
    }
  });
  const selectedOwners = visibleRows.map((owner) => shortOwnerName(owner.name)).join(", ");
  title.append(exportButton("Export chart", () => exportSvgAsPng(svg, `${safeFilename(`owner-cumulative-${ownerEra}`)}.png`, {
    title: `Owner cumulative vs median · ${ownerEra === "ten-team" ? "10-team era" : "All seasons"}`,
    subtitle: `${seasonRange(qualifyingSeasons || [])} · Owners: ${selectedOwners}`,
  })));
  wrap.append(svg);
  section.append(wrap);
  root.append(section);
}

function careerColumns(qualifyingSeasons = []) {
  return [
    { label: "Playoffs", key: "postseasonAppearances", render: (row) => playoffTimeline(row, qualifyingSeasons), help: "Chronological playoff results for seasons in the selected era: check means playoff appearance, X means missed playoffs, dash means not played or not yet available." },
    { label: "Record", key: "winPct", render: recordText, help: "Regular-season head-to-head record; sorted by win percentage." },
    { label: "Win %", key: "winPct", format: percentage, color: "percent", help: "Wins plus half of ties divided by decided games; neutral at 50%." },
    { label: "Lucky/Unlucky", key: "luckyWins", format: (_, row) => `${integer(row.luckyWins)} / ${integer(row.unluckyLosses)}`, help: "Lucky wins while scoring below that week's league median, slash unlucky losses while scoring above it." },
    { label: "PF", key: "pointsFor", format: point, color: "range", help: "Total points across qualifying finalized weeks; colors compare displayed rows." },
    { label: "PF/G", key: "pointsPerGame", format: point, color: "range", help: "Total points divided by scored weeks, not an average of season averages." },
    { label: "PA/G", key: "pointsAgainstPerGame", format: point, color: "inverse", help: "Opponent points per finalized regular-season game; lower is better." },
    { label: "Diff/G", key: "pointDifferentialPerGame", format: signed, color: "zero", help: "Average point differential per finalized regular-season game." },
    { label: "Median win %", key: "medianWinPct", format: percentage, color: "percent", help: "Weeks above median plus half of median ties divided by finalized weeks; neutral at 50%." },
    { label: "Avg vs median", key: "averageDeltaMedian", format: signed, color: "zero", help: "Mean score minus that week's median; neutral at zero." },
    { label: "Best", key: "bestScore", format: point, color: "range", help: "Highest qualifying weekly score." },
    { label: "Score SD", key: "scoreDeviation", format: point, color: "inverse", help: "Sample standard deviation of qualifying weekly scores. Lower means more consistent scoring." },
  ];
}

export function renderOwners(payload) {
  const root = byId("ownersContent");
  if (payload && (payload.era || "all") !== ownerEra) return;
  if (payload) { ownerData = payload; ownerCache.set(ownerEra, payload); }
  if (!payload && ownerData) {
    byId("ownersStatus").textContent = "Owner update unavailable; previous data for this era retained.";
    return;
  }
  root.replaceChildren();
  if (!payload) { root.append(emptyState("Owner careers unavailable", "Try reloading the page.")); byId("ownersStatus").textContent = "Career data for this era is unavailable."; return; }
  byId("ownerEraSummary").textContent = `${ownerEra === "ten-team" ? "10-team era" : "All seasons"} · Regular season · ${seasonRange(payload.qualifyingSeasons || [])}`;
  byId("ownersStatus").textContent = !payload.currentDataAvailable ? "Historical careers available. Current-season contributions are unavailable." : payload.stale ? "Current-season contributions use saved data; the latest update is unavailable or overdue." : "";
  const eligible = payload.owners.filter((item) => item.seasons.length);
  const careerStats = careerColumns(payload.qualifyingSeasons || []);
  const filtered = eligible.filter((item) => !byId("currentOwnersOnly").checked || item.current);
  const owner = payload.owners.find((item) => item.id === selectedOwner);
  if (selectedOwner) {
    const back = el("button", "refresh-button", "← All owners");
    back.type = "button";
    back.addEventListener("click", () => { selectedOwner = null; renderOwners(ownerData); byId("ownersContent").querySelector(".owner-button")?.focus(); });
    const profileHeader = el("div", "owner-profile-header");
    const profileTitle = el("div", "owner-profile-title");
    const heading = el("h3", "owner-title");
    heading.append(ownerNameWithTrophies(owner));
    heading.tabIndex = -1;
    profileTitle.append(back, heading);
    if (owner?.seasons.length) profileHeader.append(profileTitle, ownerSeasonTimeline(owner, eligible));
    else profileHeader.append(profileTitle);
    root.append(profileHeader);
    if (!owner?.seasons.length) { root.append(emptyState("No seasons in this era", "Choose All seasons to view this owner's career.")); return; }
    const totals = simpleTable(careerStats.map((column) => column.label), [careerStats.map((column) => {
      if (column.render) return column.render(owner);
      return column.format.length > 1 ? column.format(owner[column.key], owner) : column.format(owner[column.key]);
    })], "Career totals");
    totals.querySelectorAll("thead th").forEach((th, index) => {
      const column = careerStats[index];
      th.title = column.help;
      th.tabIndex = 0;
      th.setAttribute("aria-label", `${column.label}: ${column.help}`);
    });
    [...totals.querySelector("tbody tr").children].forEach((cell, index) => colorPerformance(cell, owner[careerStats[index].key], careerStats[index], eligible));
    root.append(totals);
    const cards = el("div", "career-performance");
    const metrics = [
      { label: "Playoff apps", key: "postseasonAppearances", format: integer, color: "range", help: "Confirmed championship-bracket appearances in qualifying seasons." },
      { label: "Win rate", key: "winPct", format: percentage, color: "percent", help: "Wins plus half of ties divided by decided games." },
      { label: "Median record", key: "medianWins", rankKey: "medianWinPct", render: (row) => `${row.medianWins}-${row.medianLosses}${row.medianTies ? `-${row.medianTies}` : ""}`, help: "Weeks above, below, and tied with the league median." },
      { label: "Points/game", key: "pointsPerGame", format: point, color: "range", help: "Total points divided by scored weeks." },
      { label: "Against/game", key: "pointsAgainstPerGame", format: point, color: "inverse", help: "Opponent points per finalized regular-season game; lower is better." },
      { label: "Diff/game", key: "pointDifferentialPerGame", format: signed, color: "zero", help: "Average point differential per finalized regular-season game." },
      { label: "Cumulative vs median", key: "cumulativeDeltaMedian", format: signed, color: "zero", help: "Sum of score minus the league median for each qualifying week." },
      { label: "Best week", key: "bestScore", format: point, color: "range", help: "Highest qualifying weekly score." },
      { label: "Worst week", key: "worstScore", format: point, color: "range", help: "Lowest qualifying weekly score." },
      { label: "Score deviation", key: "scoreDeviation", format: point, color: "inverse", help: "Sample deviation across all qualifying scores; lower is more consistent. Compared with owners in this era. Requires two scores." },
    ];
    metrics.forEach((metric) => {
      const card = el("article", "benchmark");
      const label = el("span", "", metric.label);
      label.title = metric.help;
      const value = el("strong", "", metric.render ? metric.render(owner) : metric.format(owner[metric.key]));
      const rank = el("span", "benchmark-rank", metricRank(owner, eligible, metric));
      card.append(label, value, rank, el("span", "visually-hidden", metric.help));
      colorPerformance(card, owner[metric.key], metric, eligible);
      cards.append(card);
    });
    root.append(cards);
    const columns = [
      { label: "Season", key: "season", help: "Season year; open its scoreboard.", render: (row) => {
        const link = el("a", "season-link", `${row.season}${row.ongoing ? " · Ongoing" : ""}`);
        link.href = `?season=${encodeURIComponent(row.season)}&owner=${encodeURIComponent(owner.id)}`;
        link.addEventListener("click", (event) => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); seasonHandler(row.season, owner.id); });
        return link;
      } },
      { label: "Team", key: "teamName", format: (value) => value, help: "Team name in this season." },
      { label: "Playoffs", key: "postseasonAppearance", format: (value) => value == null ? "—" : value ? "✅" : "❌", help: "Championship-bracket participation from ESPN postseason matchups and playoff seeds; consolation games are excluded. A dash means not yet available." },
      ...careerStats.filter((column) => !["postseasonAppearances"].includes(column.key)),
      { label: "Champion", key: "champion", format: (value) => value ? "Yes" : "—", help: "Explicit championship designation; ongoing seasons are not inferred." },
    ];
    root.append(careerTable(columns, owner.seasons, ownerSeasonSort, "Owner season history"));
  } else {
    const nameColumn = { label: "Owner", key: "name", help: "Owner name; open the individual career profile. Trophy icons indicate explicit championships in qualifying seasons.", render: (item) => {
      const button = el("button", "owner-button");
      button.type = "button";
      button.append(ownerNameWithTrophies(item, true));
      button.addEventListener("click", () => { selectedOwner = item.id; renderOwners(ownerData); byId("ownersContent").querySelector("h3")?.focus(); });
      return button;
    } };
    if (!filtered.length) root.append(emptyState("No owners in this selection", "Change the era or current-owner filter."));
    else {
      root.append(careerTable([nameColumn, ...careerStats], filtered, ownerSort, "Owner career summaries"));
      renderOwnerMedianTrend(root, filtered, payload.qualifyingSeasons || []);
    }
  }
}

export function renderConnectionWarning() {
  byId("noticeRegion").replaceChildren(el("div", "notice", "Connection interrupted. Displayed scores have been retained; use Refresh to try again."));
  byId("dataStatus").classList.add("is-stale");
}

const recordCategories = [
  ["highestScore", "Highest score", point], ["lowestScore", "Lowest score", point],
  ["highestLosingScore", "Highest losing score", point], ["lowestWinningScore", "Lowest winning score", point],
  ["biggestBlowout", "Biggest blowout", point], ["closestMatchup", "Closest matchup", point],
  ["mostSeasonPoints", "Most points in a season", point], ["bestWinPercentage", "Best win percentage", percentage],
  ["bestMedianWinPercentage", "Best median win percentage", percentage], ["bestCumulativeVsMedian", "Best cumulative score vs median", signed],
  ["longestWinStreak", "Longest win streak", (value) => `${value} wins`],
];
let recordsEra = "ten-team";
let rivalry = { era: "ten-team", stage: "all", ownerA: "", ownerB: "" };
const rivalryStageLabels = { all: "All games", regular: "Regular season", playoff: "Playoffs" };
const recordsCache = new Map();
const rivalryCache = new Map();
const rivalrySort = { key: "season", direction: "desc" };
const rivalryKey = (value) => JSON.stringify([value.era, value.stage || "all", value.ownerA, value.ownerB]);

function researchStatus(payload) {
  const seasons = payload.qualifyingSeasons.map((item) => item.season).join(", ") || "No qualifying seasons";
  const availability = !payload.currentDataAvailable ? "Current-season results unavailable; historical results are available." : payload.stale ? "Current-season results use saved data; the latest update is unavailable or overdue." : "Finalized results only.";
  return `${payload.era === "ten-team" ? "10-team era" : "All seasons"} · ${seasons}. ${availability}`;
}

function scoreboardLink(season, ownerId, text) {
  const link = el("a", "season-link", text);
  link.href = `?season=${encodeURIComponent(season)}&owner=${encodeURIComponent(ownerId)}`;
  link.addEventListener("click", (event) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); seasonHandler(season, ownerId);
  });
  return link;
}

function renderClosestMatchupDetails(details, row) {
  const matchup = el("div", "record-matchup");
  matchup.append(scoreboardLink(row.season, row.home.ownerId, row.home.ownerName), el("span", "record-vs", "vs"), scoreboardLink(row.season, row.away.ownerId, row.away.ownerName));
  const teams = el("small", "", `${row.home.teamName} (${point(row.home.score)}) · ${row.away.teamName} (${point(row.away.score)})`);
  details.append(matchup, teams);
}

export function prepareRecords(era) {
  recordsEra = era;
  byId("recordsEra").value = era;
  setEraSwitch("recordsEraSwitch", era);
  const cached = recordsCache.get(era);
  if (cached) renderRecords(cached);
  else byId("recordsContent").replaceChildren();
  byId("recordsStatus").textContent = "Loading records…";
  byId("recordsContent").setAttribute("aria-busy", "true");
}

export function renderRecords(payload, error = null) {
  if (payload && payload.era !== recordsEra) return;
  byId("recordsContent").setAttribute("aria-busy", "false");
  if (!payload) {
    byId("recordsStatus").textContent = recordsCache.has(recordsEra) ? "Update unavailable; saved records for this era retained." : error?.message || "Records unavailable. Try opening this tab again.";
    return;
  }
  recordsCache.set(recordsEra, payload);
  byId("recordsStatus").textContent = researchStatus(payload);
  const root = byId("recordsContent"); root.replaceChildren();
  for (const [key, title, format] of recordCategories) {
    const section = el("section", "record-section");
    section.append(el("h3", "", title));
    const list = el("ol", "record-list");
    for (const row of payload.records[key] || []) {
      const item = el("li", "record-row");
      const details = el("div");
      if (key === "closestMatchup" && row.home && row.away) renderClosestMatchupDetails(details, row);
      else details.append(scoreboardLink(row.season, row.ownerId, row.ownerName), el("small", "", row.teamName));
      details.append(el("small", "", `${row.season}${row.week ? ` · Week ${row.week}` : ` · ${row.games} games`}${row.ongoing ? " · Ongoing" : ""}`));
      if (key === "longestWinStreak") details.append(el("small", "", `From ${row.startSeason} Week ${row.startWeek}`));
      else if (row.opponent && key !== "closestMatchup") details.append(el("small", "", `vs ${row.opponentOwner} · ${row.opponent} (${point(row.score)}–${point(row.opponentScore)})`));
      item.append(el("span", "record-rank", `#${row.rank}`), details, el("strong", "record-value", format(row.value)));
      list.append(item);
    }
    section.append(list.childElementCount ? list : el("p", "section-note", "No qualifying results yet."));
    root.append(section);
  }
}

function setOwnerOption(id, value) {
  const select = byId(id);
  if (value && ![...select.options].some((option) => option.value === value)) {
    const option = el("option", "", value); option.value = value; select.append(option);
  }
  select.value = value;
}

export function prepareRivalry(selection) {
  rivalry = { stage: "all", ...selection };
  byId("h2hStageControls").querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.stage === rivalry.stage)));
  byId("h2hEra").value = selection.era;
  setEraSwitch("h2hEraSwitch", selection.era);
  setOwnerOption("h2hOwnerA", selection.ownerA); setOwnerOption("h2hOwnerB", selection.ownerB);
  const cached = rivalryCache.get(rivalryKey(rivalry));
  if (cached) renderRivalry(cached);
  else byId("headToHeadContent").replaceChildren();
  byId("headToHeadStatus").textContent = `Loading ${rivalryStageLabels[rivalry.stage]?.toLowerCase() || "matchup"} results…`;
  byId("headToHeadContent").setAttribute("aria-busy", "true");
}

export function renderRivalry(payload, error = null) {
  if (payload && (payload.era !== rivalry.era || (payload.stage || "all") !== rivalry.stage || (payload.ownerA?.id || "") !== rivalry.ownerA || (payload.ownerB?.id || "") !== rivalry.ownerB)) return;
  const root = byId("headToHeadContent"); root.setAttribute("aria-busy", "false");
  if (!payload) {
    byId("headToHeadStatus").textContent = rivalryCache.has(rivalryKey(rivalry)) ? "Update unavailable; saved results for this owner pair, era and stage retained." : error?.message || "Matchup history unavailable. Try opening this tab again.";
    return;
  }
  rivalryCache.set(rivalryKey(rivalry), payload);
  for (const [id, key] of [["h2hOwnerA", "ownerA"], ["h2hOwnerB", "ownerB"]]) {
    const empty = el("option", "", "Choose an owner"); empty.value = "";
    byId(id).replaceChildren(empty, ...payload.owners.map((owner) => {
      const option = el("option", "", owner.name); option.value = owner.id; return option;
    }));
    byId(id).value = rivalry[key];
  }
  byId("headToHeadStatus").textContent = researchStatus(payload);
  root.replaceChildren();
  if (!payload.summary) { root.append(emptyState("Choose two owners", "Select a pair to see their series record and every meeting.")); return; }
  const { summary: s, ownerA: a, ownerB: b } = payload;
  if (!s.games) { root.append(emptyState(rivalry.stage === "playoff" ? "No playoff meetings in this era" : "No meetings in this selection", "Try another stage, All seasons, or a different owner pair.")); return; }
  const scope = rivalry.stage === "playoff" ? "Archived ESPN championship-bracket games only." : rivalry.stage === "regular" ? "Finalized regular-season games only." : "Regular-season games and archived ESPN championship-bracket meetings.";
  root.append(el("h3", "", `${a.name} vs ${b.name}`), el("p", "section-note rivalry-scope", `${rivalryStageLabels[rivalry.stage]} · ${s.games} ${s.games === 1 ? "meeting" : "meetings"}. ${scope}`));
  const best = (game) => game ? `${point(game.margin)} · ${game.season} W${game.week}` : "—";
  const streak = s.currentStreak.count * (s.currentStreak.ownerId === a.id ? 1 : -1);
  const metrics = [
    { label: "Series record", values: [s.wins, s.losses], display: [`${s.wins}–${s.losses}`, `${s.losses}–${s.wins}`], color: "range", help: "Wins–losses against the other owner. More wins are shaded green." },
    { label: "Win percentage", values: [(s.wins + s.ties / 2) / s.games, (s.losses + s.ties / 2) / s.games], format: percentage, color: "percent", help: "Ties count as half a win; 50% is neutral." },
    { label: "Games", values: [s.games, s.games], format: integer },
    { label: "Points for", values: [s.pointsFor, s.pointsAgainst], format: point, color: "range", help: "Total points scored in this rivalry; higher is green." },
    { label: "Points against", values: [s.pointsAgainst, s.pointsFor], format: point, color: "inverse", help: "Total opponent points in this rivalry; lower is green." },
    { label: "Average PF", values: [s.averagePointsFor, s.averagePointsAgainst], format: point, color: "range", help: "Points scored per meeting; higher is green." },
    { label: "Average PA", values: [s.averagePointsAgainst, s.averagePointsFor], format: point, color: "inverse", help: "Opponent points per meeting; lower is green." },
    { label: "Point differential", values: [s.pointDifferential, -s.pointDifferential], format: signed, color: "zero", help: "Points for minus points against. Zero is neutral." },
    { label: "Biggest win", values: [s.biggestWinA?.margin, s.biggestWinB?.margin], display: [best(s.biggestWinA), best(s.biggestWinB)], color: "range", help: "Each owner's largest winning margin, with season and week. A dash means no wins." },
    { label: "Closest game", values: [s.closestGame?.margin, s.closestGame?.margin], display: [best(s.closestGame), best(s.closestGame)] },
    { label: "Playoff meetings", values: [s.playoffMeetings, s.playoffMeetings], format: integer },
    { label: "Current streak", values: [streak, -streak], format: (value) => value ? `${Math.abs(value)} ${value > 0 ? "W" : "L"}` : "—", color: "zero", help: "Consecutive wins or losses against this owner; ties reset both streaks." },
  ].filter((metric) => metric.label !== "Playoff meetings" || rivalry.stage === "all");
  const comparison = simpleTable(["Metric", a.name, b.name], metrics.map((metric) => [metric.label, ...(metric.display || metric.values.map((value) => metric.format(value)))]), "Owner head-to-head comparison");
  comparison.classList.add("rivalry-comparison");
  comparison.querySelectorAll("thead th").forEach((th, index) => {
    if (index) th.replaceChildren(rivalryHeaderAvatar(index === 1 ? a : b));
  });
  comparison.querySelectorAll("tbody tr").forEach((tr, index) => {
    const metric = metrics[index];
    if (metric.help) { tr.firstChild.title = metric.help; tr.firstChild.tabIndex = 0; tr.firstChild.setAttribute("aria-label", `${metric.label}: ${metric.help}`); }
    [...tr.children].slice(1).forEach((cell, ownerIndex) => colorPerformance(cell, metric.values[ownerIndex], { key: "value", color: metric.color }, metric.values.map((value) => ({ value }))));
  });
  root.append(comparison);
  if (payload.matchups.some((game) => game.scorePrecision === "source-html")) root.append(el("p", "section-note", "Archived playoff scores retain the source dashboard's one-decimal precision. Regular-season scores retain API precision."));
  const columns = [
    { key: "season", label: "Season", value: (row) => Number(row.season), render: (row) => scoreboardLink(row.season, a.id, row.season) },
    { key: "week", label: "Week", value: (row) => row.week },
    { key: "stage", label: "Stage", value: (row) => row.stage, render: (row) => row.stage === "playoff" ? "Playoffs" : "Regular season" },
    ...[["ownerA", a], ["ownerB", b]].map(([key, owner]) => ({ key, label: owner.name, value: (row) => row[key].score, render: (row) => {
      const cell = el("span", "", point(row[key].score)); cell.append(el("small", "", row[key].teamName)); return cell;
    } })),
    { key: "winner", label: "Winner", value: (row) => row.winnerId === a.id ? a.name : row.winnerId === b.id ? b.name : "Tie", render: (row) => row.winnerId ? compactOwner(row.winnerId === a.id ? a : b) : "Tie" },
    { key: "margin", label: "Margin", value: (row) => row.margin, render: (row) => point(row.margin) },
  ];
  const sortColumn = columns.find((column) => column.key === rivalrySort.key);
  const rows = [...payload.matchups].sort((a, b) => {
    const av = sortColumn.value(a), bv = sortColumn.value(b);
    const order = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return (rivalrySort.direction === "asc" ? order : -order) || Number(b.season) - Number(a.season) || b.week - a.week || a.id.localeCompare(b.id);
  });
  const table = simpleTable(columns.map((column) => column.label), rows.map((row) => columns.map((column) => column.render ? column.render(row) : column.value(row))), "Head-to-head matchup history");
  table.classList.add("rivalry-table");
  table.querySelectorAll("thead th").forEach((th, index) => {
    const column = columns[index];
    th.replaceChildren(sortButton(column.label, column.key, rivalrySort, (next) => {
      Object.assign(rivalrySort, next); renderRivalry(payload);
      byId("headToHeadContent").querySelectorAll("thead th button")[index]?.focus();
    }));
    th.setAttribute("aria-sort", rivalrySort.key === column.key ? rivalrySort.direction === "asc" ? "ascending" : "descending" : "none");
  });
  root.append(table);
}
