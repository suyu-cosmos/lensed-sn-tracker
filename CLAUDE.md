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

**Next up is Milestone 2.5 — workflow phases and tracks** (plan §6.2 for the
model, §8 "Milestone 2.5" for the step-by-step implementation plan with an
acceptance check). Short version: a candidate's `status` is its coarse
*phase* (new_candidate → awaiting_confirmation → lensed_sn "Live follow-up"
→ post_fade → data_complete, or false_positive), and the parallel science
workstreams inside a phase (photometric monitoring, spectroscopic
monitoring, HST/JWST, early-phase spectroscopy of each trailing image, …)
are *tracks* declared in `rules.yaml` and recorded on each task as
`track:`. Track state is derived from tasks, never stored; per-image tracks
are optional per image. Work through the plan's steps in order and mark
them `[done]` there as you go — the plan file is the source of truth for
what's built vs. pending, not this summary. Analysis tracking is
Milestone 4, after data gathering works.

## Commands

```sh
npm install
npm run dev       # Vite dev server, http://localhost:5173
npm test          # vitest run — visibility, write, rules (tracks), yaml tests
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

**Every YAML load goes through `JSON_SCHEMA`, never js-yaml's default.**
js-yaml's default schema auto-converts any bare `YYYY-MM-DD` (or full
ISO-8601 datetime) scalar into a native JS `Date`, in whichever timezone
the parsing machine happens to be in — which then stringifies as a
verbose, locale-dependent string wherever it's displayed via a template
literal instead of `formatUtc()`. `parseYamlFile`/`parseIssueBody`
(`src/lib/yaml.js`) both pass `{ schema: yaml.JSON_SCHEMA }` to `yaml.load`
specifically to keep every date/datetime field a plain string; don't call
`yaml.load` anywhere else without it. `yaml.dump` needs no matching
change — its default schema already quotes date-like strings on write, so
this is purely a load-side fix (for hand-typed unquoted dates on GitHub).

**Sub-issues are associated to a candidate by label, not by GitHub's native
sub-issue links.** A candidate's tasks are every issue in the data repo
carrying that candidate's `cand:<id>` label (minus `type:candidate` itself)
— see `listCandidateSubIssues` in `src/lib/github.js`. Don't assume the
GitHub REST "sub-issues" API is in use anywhere.

**`rules.yaml` drives the workflow; nothing about statuses is hard-coded.**
`src/lib/rules.js` reads `rules.statuses` to resolve a status's label/color
(`getStatus`), the next-steps text (`nextStepsFor`), and the transition menu
(`transitionsFor` — declared transitions first, then every other status as
"other", so an unanticipated path is never blocked). The order of
`rules.statuses` is the workflow order: `isBackwardTransition` uses it to
label a move to an earlier status "↩ Back to …" in the Change-status menu,
whose text after the dash is the transition's *reason* (it varies by origin
status), not part of the status name. A candidate whose
`status` doesn't match any id in `rules.yaml` should render as an "unknown
status" pill (see `statusPillHtml` in `src/lib/format.js`), not be hidden or
throw.

**Each phase declares its relevant roles** (`roles:` per status in rules.yaml;
`rolesForStatus`/`newlyRelevantRoles` in rules.js). They drive what the Roles
card shows up front, what Change-status prompts for on entering a phase, and
which rows the New-candidate form shows. They never change *resolution* —
an unlisted role still resolves via §4.1. Role edits write `roles_override`
with `updateCandidateFields(..., { replace: ['roles_override'] })` so "Group
default" actually removes a pin (deep-merge alone can't delete a key).

**`main_lead` is the candidate's owner** — there is no separate `leads` field
(it was merged into this role; old test data was deleted, so there's no
compatibility code for it). It must resolve at creation, is the candidate
issue's GitHub assignee, and is re-synced via `setIssueAssignees` when it
changes. People with `assignable: false` in people.yaml (the dev account)
never appear in pickers — use `assignablePeople`, not `people.people`.

**Role resolution has a strict 3-level fallthrough** (plan §4.1), implemented
in `resolveRole`/`resolveAllRoles` (`src/lib/rules.js`): a candidate's own
`roles_override.<role>` wins, else `people.yaml`'s `roles.<role>.holder`,
else the role is `unassigned` (flagged in the UI, never silently blank; no
fallback to any other field).

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

An instrument can be `group_holder`/`semester_start`/`semester_end`-
overridden (per-instrument, flat keys, not nested — see `resources.js`)
and/or `single_filter: true` (imaging instruments only — one filter
chosen per exposure, e.g. WFI, as opposed to a simultaneous multi-band
imager like GROND where a pick-one dropdown would misrepresent how it's
actually used). `single_filter` drives whether the Add-task trigger
form's "Wavelength band" picker (built from that instrument's `filters:`)
shows at all — see `wireFacilityCascade` in `candidate.js`. The same
function also shows/hides the trigger form's "Images" field based on the
*selected mode*, not the instrument: visible only for `mode ===
'spectroscopy'` or (`facility === 'jwst' && mode === 'ifu'`) — a narrow
aperture (long-slit, or JWST NIRSpec's small-FOV IFU) needs to know which
lensed image(s) it's pointed at; imaging and a wide-field IFU like MUSE
typically cover the whole lens system and don't. Hiding it also clears
its value, so a stale leftover doesn't sneak into a later submission.

**A `[hidden]` element can still render if your own CSS sets `display`
on it.** The browser's built-in `[hidden]{display:none}` rule is
user-agent-origin, which loses to *any* same-property author rule
regardless of selector specificity — hit this for real with `form label {
display: block }` overriding a hidden label. Fixed globally with
`[hidden] { display: none !important; }` near the top of `style.css`;
don't remove it, and don't add another rule that sets `display` on an
element type that might also carry `hidden` without checking this first.

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

**Freshness.** `makeClient` sets `cache: 'no-cache'` on every fetch, because
GitHub's `Cache-Control: max-age=60` otherwise lets the browser serve a
minute-old list. The candidate page re-reads GitHub (`refreshCandidate` +
`loadCandidateDetail`) on its ↻ Refresh button and when the tab becomes
visible again — skipped if any form on the page has been typed into
(`container.dataset.dirty`), so a refresh never wipes half-entered input.

**Candidate page layout (Milestone 2.5).** `renderCandidatePage` builds, in
order: header + Change-status (with the all-images-faded → post_fade *hint*),
Visibility, Suggested next steps, **Image timeline** (edits `image_dates` via
`updateCandidateFields`), **Follow-up tracks** (one card per track of the
current phase + "Other tasks"; phases without tracks fall back to a flat task
table), Add-task (Track selector first), Observation log, Discussion. Every
handler re-renders from data it already holds — the image-timeline save uses
`updateCandidateFields`' return value, add-task merges the created issue —
never from an immediate refetch. `wireFacilityCascade` takes an options object
with an `allowed()` getter returning the selected track, and returns
`{ refresh }` for the track selector to call.

**Track helpers live in `src/lib/rules.js`** (`tracksForStatus`, `trackState`,
`eligibleImages`, `trackInstruments`, `predictedArrivals`) — pages must use
these rather than re-deriving track state, so the §6.2 semantics (derived
state; untargeted per-image slots never block "done") stay in one place.
Tests use inline fixtures, never `../lensed-sn-data`, because CI (deploy.yml)
checks out only this repo.

**Writes go through `src/lib/write.js`, never straight from a page.** It
owns every title/label/body-shape convention from plan §5.1/§5.2 in one
place (`buildCandidateIssue`, `buildTaskIssue`, `changeCandidateStatus`,
`buildTriggerMailto`), on top of the raw REST calls in `src/lib/github.js`
(`createIssue`, `getIssue`, `updateIssueBody`, `addLabels`, `removeLabel`).
Things worth knowing before touching this:
- **`buildTriggerMailto` resolves its To/CC from `people.yaml`, not a
  static facility field.** To is the program PI — an instrument's own
  `pi:` overrides the facility-level `contact.pi` (facilities.yaml), since
  one facility can host more than one program with a different PI (vlt's
  SOXS vs. MUSE/FORS2). CC is the group-default lead matching the
  instrument's mode (`LEAD_ROLE_BY_MODE`: spectroscopy/ifu ->
  spectroscopy_lead, imaging/nir_imaging -> photometry_lead) plus
  `main_lead`, both resolved via `resolveRole` so a candidate's own
  `roles_override` wins here exactly as it does everywhere else — and
  deduped against the PI and each other. Every address is that person's
  own `email:` in `people.yaml`.
- **An assignee who isn't a repo collaborator makes GitHub reject the
  whole `issues.create` with 422** (confirmed live — it is *not* silently
  dropped). On exactly that error `createIssue`/`setIssueAssignees` check
  each assignee (`checkUserCanBeAssigned`: 204 vs 404), retry once with
  only the assignable ones, and return the rest as `droppedAssignees`/
  `dropped`; pages warn instead of failing.
- **Trigger tasks get two assignees:** the program PI (`resolvePi` —
  instrument `pi:` over facility `contact.pi`) plus the track role's holder
  (e.g. spectroscopy_lead), deduped. Other task types get the role holder only.
  Placeholder GitHub usernames in `people.yaml` (stefant, alejandram,
  yushanx) hit this until replaced with real, invited accounts.
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
- **Any GitHub list/search endpoint can lag behind a write you just made
  through a different endpoint** — hit this three separate times (new
  candidate, add task, change status) before recognizing it as one
  pattern, not three bugs. `listCandidateIssues`/`listCandidateSubIssues`
  are both label-filtered list queries, and each has a brief propagation
  lag right after the matching write, so calling one immediately after
  creating or updating the very issue it's supposed to return can hand
  back stale or missing data — a new candidate's own page saying "No
  candidate found", a just-added task not showing in "Tasks", a status
  change on the candidate page appearing to silently do nothing. There
  used to be a `refreshCandidates(ctx)` helper (`src/lib/data.js`) built
  on exactly this kind of refetch — it's gone now; don't re-add it or
  anything shaped like it.
  - The fix is always the same: **use the data the write call already
    handed back, instead of asking GitHub for it again.**
    `createIssue`'s response has the full new issue — `new-candidate.js`
    parses its `.body` and pushes `{ issue, data, notes }` straight into
    `ctx.candidates`; `wireAddTaskForm` does the same for a new task via
    `buildTaskFromIssue(issue)` (`src/lib/data.js`), merging it into
    whatever `loadCandidateDetail` returned via `mergeTasks` — together with
    every task the page already held, since the lagging list can omit a task
    created a minute earlier too (two triggers added back to back).
    `changeCandidateStatus` already returns the fully-updated `nextData`
    — `wireChangeStatusForm` assigns it straight onto `candidate.data`
    (same object reference held in `ctx.candidates`) rather than
    re-deriving it from a refetch.
  - If you add another write, ask first whether its own response already
    contains everything the next render needs — it almost certainly does.

## Config

`config.json` at the repo root (`dataRepo`/`codeRepo` owner+name, auth mode,
default time display) is read once by `src/lib/data.js` via a static Vite
JSON import. Moving either repo to a different GitHub org/account is a
one-line edit here plus a redeploy — don't hardcode repo names anywhere
else.
