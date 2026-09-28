# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, no-server web app (Vite + vanilla JS) that is a dashboard,
visibility calculator, and now (Milestone 2) a write front-end for a small
group following up gravitationally lensed supernovae. There is no backend:
all structured data (facilities, people, rules/workflow) and all
per-candidate work items live as YAML and GitHub issues in the sibling
private repo `lensed-sn-data` (checked out alongside this one, e.g.
`../lensed-sn-data`). This repo talks to that repo entirely via the GitHub
API (Octokit) using a personal access token pasted by the user and kept in
`localStorage` — a fine-grained PAT with Contents: read-only and Issues:
**read & write** (bumped from read-only once Milestone 2 added writes).

The full design spec (data model, issue conventions, milestones) is
`lensed-sn-tracker-plan_v2.md` at the repo root — read it before making
structural changes. **Milestone 1** (read-only dashboard) and the write
half of **Milestone 2** (new-candidate/add-task/trigger/change-status) are
built; GitHub OAuth via a Cloudflare Worker (the rest of Milestone 2) was
deliberately deferred — see "Auth" below.

## Commands

```sh
npm install
npm run dev       # Vite dev server, http://localhost:5173
npm test          # vitest run — visibility.test.js, write.test.js
npm run build     # -> dist/, what .github/workflows/deploy.yml deploys
npm run preview   # serve the production build locally
```

Run a single test file: `npx vitest run test/visibility.test.js`.
Run a single test by name: `npx vitest run -t "airmass is 1 at zenith"`.
There is no lint script configured.

## Architecture

**Data flow is one-directional and centralized in `src/lib/data.js`:**
`loadAppData(token)` creates an Octokit client, fetches and parses
`facilities.yaml` / `people.yaml` / `rules.yaml`, lists every
`type:candidate` issue from the data repo, and returns one `ctx` object
(`{ client, config, facilities, people, rules, candidates }`). `main.js`
loads this once at boot and passes the same `ctx` to every page; sub-issues
(tasks) and comments for a single candidate are fetched on demand via
`loadCandidateDetail(client, candidate)` when its page is opened. Pages
never call Octokit or parse YAML directly — that always goes through
`src/lib/`.

