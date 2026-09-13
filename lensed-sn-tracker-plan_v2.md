# Lensed SN follow-up tracker — data model and build plan

A coordination tool for a ~20-person group following up gravitationally lensed supernovae. This document is the specification to hand to Claude Code. It is organised as: architecture, repositories, data files, GitHub issue conventions, status rules, web-app config, and milestones.

---

## 1. Architecture summary

- **Frontend**: static single-page web app (plain HTML/JS or a light framework such as Preact/Vite), hosted on GitHub Pages from the public code repo.
- **Backend**: GitHub itself. Structured data lives as YAML in a private data repo; per-candidate work lives as GitHub issues and sub-issues in that same repo.
- **Auth**: milestone 1 uses a GitHub personal access token pasted by the user (stored in the browser). Milestone 2 adds proper GitHub OAuth via a small Cloudflare Worker.
- **Compute**: visibility, airmass, moon separation and time-delay reminders are computed client-side in JavaScript. No server.

## 2. Repositories

| Repo | Visibility | Contents |
|---|---|---|
| `suyu-cosmos/lensed-sn-tracker` | public | Web app source, GitHub Pages build, docs, tests |
| `suyu-cosmos/lensed-sn-data` | private | `facilities.yaml`, `people.yaml`, `rules.yaml`, issue templates, all candidate issues |

Both repos will later be transferred to the production account. All owner/repo names are read from one config file (section 7) so migration is a transfer plus one edit.

## 3. `facilities.yaml` — observing resources

One entry per facility. Instruments are nested so a facility with several instruments appears once in visibility calculations.

```yaml
facilities:
  - id: vlt                       # short unique key, lowercase
    name: ESO Very Large Telescope
    site:
      name: Cerro Paranal
      latitude: -24.6275          # degrees, north positive
      longitude: -70.4044         # degrees, east positive
      elevation_m: 2635
      timezone: America/Santiago
    aperture_m: 8.2
    min_altitude_deg: 30          # site-specific horizon / pointing limit (optional, default 30)
    max_airmass: 2.0              # optional, default 2.0
    access:
      type: too                   # too | queue | classical | rapid_response | service
      program_id: "0110.D-1234"
      response_time_h: 24         # typical delay from trigger to observation
      semester_end: 2027-03-31    # when the allocation expires
      remaining_hours: 6.5        # optional, updated by hand
    contact:
      pi: mkim                    # id from people.yaml
      group_holder: suyu          # group member who holds / can trigger the time
      email: pi@example.org
      trigger_method: p2 tool     # free text: email, web form, phone, p2 tool...
      trigger_url: https://www.eso.org/p2
    instruments:
      - id: xshooter
        name: X-shooter
        modes: [spectroscopy]
        wavelength_um: [0.3, 2.5]
        limiting_mag: 22.5        # rough, for one-hour exposure
        notes: "UVB+VIS+NIR simultaneous; slit 1.0 arcsec default"
      - id: fors2
        name: FORS2
        modes: [imaging, spectroscopy]
        filters: [u, g, R, I, z]
    notes: free text
```

Allowed `modes`: `imaging`, `spectroscopy`, `ifu`, `nir_imaging`, `polarimetry`, `high_resolution_spectroscopy`.

## 4. `people.yaml` — members and roles

```yaml
people:
  - id: suyu                      # equals GitHub username
    name: Sherry Suyu
    email: suyu@example.org
    institution: MPA / TUM
    timezone: Europe/Berlin
    roles: [coordinator, lens_modeling_lead]
    expertise: [lens_modeling, time_delays]
  - id: mkim
    name: M. Kim
    roles: [spectroscopy_lead]
    facilities: [vlt, keck]       # facilities this person can trigger or holds time on

# Group-wide default roles. Each candidate can override these in its parent issue.
# `holder` is the default person in charge; `deputy` is pinged if the holder does not
# acknowledge a new task within `alerts.deputy_escalation_h` (rules.yaml).
roles:
  coordinator:           { holder: suyu,  deputy: mkim,  description: "Owns the tracker and overall priorities" }
  trigger_coordinator:   { holder: mkim,  deputy: arose, description: "Decides which facility to trigger and contacts PIs" }
  photometry_lead:       { holder: jlee,  deputy: arose, description: "Owns reduction and light curves" }
  spectroscopy_lead:     { holder: mkim,  deputy: jlee,  description: "Owns spectral reduction and classification" }
  lens_modeling_lead:    { holder: twong, deputy: suyu,  description: "Owns lens models and time-delay predictions" }
  data_manager:          { holder: arose, deputy: jlee,  description: "Owns data archiving and the observation log" }
```

### 4.1 Role resolution order

Roles differ from candidate to candidate, but no role may ever be empty. For "who is in charge of role X on candidate Y", the app resolves in this order:

1. The candidate's `roles_override.X` in its parent issue, if present.
2. Otherwise the group default `roles.X.holder` in `people.yaml`.
3. Otherwise the candidate leads, and the app flags the role as **unassigned** on the candidate page and in the daily digest.

