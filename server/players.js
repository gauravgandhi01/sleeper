import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fetchJson } from "../src/sleeper.js";

/** Sleeper's player directory is large; share a daily cache across all visitors. */
export class PlayerDirectory {
  constructor(directory, { fetchImpl = globalThis.fetch, now = Date.now, log = console } = {}) {
    Object.assign(this, { directory, fetchImpl, now, log });
    this.players = {};
    this.fetchedAt = 0;
    this.lastAttempt = -Infinity;
    this.pending = null;
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(this.directory, "players.json"), "utf8"));
      if (saved.version === 1 && Number.isFinite(saved.fetchedAt) && saved.players && typeof saved.players === "object" && !Array.isArray(saved.players)) {
        this.players = saved.players;
        this.fetchedAt = saved.fetchedAt;
      }
    } catch (error) { if (error.code !== "ENOENT") this.log.warn("player_cache_read", error.message); }
  }
  refresh() {
    if (this.pending) return this.pending;
    if ((this.fetchedAt && this.now() - this.fetchedAt < 24 * 3600000) || this.now() - this.lastAttempt < 15 * 60000) return Promise.resolve();
    this.lastAttempt = this.now();
    this.pending = this.fetchDirectory().finally(() => { this.pending = null; });
    return this.pending;
  }
  async fetchDirectory() {
    try {
      const raw = await fetchJson("https://api.sleeper.app/v1/players/nfl", this.fetchImpl);
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length) throw new Error("Invalid player directory");
      const players = {};
      for (const [id, player] of Object.entries(raw)) {
        if (!player || typeof player !== "object") continue;
        players[id] = {
          name: player.full_name || [player.first_name, player.last_name].filter(Boolean).join(" ") || `Player ${id}`,
          position: player.position || null,
          nflTeam: player.team || null,
        };
      }
      if (!Object.keys(players).length) throw new Error("Empty player directory");
      const fetchedAt = this.now();
      const temporary = join(this.directory, "players.json.tmp");
      await writeFile(temporary, JSON.stringify({ version: 1, fetchedAt, players }), { mode: 0o600 });
      await rename(temporary, join(this.directory, "players.json"));
      this.players = players;
      this.fetchedAt = fetchedAt;
    } catch (error) { this.log.warn("player_directory_unavailable", error.message); }
  }
}