**The issue-body format is the wire format between GitHub and the app.**
Every candidate/task issue body is one fenced ` ```yaml ` block (parsed by
`src/lib/yaml.js#parseIssueBody`) followed by free-text notes. The GitHub
issue form templates in `../lensed-sn-data/.github/ISSUE_TEMPLATE/` use a
single `render: yaml` textarea per template for exactly this reason: GitHub
renders that field wrapped in a ` ```yaml ` fence automatically, so an issue
filed through the GitHub UI and a candidate/task written by this app end up
byte-for-byte the same shape.

**Sub-issues are associated to a candidate by label, not by GitHub's native
sub-issue links.** A candidate's tasks are every issue in the data repo
carrying that candidate's `cand:<id>` label (minus `type:candidate` itself)
— see `listCandidateSubIssues` in `src/lib/github.js`. Don't assume the
GitHub REST "sub-issues" API is in use anywhere.

**`rules.yaml` drives the workflow; nothing about statuses is hard-coded.**
`src/lib/rules.js` reads `rules.statuses` to resolve a status's label/color
(`getStatus`), the next-steps text (`nextStepsFor`), and the transition menu
(`transitionsFor` — declared transitions first, then every other status as
"other", so an unanticipated path is never blocked). A candidate whose
`status` doesn't match any id in `rules.yaml` should render as an "unknown
status" pill (see `statusPillHtml` in `src/lib/format.js`), not be hidden or
throw.

**Role resolution has a strict 3-level fallthrough** (plan §4.1), implemented
in `resolveRole`/`resolveAllRoles` (`src/lib/rules.js`): a candidate's own
`roles_override.<role>` wins, else `people.yaml`'s `roles.<role>.holder`,
else the role is `unassigned` (flagged in the UI, never silently blank).

**The visibility engine (`src/lib/visibility.js`) is the trickiest module.**
astronomy-engine has no built-in "horizon coords for an arbitrary fixed
RA/Dec" call; the pattern used here is to `DefineStar` the candidate's J2000
RA/Dec into the library's reserved `Star1` slot, then read it back with
`Equator(..., ofdate=true)` (which applies precession/nutation/aberration)
before converting to alt/az with `Horizon`. `DefineStar` is global mutable
state, so every sample (target + Sun + Moon) happens synchronously inside
`sampleInstant` with no `await` in between — never introduce an async gap
between a `DefineStar` call and the matching `Equator`/`Horizon` reads, or
concurrent candidate computations will corrupt each other's star slot.
Nightly windows are found by brute-force sampling a rolling 24h window (not
a fixed UTC day, so a night is never split across two windows) anchored
near local solar noon via longitude, at `sampleMinutes` resolution — there's
no rise/set search. Airmass uses the plain secant approximation, which only
means anything above the altitude/airmass cutoff already being enforced.

A facility can be `space_based: true` (e.g. JWST) — it has no geographic
`site`, so ground altitude/airmass is meaningless for it. Every call site
that loops over facilities and might reach `nightlyVisibility`/
`upcomingVisibility` must skip such facilities instead of passing their
(absent) site through: `visibilityTonightAcrossFacilities` filters them out
of both the count and the denominator, `candidate.js`'s visibility panel
renders a text note instead of a night grid for them, and `buildTriggerMailto`
(`write.js`) gives them their own status line rather than "not visible
tonight". If you add another code path that iterates `facilities`, check
`facility.space_based` before touching `facility.site`.

**Routing is a ~40-line hand-rolled hash router** (`src/router.js`): register
`route('/pattern/:id', handler)`, then `start()`. Each page module exports a
single `render(container, ctx[, params])` and owns its own DOM (built via
template strings + `escapeHtml`, no virtual DOM). `src/pages/candidate.js`
looks up the candidate by either its `data.id` (from the parsed YAML) or, if
that YAML failed to parse, a `issue-<number>` fallback route id — see
`candidateRouteId`/`findCandidate` in both `dashboard.js` and `candidate.js`
(kept in sync manually; there's no shared route-id helper yet).

**Auth is deliberately swappable.** `src/lib/auth.js` is the only place that
knows the token lives in `localStorage`; a future GitHub OAuth swap (via a
Cloudflare Worker, per the plan) replaces this without touching
`src/lib/github.js` or any page — that's *why* it's still a pasted PAT
today rather than OAuth: the write features were higher-value to build
first and don't depend on which auth flow hands the app its token.

**Writes go through `src/lib/write.js`, never straight from a page.** It
owns every title/label/body-shape convention from plan §5.1/§5.2 in one
place (`buildCandidateIssue`, `buildTaskIssue`, `changeCandidateStatus`,
`buildTriggerMailto`), on top of the raw REST calls in `src/lib/github.js`
(`createIssue`, `getIssue`, `updateIssueBody`, `addLabels`, `removeLabel`).
Two things worth knowing before touching this:
- **Labels auto-create on write**, confirmed against the live API — both
  `issues.create`'s `labels` array and `issues.addLabels` create a label
  that doesn't exist yet (default gray). This is *different* from GitHub's
  issue-form `labels:` defaults (which only apply pre-existing labels,
  the reason `lensed-sn-data`'s `label-candidate.yml` Action exists at
  all) — don't assume that restriction applies here too.
- **`changeCandidateStatus` re-fetches the issue immediately before
  writing** (`getIssue` right before mutating), to shrink — not eliminate —
  the race window with an edit made directly on GitHub between page load
  and clicking "Update status". There's no real optimistic-concurrency
  check (no ETag/If-Match); a true conflict just means last-write-wins.
- Any page that calls a write must also fix up `ctx` afterward:
  `refreshCandidates(ctx)` (`src/lib/data.js`) re-fetches and replaces
  `ctx.candidates`' contents in place after a candidate is created or a
  status changes — `ctx.candidates` is otherwise a snapshot from boot and
  won't reflect the write on its own. Adding a task doesn't need this,
  since `loadCandidateDetail` always re-fetches sub-issues fresh.

## Config

`config.json` at the repo root (`dataRepo`/`codeRepo` owner+name, auth mode,
default time display) is read once by `src/lib/data.js` via a static Vite
JSON import. Moving either repo to a different GitHub org/account is a
one-line edit here plus a redeploy — don't hardcode repo names anywhere
else.
