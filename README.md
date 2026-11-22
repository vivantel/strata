# strata

Local, lossless index of Claude Code sessions. Reads the outcome meters of `docs/outcomes/ecosystem-human-minutes.md`. Design: `docs/decisions/2026-11-22-strata-design.md`. Private for now; no dependencies; Node >= 22.13 (`node:sqlite`, experimental, all SQL in `src/db.mjs`).

```
node bin/strata.mjs ingest --root ~/.claude/projects/<project-dir>   # incremental, idempotent
node bin/strata.mjs coverage                                         # every event type: classified, ignored, UNKNOWN
node bin/strata.mjs query human-minutes-per-merged-pr --repo termenbox --by week [--idle-min 2|5|15] [--rows]
node bin/strata.mjs query interventions-per-100-calls --repo termenbox
node bin/strata.mjs query missions
node bin/strata.mjs snapshot --file prs.json      # merge state; `--gh owner/repo` is the only network use
node bin/strata.mjs export                        # counts and flags only
npm test
```

The index defaults to `~/.local/share/strata/index.sqlite` (mode 0600) and holds full message text. Never commit it or export from it other than with `export`.

Reading the numbers:

- `active_min` is the union of gaps between consecutive events no longer than the idle threshold. It counts time the agent works while the owner is attached, so it is an upper-side proxy; `prompts`, `prompt_weighted_min` and `wall_clock_min` sit beside it and are never blended into it.
- Without a `gh` snapshot the denominator is "PRs linked", not "PRs merged".
- `flagged_share` is the share of minutes in sessions that link more than one PR; those minutes are attributed to the PR most recently linked.
