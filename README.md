# True League on Sleeper

Node 24 / Express 5 hosts the dashboard and a shared Sleeper snapshot service.
Only this directory is deployed. ESPN seasons 2018–2025 are bundled as an offline
archive; the original historical dashboard and its generator remain independent.

## Local development

Use Node 24 (`nvm install 24 && nvm use 24` if you use nvm), then:

```sh
cd sleeper
npm ci
npm test
npm run dev
```

Open http://localhost:4174. `npm start` runs without the development watcher.
The old Python static server no longer provides the required API.

Environment settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| PORT | 4174 locally; Render supplies its own | HTTP port on 0.0.0.0 |
| LEAGUE_ID | 1395542220504854528 | Numeric string, never converted to Number |
| DATA_DIR | sleeper/.data | Persistent snapshot directory |
| PUBLIC_BASE_URL | RENDER_EXTERNAL_URL, then localhost | Absolute site URL used for social previews |
| NODE_ENV | Set to production on Render | Express production mode |
| CURRENT_SEASON | 2026 | Catalog fallback before the first successful live snapshot; the saved league season takes precedence |

## Render deployment

For the standalone **sleeper remote**, use Blueprint Path `render.yaml` and root
directory `.` (the supplied Blueprint defaults). If deploying from the parent
fantasy repository instead, use Blueprint Path `sleeper/render.yaml` and change
the Blueprint's rootDir to `sleeper`. Only the application directory is needed.
The Blueprint provisions one Starter web service with a
1 GB disk at `/var/data`, build `npm ci --include=dev && npm test`, start `npm start`, and
health path `/healthz`. The Node major is pinned by `.node-version` and engines.
The explicit dev inclusion installs the DOM test dependency even when
NODE_ENV=production; it is not used by the running server. Update the build
command on an existing manually configured Render service before deploying.

Alternatively create a web service manually using those same values. Set
`DATA_DIR=/var/data/sleeper`, `NODE_ENV=production`, and the league ID above.
Leave PUBLIC_BASE_URL unset for the generated Render URL; set it to your HTTPS
origin when adding a custom domain. No Sleeper credentials are needed.

The disk makes this a single-instance service and causes a short interruption
during deployments. Scheduling runs in-process; no separate cron service is
needed. Persistent storage is accessed only at runtime, never during builds.

First deployment acceptance:

1. Visit the public HTTPS URL and verify all tabs and assets load.
2. Open Live Scores and confirm five matchup cards when the schedule is available.
3. Check `/healthz`: storage is healthy and dataAvailable becomes true.
4. Restart the service; confirm the successful snapshot remains readable.
5. Confirm logs show successful refreshes and sensible timestamps. Upstream outage
   recovery is covered locally by injected-failure HTTP tests; a production outage
   should return saved scores with a warning, not an empty dashboard.

## Data flow and API

Startup and a 15-minute timer fetch the full regular season. Browser load,
opening Live Scores, and Refresh can also request a refresh. All callers share
one in-flight fetch and a 60-second cooldown, even after failures. Live Scores
auto-refreshes every 60 seconds while visible, online, on the current season,
and not finalized. The switch disables automatic requests; Refresh remains
available. Background live updates do not reload owner/research data. Sleeper's
own update cadence limits freshness.

GET `/api/dashboard` reads saved data (initializing if necessary).
POST `/api/refresh` refreshes subject to the shared cooldown. Both return:
`{schemaVersion:1, stats, currentWeekMatchups, nflStatus, lastSuccessfulFetchAt, stale, warnings}`.
Responses are not cached by the browser. Saved data returns 200 even during an
outage; no usable snapshot returns 503. Data is stale after a failed refresh or
20 minutes without success. `/healthz` checks storage separately from upstream
data availability, so Sleeper outages do not cause restart loops.

