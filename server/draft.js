import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fetchJson } from "../src/sleeper.js";

export function normalizeDraft(draft, picks) {
  const rounds = draft?.settings?.rounds;
  const count = draft?.settings?.teams;
  if (!Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(count) || count < 1 || !Array.isArray(picks)) throw new Error("Invalid draft response");
  const cells = new Set();
  const normalized = picks.map((pick) => {
    const { round, draft_slot: slot, pick_no: pickNo } = pick;
    const key = `${round}/${slot}`;
    if (!Number.isInteger(round) || round < 1 || round > rounds || !Number.isInteger(slot) || slot < 1 || slot > count || !Number.isInteger(pickNo) || cells.has(key)) throw new Error("Invalid or duplicate draft pick");
    cells.add(key);
    return { round, slot, pickNo, playerId: String(pick.player_id ?? pick.metadata?.player_id ?? ""), rosterId: pick.roster_id, lastName: pick.metadata?.last_name || `Player ${pick.player_id}`, fullName: [pick.metadata?.first_name, pick.metadata?.last_name].filter(Boolean).join(" "), position: pick.metadata?.position || "", nflTeam: pick.metadata?.team || "" };
  });
  if (draft.status === "complete" && normalized.length !== rounds * count) throw new Error("Incomplete draft response");
  return { draftId: String(draft.draft_id), season: draft.season, status: draft.status, type: draft.type, rounds, columns: Array.from({ length: count }, (_, i) => ({ slot: i + 1, rosterId: Number(draft.slot_to_roster_id?.[i + 1]) || null })), picks: normalized };
}

const formats = new Map([["half_ppr", "Half PPR"], ["ppr", "PPR"], ["std", "Standard"], ["standard", "Standard"]]);

function rankByAdp(projections, field) {
  const ordered = Object.entries(projections || {})
    .map(([id, stats]) => ({ id, adp: stats?.[field] }))
    .filter(({ adp }) => Number.isFinite(adp) && adp > 0 && adp < 999)
    .sort((a, b) => a.adp - b.adp);
  if (!ordered.length) throw new Error("No draft ADP available");
  const ranks = {};
  let rank = 1;
  ordered.forEach(({ id, adp }, index) => {
    if (index && adp !== ordered[index - 1].adp) rank = index + 1;
    ranks[id] = rank;
  });
  return ranks;
}

/** A separate persistent cache keeps draft failures from interrupting scores. */
export class DraftBoard {
  constructor(directory, leagueId, { fetchImpl = globalThis.fetch, now = Date.now, log = console } = {}) {
    Object.assign(this, { directory: join(directory, leagueId), fetchImpl, now, log });
    this.saved = null;
    this.failure = false;
    this.rankAttempt = -Infinity;
    this.lastAttempt = -Infinity;
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(this.directory, "draft.json"), "utf8"));
      normalizeDraft(saved.raw, saved.picks);
      if (saved.version === 1 && Number.isFinite(saved.fetchedAt)) this.saved = saved;
    } catch (error) { if (error.code !== "ENOENT") this.log.warn("draft_cache_read", error.message); }
    try {
      const saved = JSON.parse(await readFile(join(this.directory, "draft-ranks.json"), "utf8"));
      const values = Object.values(saved.ranks || {});
      if (formats.has(saved.format) && Number.isFinite(new Date(saved.fetchedAt).getTime())
          && values.length && values.every(rank => Number.isInteger(rank) && rank > 0)) this.rankings = saved;
    } catch (error) { if (error.code !== "ENOENT") this.log.warn("rank_cache_read", error.message); }
  }
  async refresh(draftId) {
    await this.refreshDraft(draftId);
    const draft = this.saved?.raw;
    if (!draftId || draft?.draft_id !== draftId) return;
    const format = draft.metadata?.scoring_type;
    if (!formats.has(format) || !/^\d{4}$/.test(draft.season)) return;
    const current = this.rankings;
    if (current?.draftId === draftId && current.format === format
        && (current.final || this.now() - current.fetchedAt < 86400000)) return;
    if (this.now() - this.rankAttempt < 60000) return;
    this.rankAttempt = this.now();
    try {
      const url = `https://api.sleeper.app/v1/projections/nfl/regular/${draft.season}`;
      const field = `adp_${format === "standard" ? "std" : format}`;
      const ranks = rankByAdp(await fetchJson(url, this.fetchImpl), field);
      const saved = { draftId, format, fetchedAt: this.now(), final: draft.status === "complete", ranks };
      await writeFile(join(this.directory, "draft-ranks.json.tmp"), JSON.stringify(saved), { mode: 0o600 });
      await rename(join(this.directory, "draft-ranks.json.tmp"), join(this.directory, "draft-ranks.json"));
      this.rankings = saved;
    } catch (error) { this.log.warn("draft_rank_unavailable", error.message); }
  }
  async refreshDraft(draftId) {
    if (!draftId) return;
    const same = this.saved?.raw.draft_id === draftId;
    if ((same && this.now() - this.saved.fetchedAt < (this.saved.raw.status === "complete" ? 86400000 : 60000)) || this.now() - this.lastAttempt < 60000) return;
    this.lastAttempt = this.now();
    try {
      const url = `https://api.sleeper.app/v1/draft/${encodeURIComponent(draftId)}`;
      const [raw, picks] = await Promise.all([fetchJson(url, this.fetchImpl), fetchJson(`${url}/picks`, this.fetchImpl)]);
      normalizeDraft(raw, picks);
      if (raw.draft_id !== draftId) throw new Error("Draft identity mismatch");
      const saved = { version: 1, fetchedAt: this.now(), raw, picks };
      await writeFile(join(this.directory, "draft.json.tmp"), JSON.stringify(saved), { mode: 0o600 });
      await rename(join(this.directory, "draft.json.tmp"), join(this.directory, "draft.json"));
      this.saved = saved;
      this.failure = false;
    } catch (error) { this.failure = true; this.log.warn("draft_unavailable", error.message); }
  }
  dashboard(draftId, teams) {
    if (!this.saved || this.saved.raw.draft_id !== draftId) return null;
    const board = normalizeDraft(this.saved.raw, this.saved.picks);
    if (this.rankings?.draftId === draftId && this.rankings.format === this.saved.raw.metadata?.scoring_type) {
      board.rankFormat = formats.get(this.rankings.format);
      board.rankedAt = new Date(this.rankings.fetchedAt).toISOString();
      for (const pick of board.picks) pick.rank = this.rankings.ranks[pick.playerId] ?? null;
    }
    board.columns = board.columns.map((column) => ({ ...column, managerName: teams.find((team) => team.rosterId === column.rosterId)?.managerName || `Slot ${column.slot}` }));
    return { ...board, stale: this.failure, fetchedAt: new Date(this.saved.fetchedAt).toISOString() };
  }
}