The app displays the resolved person next to every step, with an "inherited" tag when the person came from level 2, so deliberate assignments and fall-throughs are visually distinct. Changing a global holder immediately updates all candidates that did not override that role. `candidate leads` is the only people-field required when creating a candidate; all other roles inherit.

## 5. GitHub issue conventions (the candidate database)

### 5.1 Parent issue = one lensed SN candidate

- Title: `[LSN-2026abc] short description` where `LSN-2026abc` is the internal candidate id (also used as label `cand:LSN-2026abc`).
- Labels: `type:candidate`, `status:<status>`, `cand:<id>`, `priority:<high|medium|low>`.
- Assignees: candidate leads (one or several).
- Body: a YAML block inside a fenced code block, which the web app parses. Everything after the block is free-text notes.

```yaml
# candidate
id: LSN-2026abc
tns_name: SN 2026abc
discovery_survey: LSST
discovery_date: 2026-09-08
ra_deg: 188.7363
dec_deg: 21.1200
lens:
  name: SDSS J1234+2107
  z_lens: 0.42
  type: galaxy               # galaxy | group | cluster
  n_images: 4
  image_positions:           # optional; arcsec offsets from lens centre
    - { label: A, dra: 1.21, ddec: -0.34 }
    - { label: B, dra: -0.88, ddec: 0.97 }
source:
  z_source: 1.05
  sn_type: unknown           # unknown | Ia | II | Ibc | SLSN | other
time_delays:                 # predicted, days relative to image A; filled by modeling
  predicted: { B: 9.5, C: 14.1, D: 31.0 }
  measured: {}
leads: [suyu, mkim]
roles_override:              # optional per-candidate overrides of group roles
  spectroscopy_lead: mkim
status: awaiting_classification_spectrum   # must match a status id in rules.yaml
false_positive_type: null    # set from rules.yaml vocabulary when status becomes false_positive
```

### 5.2 Sub-issues = follow-up tasks

Every unit of work is a sub-issue of the candidate's parent issue. Task types and their extra fields:

| `type:` label | Meaning | YAML fields in body |
|---|---|---|
| `type:trigger` | Request/schedule an observation | `facility`, `instrument`, `mode`, `requested_date`, `exposure`, `images: [A,B]`, `pi_contacted: bool`, `scheduled_utc` |
| `type:observation` | An observation that was taken | `facility`, `instrument`, `obs_utc`, `filters/setup`, `conditions`, `data_location`, `reduction_status: raw|reduced|published` |
| `type:analysis` | Photometry, classification, lens model | `product` (`lightcurve`, `spectrum_classification`, `lens_model`, `time_delay`), `result` (free text), `files` |
| `type:decision` | A choice the leads must make | `deadline`, `options` |

Labels also carry `cand:<id>` and `facility:<id>` where relevant. The assignee is the person in charge of that step. A closed sub-issue is a done step. A trigger sub-issue is normally converted into (or linked to) an observation sub-issue once data are taken.

### 5.3 Label set (created by a setup script)

- `type:candidate`, `type:trigger`, `type:observation`, `type:analysis`, `type:decision`
- `status:*` — one per status in `rules.yaml`
- `priority:high|medium|low`
- `facility:<id>` — one per facility
- `cand:<id>` — created when a candidate is added

### 5.4 Issue templates (`.github/ISSUE_TEMPLATE/`)

`candidate.yml`, `trigger.yml`, `observation.yml`, `analysis.yml` as GitHub issue forms, with fields that render into the YAML blocks above. The web app writes the same format, so issues created on GitHub and in the app are interchangeable.

### 5.5 Discussion

Comments on the parent issue = candidate-level discussion. Comments on a sub-issue = discussion about that step. The app shows both, threaded under the candidate page. No separate comment system.

## 6. `rules.yaml` — statuses, visibility criteria, next steps

```yaml
visibility:
  sun_altitude_max_deg: -12        # astronomical-ish twilight
  moon_separation_min_deg: 30
  default_max_airmass: 2.0
  min_window_minutes: 30
  lookahead_nights: 7

statuses:
  # The list below covers the first stages only. Later stages (monitoring,
  # trailing-image arrival, time-delay measurement, archiving) are added here
  # as the workflow matures; see "Extending statuses" below.
  - id: new_candidate
    label: New candidate
    color: gray
    next_steps:
      - "Confirm lensing nature through classification spectroscopy (SN redshift, lens redshift, SN type)"
      - "Assign candidate leads"
      - "Request high-resolution imaging (if not yet available through Euclid)"
    transitions:
      awaiting_classification_spectrum: "Classification spectrum requested"
  - id: awaiting_classification_spectrum
    label: Awaiting classification spectrum
    color: amber
    next_steps:
      - "Determine whether this is a strongly lensed SN or a false positive"
    transitions:
      lensed_sn: "Confirmed strongly lensed SN"
      false_positive: "Not a strongly lensed SN"
  - id: lensed_sn
    label: Confirmed lensed SN
    color: green
    next_steps:
      - "Trigger imaging monitoring"
      - "Trigger spectroscopic sequence"
      - "Trigger HST or JWST imaging"
  - id: false_positive
    label: False positive
    color: gray
    terminal: true                 # no further follow-up expected
    requires: [false_positive_type] # field that must be set in the candidate YAML on transition
    next_steps:
      - "Record the false-positive type and close open tasks"

# Controlled vocabularies referenced by candidate fields.
vocabularies:
  false_positive_type:
    - id: sn_in_lens
      label: SN in lens galaxy
    - id: not_strongly_lensed
      label: SN not strongly lensed
    - id: bogus
      label: Bogus transient

alerts:
  trailing_image_warning_days: 5   # flag candidate when predicted arrival is within N days
  stale_task_days: 3               # flag open trigger tasks with no update in N days
  deputy_escalation_h: 24          # ping the role deputy if a task is unacknowledged this long
```