Only finalized Weeks 1–14 enter statistics. A week finalizes when Sleeper's
completion metadata (or week-rollover fallback) indicates completion, or at
Tuesday 3:00 a.m. America/New_York, whichever happens first. Calendar weeks are
anchored to Sleeper's NFL season_start_date; Eastern daylight saving is respected.
If that date is missing, only Sleeper's completion logic applies. This rule is
evaluated on each successful refresh (background refreshes run every 15 minutes),
and finalized scores remain eligible for corrections. Incomplete refreshes still
preserve the previous valid snapshot rather than publishing partial results.
All-zero schedules are preserved for
matchup display, but never imply completion. Good/Bad weeks score strictly above/below
the weekly league median ± one sample standard deviation of that week's team scores.
Average includes both boundaries; identical scores are Average. The API retains the
`greatWeeks` field name for compatibility, displayed as Good in the Stat book.
Commissioner overrides, including
zero, take precedence. Invalid/incomplete refreshes retain the previous snapshot.
Click a Live Scores matchup to compare paired starting slots, NFL opponents/game
states, and fantasy points. Bench players are excluded. Player identity data
comes only from Sleeper's `/players/nfl` endpoint and is cached on disk for 24 hours.
Scores come directly from the matchup payload; missing values display as unavailable.
Refresh keeps the selected matchup open, preserves focus, and retains the chosen
matchup ordering. Links use `?tab=live&week=2&matchup=1`; browser back/forward and
previous/next controls work without refetching. Scoring activity records observed
team point changes and lead changes, grouped by update, capped at 30 per matchup.
It is session-only, starts with a baseline, and resets when season/week changes.
Live Scores stops at the end of the regular season. Sleeper remains the source for
actual fantasy scores. Optional projected totals come from ESPN Fantasy when
`ESPN_S2` and `SWID` are present, using `ESPN_FANTASY_LEAGUE_ID` or the historical
league id by default. Projection failures never block Sleeper scores. Team names,
managers, and scores are publicly visible.

NFL game metadata comes from ESPN's public scoreboard feed, independently of
fantasy scoring. The server validates season/week, normalizes team abbreviations,
and caches each regular-season week in memory with a 60-second cooldown and
shared requests. Failed requests retain the last-good timestamp and data; after
three minutes, live/remaining counts are suppressed. ESPN has no supported API
contract, so missing/unknown statuses never prevent Sleeper scores from displaying.
The optional `nflStatus` object includes `season`, `week`, `games` keyed by team,
`fetchedAt`, `stale`, `unavailable`, `failed`, and `source`. Each game includes its
opponent, kickoff, home/away, normalized state, and provider status detail.
"Games live" and "Yet to start" count occupied starter slots by NFL game state,
not verified player participation. Scores of zero never imply completion.

## Persistence, export, and restore

The versioned ESPN archive in `data/history.json` ships with the application,
not the persistent disk. Live snapshot recovery does not change archived data.

Each league has `DATA_DIR/<leagueId>/latest.json` and `revisions/`. Snapshots
include a schema version and content checksum. Writes use temporary files and
atomic rename. Changed normalized data creates an archive; successful checks
with identical data update the latest timestamp without creating a revision.
Revisions are not pruned automatically. Monitor disk usage in Render.

Startup checks latest.json and then tries archives newest-first. A corrupt file
is logged and retained for inspection. Fetch/persistence failures never replace
the in-memory last successful snapshot. A failed disk health check returns 503.

For an export, use Render's SSH/SCP access to copy the entire league directory
to a dated local backup. Copy archives first and latest.json last; each file is
published atomically. Store the export outside the service. Render also takes
daily disk snapshots; a disk restore rolls back the entire disk.

For restoration, stop application writes using Render's maintenance workflow,
restore the exported league directory to the same DATA_DIR, and restart. Do not
edit individual scores in snapshot JSON: checksums will reject edited snapshots.
To recover from latest.json corruption alone, restart and let archive fallback
recover automatically. Preserve the original files until recovery is verified.

## Historical seasons and owner careers

