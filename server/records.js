import { seasonRecords } from "./history.js";
import { owners } from "./identities.js";

export function eligibleSeasons(archive, currentSnapshot, era = "ten-team") {
  if (!["all", "ten-team"].includes(era)) throw new Error("Era must be all or ten-team.");
  const seasons = [...archive.seasons];
  if (currentSnapshot && !seasons.some(({ snapshot }) => snapshot.metadata.season === currentSnapshot.metadata.season)) seasons.push({ snapshot: currentSnapshot, recap: {} });
  return seasons.filter(({ snapshot }) => era === "all" || snapshot.metadata.teamCount === 10).map(({ snapshot, recap }) => ({ recap,
    snapshot: { ...snapshot, completedWeeks: snapshot.completedWeeks.filter((week) => week.status === "final" && week.week >= snapshot.metadata.startWeek && week.week <= snapshot.metadata.regularSeasonEnd) },
  }));
}

const identity = (team, score) => ({ rosterId: team.rosterId, ownerIds: team.canonicalOwnerIds || [], teamName: team.teamName, ownerName: team.managerName, score });
const chronological = (a, b) => Number(a.season) - Number(b.season) || a.week - b.week || a.id.localeCompare(b.id);
const ownerName = (ownerId, fallback) => owners.find((owner) => owner.id === ownerId)?.name || fallback;
const recordSide = (side) => ({
  ownerId: side.ownerIds[0],
  ownerName: side.ownerIds.map((id) => ownerName(id, side.ownerName)).join(" / ") || side.ownerName,
  teamName: side.teamName,
  score: side.score,
});

/** Each actual game appears once, with season-local roster IDs and stable owner IDs. */
export function ownerMatchups(seasons, { playoffs = false } = {}) {
  const games = [];
  for (const { snapshot, recap } of seasons) {
    const teams = new Map(snapshot.teams.map((team) => [team.rosterId, team]));
    const base = { season: snapshot.metadata.season, teamCount: snapshot.metadata.teamCount, source: snapshot.metadata.source || "sleeper" };
    for (const week of snapshot.completedWeeks) {
      const pairs = new Map();
      for (const entry of week.entries) if (entry.matchupId != null) pairs.set(entry.matchupId, [...(pairs.get(entry.matchupId) || []), entry]);
      for (const [id, pair] of pairs) {
        if (pair.length !== 2 || pair[0].rosterId === pair[1].rosterId || pair.some((entry) => !teams.has(entry.rosterId) || !Number.isFinite(entry.score))) continue;
        const [a, b] = pair;
        const result = a.result || (a.score === b.score ? "ties" : a.score > b.score ? "wins" : "losses");
        games.push({ ...base, id: `${base.season}:regular:${week.week}:${id}`, week: week.week, stage: "regular", home: identity(teams.get(a.rosterId), a.score), away: identity(teams.get(b.rosterId), b.score), winner: result === "ties" ? "TIE" : result === "wins" ? "HOME" : "AWAY", margin: Math.abs(a.score - b.score) });
      }
    }
    if (playoffs && base.source === "espn") for (const game of recap.postseason?.matchups || []) {
      if (!Number.isFinite(game.homeScore) || !Number.isFinite(game.awayScore)) continue;
      games.push({ ...base, id: game.matchupRef, week: game.week, stage: "playoff", tier: game.tier, home: identity(teams.get(game.homeRosterId), game.homeScore), away: identity(teams.get(game.awayRosterId), game.awayScore), winner: game.winner, margin: game.margin, scorePrecision: game.scorePrecision, corrections: game.corrections });
    }
  }
  return games.sort(chronological);
}

function context(seasons, currentSnapshot, options) {
  return { schemaVersion: 1, era: options.era || "ten-team", currentSeason: String(options.currentSeason || currentSnapshot?.metadata.season || "2026"), currentDataAvailable: Boolean(currentSnapshot), stale: Boolean(options.stale),
    qualifyingSeasons: seasons.map(({ snapshot }) => ({ season: snapshot.metadata.season, teamCount: snapshot.metadata.teamCount })).sort((a, b) => Number(b.season) - Number(a.season)) };
}

function top(rows, direction = "desc") {
  const sorted = rows.sort((a, b) => (direction === "desc" ? b.value - a.value : a.value - b.value) || Number(b.season) - Number(a.season) || (a.week || 0) - (b.week || 0) || a.ownerId.localeCompare(b.ownerId));
  // Include everyone tied at the fifth position.
  return sorted.filter((row, index) => index < 5 || row.value === sorted[4]?.value).map((row, index) => ({ ...row, rank: sorted.findIndex((other) => other.value === row.value) + 1 }));
}

