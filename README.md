# lensed-sn-tracker

Dashboard, visibility engine, and write front-end for a ~20-person group
following up gravitationally lensed supernovae. Static web app, no server:
structured data lives as YAML in the private
[`lensed-sn-data`](../lensed-sn-data) repo, and per-candidate work lives as
GitHub issues there. See `lensed-sn-tracker-plan_v2.md` for the full design.

## Milestone 1 — read-only dashboard

- Load `facilities.yaml`, `people.yaml`, `rules.yaml` and every
  `type:candidate` issue from the data repo via a pasted GitHub PAT.
- Dashboard: candidate / status / tracks / main lead / visible-tonight / next action.
- Candidate page: roles, per-facility visibility for tonight + the next
  `lookahead_nights` nights, tasks, observation log, next steps, comments.
- Resources and People pages as sortable tables.
- `setup-labels.js` (in the data repo) creates every label idempotently.

## Milestone 2 — writing from the app (auth still a pasted PAT — see below)

- **+ New candidate** page: creates the parent issue (YAML block +
  `type:candidate`/`status:*`/`cand:<id>` labels) directly via the API.
- **Add task** (on the candidate page): creates a trigger/observation/
  analysis/decision sub-issue with `cand:`/`facility:` labels set.
- **Trigger** (add-task with type `trigger`): also surfaces a pre-filled
  `mailto:` link to the facility's PI contact with coordinates, a finder
  chart, and tonight's visibility window at that facility.
- **Change status**: updates the candidate's YAML `status:` field *and*
  swaps its `status:*` label to match, closing the drift the two could get
  into if only one were updated by hand.
- GitHub OAuth via a Cloudflare Worker (replacing the pasted PAT) was
  deliberately **not** built yet — see CLAUDE.md's "Auth" note for why and
  what would need to change to add it.

## Getting started

```sh
npm install
npm run dev       # http://localhost:5173
npm test          # vitest — visibility engine + write payload builders + yaml date-parsing
npm run build     # -> dist/, deployed by .github/workflows/deploy.yml
```

On first load the app asks for a GitHub personal access token. Use a
fine-grained token scoped to the `lensed-sn-data` repo with **Contents:
read-only** and **Issues: read & write** (bumped from read-only now that
Milestone 2 writes issues); it is kept in `localStorage` only.

## Config

`config.json` at the repo root is the single migration point described in
the plan: change `dataRepo`/`codeRepo` and re-deploy to move to a new GitHub
org or account.

## Layout

```
src/
  lib/
    auth.js         PAT storage (localStorage)
    github.js       Octokit wrapper: reads + writes (issues, labels, yaml files, comments)
    yaml.js         parses/serializes the fenced ```yaml block in every issue body
    data.js         assembles one app-state snapshot; refreshCandidates() after a write
    rules.js        status lookup, transitions, role resolution (plan §4.1/§6.1)
    visibility.js   Sun/Moon/airmass visibility engine (astronomy-engine)
    write.js        title/label/body conventions for every write (new candidate, add task, change status, trigger mailto)
    format.js       small HTML/date formatting helpers
    sortable.js      click-to-sort table headers
  pages/            one render(container, ctx[, params]) module per route,
                    including new-candidate.js; candidate.js also wires the
                    add-task and change-status forms
  router.js         minimal hash router
  main.js           PAT gate -> load data -> mount router
test/
  visibility.test.js
  write.test.js
```
