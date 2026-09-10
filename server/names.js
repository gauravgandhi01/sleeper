import { readFileSync } from "node:fs";

const managerNames = new Map(
  readFileSync(new URL("../mapping.txt", import.meta.url), "utf8")
    .split(/\r?\n/).filter((line) => line.trim())
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator < 1 || !line.slice(separator + 1).trim()) throw new Error("Invalid manager mapping");
      return [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
    }),
);

// Apply display overrides on read so saved snapshots pick up mapping changes too.
export function applyDisplayNames(snapshot) {
  return {
    ...snapshot,
    teams: snapshot.teams.map((team) => {
      const profiles = team.managerProfiles || (team.managerNames || [team.managerName]).map((displayName) => ({ displayName }));
      const names = [...new Set(profiles.map(({ username, displayName }) =>
        managerNames.get(String(username || "").toLowerCase())
        || managerNames.get(String(displayName || "").toLowerCase())
        || displayName).filter(Boolean))];
      return {
        ...team,
        managerNames: names,
        managerName: names.join(" / ") || team.managerName,
        teamName: team.teamName.replace(/^👑\uFE0F?\s*(?=Dylan Top Jake Bottom$)/u, ""),
      };
    }),
  };
}