The season selector defaults to the current Sleeper season. `?season=2025`
opens an archive, and `?season=2025&owner=gaurav` highlights an owner's team.
ESPN seasons reuse Scoreboard, Trends, and Stat book with the original team
counts and 13/14-week regular seasons. Historical Live Scores and Draft Board
are hidden; no ESPN starter or draft data is fabricated. A compact recap shows
the champion and expandable source final standings. The 2022 corrected title
is attributed to Gaurav while ESPN's original finishing positions remain intact.

The Owners tab covers all 14 historical identities, with a current-owner filter,
career totals, and season links. Regular-season records and scoring include
only finalized games; championships require an explicit imported designation.
Points/game is weighted by scored weeks, not an average of season averages.
The current season never acquires a championship based on regular-season rank.
Historical scoring spans different formats and is not normalized across eras.

Owners includes an All seasons / 10-team era selector. Eligibility uses actual
season team counts (currently 2023 onward), independently of the main season
selector and Current owners only filter. All totals, titles, profile metrics,
and season rows respect the selected era. Owners without a qualifying season
are omitted from the list; an already-open profile shows an empty state instead.
Era, filters, sort order and selected profile persist during this page session.

Owner tables support column sorting (Record sorts by win percentage), with
missing values last. Median win percentage credits half a win for median ties;
average versus median divides the sum of weekly score-minus-median by scored
weeks. Profile consistency is sample deviation across all qualifying scores,
not the average of yearly deviations. It is unavailable with fewer than two
scores. Profiles also show median record, cumulative versus median and best/worst
weeks. Header help describes metrics and color comparisons.

Career colors use muted red/green, neutral at 50% for percentages and zero for
versus-median metrics. Other colored table columns scale across displayed rows;
identical values remain neutral. Profile summaries compare against owners in the
selected era; lower deviation indicates more consistency. Identity, season counts,
and records are not colored.

The scoring matrix colors finalized weeks only and excludes live weeks from its
color scale and above-median markers. Desktop layouts at 1280px and wider use a
full-width, compact matrix; smaller viewports retain horizontal scrolling.
Trends always shows all ownerships in the selected season, with stable owner
colors/line styles and a noninteractive legend. It tracks the cumulative sum of
score minus each week's league median, with a zero baseline and no live scores.
The visible 2022 manual correction sentence is omitted, but its provenance and
corrected championship remain preserved in the archive and API.

`server/identities.js` explicitly links ESPN manager keys to stable canonical
IDs and Sleeper user IDs. Display names and team names are never used as runtime
identity joins. Daniel Pyo / Ethan Miller, present in 2018–2020, remains a
separate inactive identity from the current Ethan Miller. Unrecognized live user IDs get a
namespaced `sleeper:` identity rather than an inferred historical match.

Additional API behavior (all responses remain `no-store`):

- `GET /api/seasons`: current season and available archive seasons.
- `GET /api/dashboard?season=YYYY`: selected season; an unavailable year returns
  404. Archive responses include `source`, `provenance`, and `recap`, with no live
  matchups or draft board. Omission preserves the current-season response.
- `GET /api/owners?era=all|ten-team`: career totals and season rows, plus applied
  era, qualifying seasons/team counts, current-data availability and staleness.
  Omitting era defaults to all; invalid values return 400. Historical results
  work even during a cold Sleeper outage. Failed updates retain data only for the
  matching era, and late responses cannot overwrite a newly selected era.
- `POST /api/refresh`: always refreshes only the current Sleeper season.

To regenerate from the original dashboard locally, run from this directory:

```sh
npm run import:history -- ../index.html data/history.json
```

The importer parses embedded JSON without executing HTML/JavaScript, then applies
the bundled full-precision API extract in `data/espn-scores.json`. It requires that
extract and will not silently fall back to the HTML's rounded scores. It checks
all eight seasons, roster coverage, opponents, records, and totals before
writing. The imported artifact is deterministic and explicitly unignored.
Review its diff before committing. Neither root HTML nor ESPN credentials,
Python, or network access is needed to build or run the standalone service.

