/**
 * @typedef {Object} TeamIdentity
 * @property {number} rosterId
 * @property {string[]} ownerIds
 * @property {string[]} [canonicalOwnerIds] Stable cross-platform owner identities.
 * @property {string[]} managerNames
 * @property {string} managerName
 * @property {string} teamName
 * @property {string|null} avatarUrl
 */

/**
 * @typedef {Object} WeekEntry
 * @property {number} rosterId
 * @property {number|null} matchupId
 * @property {number} score
 */

/**
 * @typedef {Object} SeasonWeek
 * @property {number} week
 * @property {"final"|"live"} status
 * @property {WeekEntry[]} entries
 */

/**
 * @typedef {Object} SeasonSnapshot
 * @property {Object} metadata
 * @property {TeamIdentity[]} teams
 * @property {SeasonWeek[]} completedWeeks
 * @property {SeasonWeek|null} liveWeek
 * @property {{week:number,status:"awaiting_scoring"|"live"|"final",entries:WeekEntry[]}|null} currentWeekData
 * @property {string[]} warnings
 */

/**
 * @typedef {Object} DashboardStats
 * @property {Object} metadata
 * @property {Array<Object>} teams
 * @property {Array<Object>} weeks
 * @property {Object} league
 * @property {SeasonWeek|null} liveWeek
 * @property {string[]} warnings
 */

export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function mean(values) {
  return values.length ? sum(values) / values.length : null;
}

export function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function sampleStandardDeviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  const squared = values.map((value) => (value - average) ** 2);
  return Math.sqrt(sum(squared) / (values.length - 1));
}

export function populationStandardDeviation(values) {
  if (!values.length) return null;
  const average = mean(values);
  const squared = values.map((value) => (value - average) ** 2);
  return Math.sqrt(sum(squared) / values.length);
}

/** Return descending Excel RANK.EQ-style competition ranks. */
export function competitionRanks(values) {
  const ordered = [...values].sort((a, b) => b - a);
  return values.map((value) => ordered.indexOf(value) + 1);
}

function qualityForDelta(delta, threshold) {
  if (delta > threshold) return "great";
  if (delta < -threshold) return "bad";
  return "average";
}

function nullableMin(values) {
  return values.length ? Math.min(...values) : null;
}

function nullableMax(values) {
  return values.length ? Math.max(...values) : null;
}

function matchupRecords(weeks, teams) {
  const records = new Map(teams.map((team) => [team.rosterId, { wins: 0, losses: 0, ties: 0 }]));
  for (const week of weeks) {
    const groups = new Map();
    for (const entry of week.entries || []) {
      if (entry.matchupId == null || !records.has(entry.rosterId) || !Number.isFinite(entry.score)) continue;
      groups.set(entry.matchupId, [...(groups.get(entry.matchupId) || []), entry]);
    }
    for (const sides of groups.values()) {
      if (sides.length !== 2) continue;
      const [a, b] = sides;
      const aRecord = records.get(a.rosterId);
      const bRecord = records.get(b.rosterId);
      if (!aRecord || !bRecord) continue;
      if (a.score === b.score) { aRecord.ties++; bRecord.ties++; }
      else if (a.score > b.score) { aRecord.wins++; bRecord.losses++; }
      else { bRecord.wins++; aRecord.losses++; }
    }
  }
  return records;
}

function decorateWeek(week, teamByRoster, status) {
  if (!week) return null;
  const entries = week.entries
    .filter((entry) => teamByRoster.has(entry.rosterId) && Number.isFinite(entry.score))
    .sort((a, b) => a.rosterId - b.rosterId);
  const matchupGroups = new Map();
  for (const entry of entries) {
    if (entry.matchupId == null) continue;
    matchupGroups.set(entry.matchupId, [...(matchupGroups.get(entry.matchupId) || []), entry]);
  }
  const outcomeFor = (entry) => {
    const sides = matchupGroups.get(entry.matchupId);
    if (!sides || sides.length !== 2) return null;
    const opponent = sides.find((side) => side.rosterId !== entry.rosterId);
    if (!opponent) return null;
    if (entry.score === opponent.score) return "tie";
    return entry.score > opponent.score ? "win" : "loss";
  };
  const scores = entries.map((entry) => entry.score);
  const leagueAverage = mean(scores);
  const leagueMedian = median(scores);
  const leagueScoreDeviation = sampleStandardDeviation(scores);
  const ranks = competitionRanks(scores);

  return {
    week: week.week,
    status,
    leagueAverage,
    leagueMedian,
    leagueScoreDeviation,
    entries: entries.map((entry, index) => {
      const deltaMedian = leagueMedian === null ? null : entry.score - leagueMedian;
      return {
        ...entry,
        team: teamByRoster.get(entry.rosterId),
        outcome: outcomeFor(entry),
        deltaMedian,
        rank: ranks[index],
        // Retain the internal "great" key for API compatibility; the UI calls it Good.
        // Identical scores (including a singleton) are Average without dividing by SD.
        quality: deltaMedian === null ? null : qualityForDelta(deltaMedian, leagueScoreDeviation ?? 0),
      };
    }),
  };
}

