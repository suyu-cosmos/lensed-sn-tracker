# lensed-sn-tracker

Dashboard, visibility engine, and write front-end for a ~20-person group
following up gravitationally lensed supernovae. Static web app, no server:
structured data lives as YAML in the private
[`lensed-sn-data`](../lensed-sn-data) repo, and per-candidate work lives as
GitHub issues there. See `lensed-sn-tracker-plan_v2.md` for the full design.

Live at https://suyu-cosmos.github.io/lensed-sn-tracker/. Current status
and what's next: §0 of `lensed-sn-tracker-plan_v2.md`.

## What it does

- **Dashboard**: one row per candidate — status (phase), track chips
  (● active · ○ not started · ⏳ waiting · ✓ done), main lead, "visible
  tonight: N of M", next action. Finished candidates hidden behind a toggle.
- **+ New candidate**: id, coordinates and main lead required; starting
  status and the roles relevant to it.
- **Candidate page**:
  - Roles card (phase-relevant roles; editable per candidate).
  - Change status: warns about open tasks; finished statuses close the
    candidate issue on GitHub, and moving back reopens it.
  - Per-facility visibility for tonight and the next nights.
  - Image timeline: detected / peak / faded dates; estimated time delay ±
    1σ, from which the predicted arrival date is computed.
  - Follow-up track cards for the current phase, with compact task lines.
  - Add task: **Trigger observation** (one of our facilities; PI + lead
    assigned; pre-filled PI email; nights of data recorded with
    **✎ Log observation**), **Archival observations** (survey, archive or
    other group's data), analysis, decision.
  - Observation log, discussion.
- **Resources** and **People** pages.
- All dates are shown and entered as yyyy-mm-dd.
- Auth is a pasted fine-grained PAT; GitHub OAuth via a Cloudflare Worker
  was deliberately not built yet (see CLAUDE.md "Auth").

## Getting started

```sh
npm install
npm run dev       # http://localhost:5173
npm test          # vitest — engine, builders, rules, yaml, and jsdom page/date-field tests
npm run build     # -> dist/, deployed by .github/workflows/deploy.yml
```

On first load the app asks for a GitHub personal access token. Use a
fine-grained token scoped to the `lensed-sn-data` repo with **Contents:
read-only** and **Issues: read & write**; it is kept in `localStorage` only.

## Config

`config.json` at the repo root is the single migration point described in
the plan: change `dataRepo`/`codeRepo` and re-deploy to move to a new GitHub
org or account.

## Layout

```
src/
  lib/
    auth.js         PAT storage (localStorage)
    github.js       Octokit wrapper: reads + writes (issues, labels, yaml files, comments); no browser cache
    yaml.js         parses/serializes the fenced ```yaml block in every issue body
    data.js         app-state snapshot; candidate detail; refreshCandidate / mergeTasks
    rules.js        statuses, transitions, roles (§4.1), tracks (§6.2), dashboard summaries, time-delay dates
    visibility.js   Sun/Moon/airmass visibility engine (astronomy-engine)
    write.js        every write's title/label/body convention (candidate, tasks, status, roles, observations, PI email)
    dateinput.js    yyyy-mm-dd date fields + calendar popup
    format.js       small HTML/date formatting helpers
    sortable.js     click-to-sort table headers
  pages/            one render(container, ctx[, params]) module per route:
                    dashboard, candidate (all candidate-page forms), new-candidate, resources, people
  router.js         minimal hash router
  main.js           PAT gate -> load data -> mount router; version stamp footer
test/               vitest; *.test.js per lib module, plus jsdom tests of the candidate page and date fields
```