**Source precision:** all 1,224 archived weekly scores and the standings totals
have been retrieved directly from ESPN at their original API precision. No
rounding is applied during import or calculation; the UI displays points to two
decimals. Each season's records match exactly, and PF/PA reconcile within 0.000001
points (floating-point tolerance only). The historical 2020 matchup that looked
tied in the old rounded HTML is now correctly represented by its distinct scores.

To refresh the original ESPN extract, set `ESPN_S2` and `SWID` in your local process
environment and run `npm run fetch:history`. Do not commit credentials or put them
in the Render environment: ESPN is only contacted by this explicit maintenance
command. It validates all eight seasons before atomically replacing each data
file. Only scoring fields are retained, not authentication or raw member data.
The archive's owner links and manual championship corrections remain unchanged.

Tests cover imported/source reconciliation, corruption rejection, owner links,
career weighting, archived HTTP access without live data, tab/owner interactions,
keyboard navigation, and late-response race protection. DOM tests are not a
substitute for a visual browser check at mobile, tablet, and desktop widths.

## Records and Head-to-Head

Both tabs default to the 10-team era, determined by actual season team counts.
Their era and owner selections are independent of the season selector.

Records ranks finalized regular-season results in eleven categories, showing the
top five plus everyone tied at the cutoff. Season totals and percentages include
ongoing seasons, explicitly labeled with their number of finalized games; no
minimum-games qualification is imposed. Win streaks follow an owner's consecutive
qualifying regular-season games across seasons and reset on a loss or tie.
Closest matchups include ties and appear once per game. Record links open the
season scoreboard with the owner highlighted.

Head-to-Head starts with empty owner selectors. Summaries report W–L–T, PF/PA and
averages from Owner A's perspective. Ties reset the current series win streak.
The comparison displays both owners side by side with muted performance shading
and W–L records. Its All games / Regular season / Playoffs control filters both
the comparison and matchup history, recomputing totals, averages and streaks for
the selected stage. The choice is retained in `h2hStage=all|regular|playoff` URL
state; the API accepts the equivalent `stage` parameter (default `all`, invalid
values return 400). Cached results and request race protection include this stage.
The sortable history includes finalized regular-season games and 40 scored ESPN
championship-bracket games from 2018–2025. Byes and consolation games are excluded.
Current Sleeper postseason and live scores are excluded. Historical playoff
scores retain the original HTML's one-decimal precision; regular-season scores
continue using the original API precision. The corrected 2022 final is preserved,
including its matchup-level correction provenance and championship designation.
Regenerating with `npm run import:history` reproduces this additional playoff data
offline; production still needs only the bundled archive.

- `GET /api/records?era=all|ten-team`: grouped records, qualifying seasons,
  current-data availability and freshness. Default era is `ten-team`.
- `GET /api/head-to-head?era=all|ten-team&ownerA=gaurav&ownerB=jake`:
  owner options, summary and matchup history. Missing either owner returns an
  empty comparison. Unknown/duplicate owners and invalid eras return 400.

Shareable links: `?tab=records&recordsEra=ten-team` and
`?tab=head-to-head&h2hEra=ten-team&ownerA=gaurav&ownerB=jake`.
Changing tabs, seasons or refreshing preserves selections and rivalry sorting.
Requests are race-protected, and failed updates retain only matching cached
era/pair results. Both APIs work independently of live refreshes and serve
historical results even when Sleeper has no usable snapshot. No browser polling
or additional upstream requests are introduced.

## Draft board

The Draft Board tab shows rounds by draft slot, labeled with mapped manager
names. Cells use player last names, overall pick numbers, positions, and NFL
teams from Sleeper's draft/picks endpoints; full names are available on hover.
The grid scrolls horizontally on narrow screens with sticky round labels.
Completed drafts refresh at most daily through the shared server refresh;
unfinished drafts can refresh every minute. Draft data is cached atomically in
`DATA_DIR/LEAGUE_ID/draft.json` and restored on startup. Draft failures retain
the saved board without interrupting league scores. No browser polling is added.

References: [Render disks](https://render.com/docs/disks),
[monorepo deployment](https://render.com/docs/monorepo-support),
[Sleeper API](https://docs.sleeper.com/).