/**
 * Calculate all scoring metrics represented by the 2025 weekly-scoring sheet.
 * Only snapshot.completedWeeks contribute to aggregates.
 *
 * @param {SeasonSnapshot} snapshot
 * @returns {DashboardStats}
 */
export function calculateStats(snapshot) {
  const teamByRoster = new Map(snapshot.teams.map((team) => [team.rosterId, team]));
  const weeks = [...snapshot.completedWeeks]
    .sort((a, b) => a.week - b.week)
    .map((week) => decorateWeek(week, teamByRoster, "final"));
  const liveWeek = decorateWeek(snapshot.liveWeek, teamByRoster, "live");
  const records = matchupRecords(snapshot.completedWeeks, snapshot.teams);

  const teamStats = snapshot.teams.map((team) => {
    const weekly = weeks
      .map((week) => week.entries.find((entry) => entry.rosterId === team.rosterId))
      .filter(Boolean);
    const scores = weekly.map((entry) => entry.score);
    const deltas = weekly.map((entry) => entry.deltaMedian);
    const ranks = weekly.map((entry) => entry.rank);
    const medianWins = deltas.filter((value) => value > 0).length;
    const medianLosses = deltas.filter((value) => value < 0).length;
    const medianTies = deltas.filter((value) => value === 0).length;
    const luckyWins = weekly.filter((entry) => entry.outcome === "win" && entry.deltaMedian < 0).length;
    const unluckyLosses = weekly.filter((entry) => entry.outcome === "loss" && entry.deltaMedian > 0).length;
    const bestScore = nullableMax(scores);
    const worstScore = nullableMin(scores);
    const games = weekly.length;
    const record = records.get(team.rosterId) || { wins: 0, losses: 0, ties: 0 };
    const decisions = record.wins + record.losses + record.ties;

    return {
      ...team,
      games,
      wins: record.wins,
      losses: record.losses,
      ties: record.ties,
      record: decisions ? `${record.wins}-${record.losses}${record.ties ? `-${record.ties}` : ""}` : "—",
      winPct: decisions ? (record.wins + (0.5 * record.ties)) / decisions : null,
      luckyWins,
      unluckyLosses,
      weekly,
      total: games ? sum(scores) : null,
      average: mean(scores),
      medianWins,
      medianLosses,
      medianTies,
      medianRecord: games
        ? `${medianWins}-${medianLosses}${medianTies ? `-${medianTies}` : ""}`
        : "—",
      medianWinPct: games ? (medianWins + (0.5 * medianTies)) / games : null,
      averageRank: mean(ranks),
      averageDeltaMedian: mean(deltas),
      over120: scores.filter((value) => value > 120).length,
      under110: scores.filter((value) => value < 110).length,
      bestScore,
      worstScore,
      scoreRange: games ? bestScore - worstScore : null,
      scoreDeviation: sampleStandardDeviation(scores),
      greatWeeks: weekly.filter((entry) => entry.quality === "great").length,
      averageWeeks: weekly.filter((entry) => entry.quality === "average").length,
      badWeeks: weekly.filter((entry) => entry.quality === "bad").length,
      rankDeviation: sampleStandardDeviation(ranks),
      bestRank: nullableMin(ranks),
      worstRank: nullableMax(ranks),
    };
  }).sort((a, b) => (
    (b.total ?? -Infinity) - (a.total ?? -Infinity)
    || (b.average ?? -Infinity) - (a.average ?? -Infinity)
    || a.teamName.localeCompare(b.teamName)
  ));

  const allScores = weeks.flatMap((week) => week.entries.map((entry) => entry.score));
  const allDeltas = weeks.flatMap((week) => week.entries.map((entry) => entry.deltaMedian));
  const weekAverages = weeks.map((week) => week.leagueAverage);
  const weekMedians = weeks.map((week) => week.leagueMedian);

  return {
    metadata: {
      ...snapshot.metadata,
      weekQualityRule: "weekly-median-plus-minus-one-sample-sd",
      completedWeekCount: weeks.length,
    },
    teams: teamStats,
    weeks,
    liveWeek,
    warnings: [...snapshot.warnings],
    league: {
      completedWeeks: weeks.length,
      scoreCount: allScores.length,
      overallMean: mean(allScores),
      overallMedian: median(allScores),
      scoreDeviation: sampleStandardDeviation(allScores),
      weeklyAverageMean: mean(weekAverages),
      medianOfWeeklyMedians: median(weekMedians),
      meanDeltaMedian: mean(allDeltas),
      medianDeltaMedian: median(allDeltas),
      deltaDeviation: populationStandardDeviation(allDeltas),
    },
  };
}