export function leagueRecords(archive, currentSnapshot, options = {}) {
  const seasons = eligibleSeasons(archive, currentSnapshot, options.era);
  const games = ownerMatchups(seasons);
  const scores = games.flatMap((game) => ["home", "away"].flatMap((side) => {
    const team = game[side], opponent = game[side === "home" ? "away" : "home"];
    return team.ownerIds.map((ownerId) => ({ ownerId, ownerName: ownerName(ownerId, team.ownerName), teamName: team.teamName, season: game.season, week: game.week, score: team.score, value: team.score, opponent: opponent.teamName, opponentOwner: opponent.ownerName, opponentScore: opponent.score, margin: game.margin, result: game.winner === "TIE" ? "tie" : game.winner === side.toUpperCase() ? "win" : "loss" }));
  }));
  const seasonRows = seasons.flatMap(({ snapshot }) => seasonRecords(snapshot).filter((row) => row.games).flatMap((row) => row.canonicalOwnerIds.map((ownerId) => ({ ownerId, ownerName: ownerName(ownerId, snapshot.teams.find((team) => team.rosterId === row.rosterId).managerName), teamName: row.teamName, season: snapshot.metadata.season, games: row.games, ongoing: snapshot.metadata.source !== "espn" && row.games < snapshot.metadata.regularSeasonEnd - snapshot.metadata.startWeek + 1, ...row }))));
  const streaks = [];
  const active = new Map();
  for (const row of scores) {
    if (row.result !== "win") { active.delete(row.ownerId); continue; }
    let streak = active.get(row.ownerId);
    if (!streak) {
      streak = { ...row, value: 0, startSeason: row.season, startWeek: row.week };
      active.set(row.ownerId, streak); streaks.push(streak);
    }
    Object.assign(streak, { value: streak.value + 1, season: row.season, week: row.week, teamName: row.teamName });
  }
  const weekly = (rows, key = "score", direction = "desc") => top(rows.map((row) => ({ ...row, value: row[key] })), direction);
  const seasonal = (key) => top(seasonRows.map((row) => { const { scoreValues, ...rest } = row; return { ...rest, value: row[key] }; }));
  const closest = games.map((game) => {
    const home = recordSide(game.home);
    const away = recordSide(game.away);
    return { ownerId: home.ownerId, ownerName: home.ownerName, teamName: home.teamName, season: game.season, week: game.week, score: home.score, value: game.margin, opponent: away.teamName, opponentOwner: away.ownerName, opponentScore: away.score, margin: game.margin, home, away };
  }).filter((row) => row.ownerId && row.away.ownerId);
  return { ...context(seasons, currentSnapshot, options), records: {
    highestScore: weekly(scores), lowestScore: weekly(scores, "score", "asc"), highestLosingScore: weekly(scores.filter((row) => row.result === "loss")), lowestWinningScore: weekly(scores.filter((row) => row.result === "win"), "score", "asc"),
    biggestBlowout: weekly(scores.filter((row) => row.result === "win"), "margin"), closestMatchup: top(closest, "asc"), mostSeasonPoints: seasonal("pointsFor"), bestWinPercentage: seasonal("winPct"), bestMedianWinPercentage: seasonal("medianWinPct"), bestCumulativeVsMedian: seasonal("cumulativeDeltaMedian"), longestWinStreak: top(streaks),
  } };
}

export function headToHead(archive, currentSnapshot, options = {}) {
  const stage = options.stage ?? "all";
  if (!["all", "regular", "playoff"].includes(stage)) throw new Error("Stage must be all, regular or playoff.");
  const seasons = eligibleSeasons(archive, currentSnapshot, options.era);
  const known = new Map(owners.map((owner) => [owner.id, { id: owner.id, name: owner.name }]));
  for (const { snapshot } of seasons) for (const team of snapshot.teams) for (const id of team.canonicalOwnerIds || []) if (!known.has(id)) known.set(id, { id, name: team.managerName });
  for (const id of [options.ownerA, options.ownerB]) if (id !== undefined && (typeof id !== "string" || !known.has(id))) throw new Error("Choose a known owner.");
  if (options.ownerA && options.ownerA === options.ownerB) throw new Error("Choose two different owners.");
  const response = { ...context(seasons, currentSnapshot, options), stage, owners: [...known.values()].sort((a, b) => a.name.localeCompare(b.name)), ownerA: known.get(options.ownerA) || null, ownerB: known.get(options.ownerB) || null, summary: null, matchups: [] };
  if (!response.ownerA || !response.ownerB) return response;
  const matchups = ownerMatchups(seasons, { playoffs: true }).flatMap((game) => {
    if (stage !== "all" && game.stage !== stage) return [];
    const aHome = game.home.ownerIds.includes(options.ownerA) && game.away.ownerIds.includes(options.ownerB);
    const aAway = game.away.ownerIds.includes(options.ownerA) && game.home.ownerIds.includes(options.ownerB);
    if (!aHome && !aAway) return [];
    const { home, away, ...rest } = game;
    return [{ ...rest, ownerA: aHome ? home : away, ownerB: aHome ? away : home, winnerId: game.winner === "TIE" ? null : (game.winner === "HOME") === aHome ? options.ownerA : options.ownerB }];
  });
  const summary = { games: matchups.length, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, averagePointsFor: null, averagePointsAgainst: null, pointDifferential: 0, biggestWinA: null, biggestWinB: null, closestGame: null, playoffMeetings: 0, currentStreak: { ownerId: null, count: 0 } };
  for (const game of matchups) {
    summary[game.winnerId === options.ownerA ? "wins" : game.winnerId === options.ownerB ? "losses" : "ties"]++;
    summary.pointsFor += game.ownerA.score; summary.pointsAgainst += game.ownerB.score;
    if (game.stage === "playoff") summary.playoffMeetings++;
    if (!summary.closestGame || game.margin < summary.closestGame.margin) summary.closestGame = game;
    const best = game.winnerId === options.ownerA ? "biggestWinA" : game.winnerId === options.ownerB ? "biggestWinB" : null;
    if (best && (!summary[best] || game.margin > summary[best].margin)) summary[best] = game;
    summary.currentStreak = game.winnerId ? { ownerId: game.winnerId, count: summary.currentStreak.ownerId === game.winnerId ? summary.currentStreak.count + 1 : 1 } : { ownerId: null, count: 0 };
  }
  summary.pointDifferential = summary.pointsFor - summary.pointsAgainst;
  if (summary.games) { summary.averagePointsFor = summary.pointsFor / summary.games; summary.averagePointsAgainst = summary.pointsAgainst / summary.games; }
  return { ...response, summary, matchups: matchups.reverse() };
}
