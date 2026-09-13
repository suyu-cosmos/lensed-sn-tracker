# lensed-sn-tracker

Read-only dashboard and visibility engine for a ~20-person group following up
gravitationally lensed supernovae. Static web app, no server: structured data
lives as YAML in the private [`lensed-sn-data`](../lensed-sn-data) repo, and
per-candidate work lives as GitHub issues there. See
`lensed-sn-tracker-plan_v2.md` for the full design.

## Milestone 1 (this scaffold)

- Load `facilities.yaml`, `people.yaml`, `rules.yaml` and every
  `type:candidate` issue from the data repo via a pasted GitHub PAT.
- Dashboard: candidate / status / leads / visible-tonight / next action.
- Candidate page: roles, per-facility visibility for tonight + the next
  `lookahead_nights` nights, tasks, observation log, next steps, comments.
- Resources and People pages as sortable tables.
- `setup-labels.js` (in the data repo) creates every label idempotently.

## Getting started

```sh
npm install
npm run dev       # http://localhost:5173
npm test          # vitest, mainly the visibility engine
npm run build     # -> dist/, deployed by .github/workflows/deploy.yml
```

On first load the app asks for a GitHub personal access token. Use a
fine-grained token scoped to the `lensed-sn-data` repo with **Issues:
read-only** and **Contents: read-only**; it is kept in `localStorage` only
(Milestone 2 replaces this with GitHub OAuth via a Cloudflare Worker).

## Config

`config.json` at the repo root is the single migration point described in
the plan: change `dataRepo`/`codeRepo` and re-deploy to move to a new GitHub
org or account.

## Layout

```
src/
  lib/
    auth.js         PAT storage (localStorage)
    github.js       Octokit wrapper: yaml files, candidate/sub-issues, comments
    yaml.js         parses the fenced ```yaml block in every issue body
    data.js         assembles one app-state snapshot from the above
    rules.js        status lookup, transitions, role resolution (plan §4.1/§6.1)
    visibility.js   Sun/Moon/airmass visibility engine (astronomy-engine)
    format.js       small HTML/date formatting helpers
    sortable.js      click-to-sort table headers
  pages/            one render(container, ctx[, params]) module per route
  router.js         minimal hash router
  main.js           PAT gate -> load data -> mount router
test/
  visibility.test.js
```