### 6.1 Extending statuses

`rules.yaml` is the single source of truth for the workflow; nothing about statuses is hard-coded in the app. Requirements on the implementation:

- The app reads the `statuses` list at load time and builds the status pill, the dashboard filter, the "change status" menu (from `transitions`) and the next-steps panel from it. Adding a status is a one-block edit to `rules.yaml` plus one `status:<id>` label in the data repo, which `setup-labels.js` creates idempotently on re-run.
- `transitions` is advisory: the menu lists the declared transitions first, with an "other" option that allows any status, so an unanticipated path never blocks anyone.
- Each status may carry optional keys: `terminal` (excluded from the active dashboard), `requires` (candidate YAML fields that must be filled when entering the status; the app prompts for them), `color`, and `tasks_template` (a list of sub-issues to create automatically on entering the status, e.g. the three triggers under `lensed_sn`).
- Renaming a status id requires a migration: `setup-labels.js --rename old:new` relabels all issues. Prefer adding new statuses over renaming.
- Candidates whose `status` is not in the list are shown with a warning pill rather than hidden, so a typo in `rules.yaml` is visible, not silent.
- Vocabularies (`false_positive_type`, later `sn_type`, `lens_type`, etc.) follow the same pattern and populate dropdowns in the forms.

## 7. Web-app config (`config.json` in the code repo)

```json
{
  "dataRepo": { "owner": "suyu-cosmos", "name": "lensed-sn-data" },
  "codeRepo": { "owner": "suyu-cosmos", "name": "lensed-sn-tracker" },
  "auth": { "mode": "pat" },
  "defaultTimeDisplay": "UT"
}
```

Changing `owner` here and transferring the repos is the whole migration.

## 8. Pages and features by milestone

### Milestone 1 — read-only dashboard + visibility (aim: 1–2 weeks)
- Load `facilities.yaml`, `people.yaml`, `rules.yaml` and all `type:candidate` issues via the GitHub API using a PAT.
- Dashboard table: candidate, status, leads, "visible tonight: N of M" with facility names, next action (first open sub-issue by due date).
- Candidate page: header, visibility panel for tonight and next 7 nights (altitude curves, window, best airmass, moon separation), task list (sub-issues), observation log (`type:observation` sub-issues), suggested next steps from `rules.yaml`, threaded comments.
- Resources page and People page as sortable tables.
- Setup script that creates all labels in the data repo.

### Milestone 2 — writing from the app
- "New candidate" form → creates parent issue with YAML block and `cand:` label.
- "Add task" → creates sub-issue linked to parent.
- "Trigger" button → opens a pre-filled mailto to the PI with coordinates, finder-chart link, visibility window, and creates a `type:trigger` sub-issue.
- Change status → updates `status:` label.
- GitHub OAuth via Cloudflare Worker replaces the PAT.

### Milestone 3 — automation
- GitHub Action: nightly validation of YAML files; daily digest comment listing stale tasks and trailing-image alerts; optional Slack/email webhook.
- Light-curve panel from photometry attached to `type:analysis` issues (CSV in the issue or in the repo).
- iCal feed of scheduled observations.
- Candidate ingest from TNS / brokers (separate project, plugs into "New candidate").

## 9. Tech choices for Claude Code

- Vite + vanilla JS or Preact; Tailwind optional. Keep dependencies few.
- `astronomy-engine` (npm) for Sun/Moon/altitude; `js-yaml` for YAML; `octokit` for GitHub API.
- Tests with Vitest for the visibility engine (compare a few cases against known values).
- Deploy to Pages via a GitHub Actions workflow on push to `main`.

## 10. First prompt for Claude Code

> Read `lensed-sn-tracker-plan.md`. Scaffold the `lensed-sn-tracker` web app for Milestone 1 using Vite and vanilla JS, with `astronomy-engine`, `js-yaml` and `octokit`. Also generate the contents of the `lensed-sn-data` repo: `facilities.yaml`, `people.yaml` and `rules.yaml` with two example facilities and three example people, the four issue templates, and a `setup-labels.js` script. Add a GitHub Actions workflow to deploy to Pages. Explain each file briefly as you create it.
