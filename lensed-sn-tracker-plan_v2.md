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
time_delays:                 # days, t_X - t_reference (may be negative); filled by modeling
  reference_image: A
  predicted: { B: 9.5, C: 14.1, D: 31.0 }
  predicted_err: { B: 2.0, C: 3.0, D: 8.0 }   # 1 sigma, days       [Milestone 2.5]
  measured: {}
  measured_err: {}                            #                      [Milestone 2.5]
image_dates:                 # per-image milestones, set by photometry  [Milestone 2.5]
  A: { detected: 2026-09-08, peak: 2026-09-20, faded: null }
  B: { detected: null, peak: null, faded: null }
leads: [suyu, mkim]
roles_override:              # optional per-candidate overrides of group roles
  spectroscopy_lead: mkim
status: awaiting_confirmation   # must match a status id in rules.yaml
false_positive_type: null    # set from rules.yaml vocabulary when status becomes false_positive
```

`image_dates` is the event record the workflow model (§6.2) keys off: a trailing image's
`detected` date opens early-phase spectroscopy for it, and every image having a `faded` date
is the trigger to leave live follow-up. Combined with `time_delays.predicted ± predicted_err`
it also gives the "next image expected ~date ± err" shown on the candidate page and, later,
the trailing-image alert (Milestone 3).

### 5.2 Sub-issues = follow-up tasks

Every unit of work is a sub-issue of the candidate's parent issue. Task types and their extra fields:

| `type:` label | Meaning | YAML fields in body |
|---|---|---|
| `type:trigger` | Request/schedule an observation | `facility`, `instrument`, `mode`, `requested_date`, `exposure`, `images: [A,B]`, `pi_contacted: bool`, `scheduled_utc` |
| `type:observation` | An observation that was taken | `facility`, `instrument`, `obs_utc`, `filters/setup`, `conditions`, `data_location`, `reduction_status: raw|reduced|published` |
| `type:analysis` | Photometry, classification, lens model | `product` (`lightcurve`, `spectrum_classification`, `lens_model`, `time_delay`), `result` (free text), `files` |
| `type:decision` | A choice the leads must make | `deadline`, `options` |

Labels also carry `cand:<id>` and `facility:<id>` where relevant. The assignee is the person in charge of that step. A closed sub-issue is a done step. A trigger sub-issue is normally converted into (or linked to) an observation sub-issue once data are taken.

**Added in Milestone 2.5 (all optional, all task types unless noted):**

| Field | Meaning |
|---|---|
| `track` | Id of the follow-up track this task belongs to (§6.2). Also set as label `track:<id>`. Tasks without a track still work and are shown under "Other tasks". |
| `image` | For tasks in a `per_image` track: which trailing image this task targets (e.g. `B`). |
| `role` | Role responsible (e.g. `photometry_lead`); defaults from the track. The assignee is resolved from it via §4.1, and `alerts.deputy_escalation_h` uses `people.roles[role].deputy`. |
| `cadence_days`, `until` | Trigger only: a recurring monitoring campaign is **one** trigger issue with a cadence, not one issue per epoch. `cadence_days: null` = one-off. |
| `epochs` | Observation only: list of `{obs_utc, filters/setup, conditions}` appended per epoch of a campaign, so one observation issue logs a whole cadence. |

`exposure` stays in the schema but is not collected by the app's form; it is left for the PI / trigger coordinator.

### 5.3 Label set (created by a setup script)

- `type:candidate`, `type:trigger`, `type:observation`, `type:analysis`, `type:decision`
- `status:*` — one per status in `rules.yaml`
- `priority:high|medium|low`
- `facility:<id>` — one per facility
- `cand:<id>` — created when a candidate is added
- `track:<id>` — one per track in `rules.yaml` (Milestone 2.5)

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
  # Candidate PHASES (see §6.2). Parallel work inside a phase is a TRACK, not a status.
  # Target model for Milestone 2.5 — ids new_candidate/awaiting_confirmation/lensed_sn/
  # false_positive already exist in the live rules.yaml; post_fade/data_complete and the
  # `tracks:` keys are added in Milestone 2.5.
  - id: new_candidate
    label: New candidate
    color: gray
    next_steps:
      - "Confirm lensing nature through classification spectroscopy (SN redshift, lens redshift, SN type)"
      - "Assign candidate leads"
      - "Request high-resolution imaging (if not yet available through Euclid)"
    transitions:
      awaiting_confirmation: "Confirmation spectroscopy/imaging requested"
  - id: awaiting_confirmation        # renamed from awaiting_classification_spectrum (done)
    label: Awaiting confirmation
    color: amber
    next_steps:
      - "Spectroscopy: show z_SN > z_lens"
      - "Or imaging (ideally high-resolution) showing multiple variable SN images"
      - "Determine whether this is a strongly lensed SN or a false positive"
    transitions:
      lensed_sn: "Confirmed strongly lensed SN"
      false_positive: "Not a strongly lensed SN"
  - id: lensed_sn                    # id kept; this is the LIVE phase (steps 3a, 3b, 4)
    label: Live follow-up
    color: green
    tracks: [phot_monitoring, spec_monitoring, space_followup, next_image_early_phase_spec]
    next_steps:
      - "Start photometric monitoring (daily / every other day) on all images"
      - "Start spectroscopic monitoring (~weekly)"
      - "Trigger HST/JWST imaging + spectroscopy of the lens system"
      - "Record each image's detected/peak/faded dates as they happen"
    transitions:
      post_fade: "All SN images have faded"
  - id: post_fade                    # step 5
    label: Post-fade lens follow-up
    color: blue
    tracks: [lens_followup]
    next_steps:
      - "High-resolution imaging of the lens system without the SN"
      - "Spatially resolved kinematics of the lens"
    transitions:
      data_complete: "Lens-system data complete"
      lensed_sn: "Late-time SN data needed (re-brightening, missed image)"
  - id: data_complete
    label: Data complete
    color: gray
    terminal: true                   # data gathering done; analysis tracked separately (Milestone 4)
    next_steps:
      - "Close open data-gathering tasks; record data locations"
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

# Follow-up TRACKS (Milestone 2.5, §6.2): parallel workstreams inside a phase.
tracks:
  - id: phot_monitoring
    label: Photometric monitoring
    role: photometry_lead
    task_type: trigger
    modes: [imaging, nir_imaging]
    default_cadence_days: 1          # daily / every other day
    purposes:
      - "Catch first appearance of the next image (gates early-phase spectroscopy)"
      - "Light curves of all images → time delays"
      - "Light curves for SN properties"
  - id: spec_monitoring
    label: Spectroscopic monitoring
    role: spectroscopy_lead
    task_type: trigger
    modes: [spectroscopy, ifu]
    default_cadence_days: 7          # ~weekly or slower
    purposes:
      - "Spectroscopic time delays"
      - "SN spectral evolution (explosion physics)"
  - id: space_followup
    label: HST/JWST imaging & spectroscopy
    role: lens_modeling_lead
    task_type: trigger
    facilities: [hst, jwst]
    purposes:
      - "High-resolution imaging of lensed arcs for lens mass modelling"
      - "Lens-galaxy kinematics for lens mass modelling"
      - "Additional SN spectroscopy"
  - id: next_image_early_phase_spec
    label: Spectroscopy of early phase of next SN image from appearance
    role: spectroscopy_lead
    task_type: trigger
    modes: [ifu, spectroscopy]
    instruments: [vlt/muse]          # current choice; edit here to swap/add instruments
    starts_on: image_detected        # a trailing image's image_dates.<X>.detected
    per_image: true                  # eligible for every trailing image, required for none
    purposes:
      - "SN progenitors from the earliest phase"
      - "Spectroscopy of galaxies in the lens environment (environment, external convergence)"
  - id: lens_followup
    label: Post-fade lens-system follow-up
    role: lens_modeling_lead
    task_type: trigger
    purposes:
      - "High-resolution imaging and spatially resolved lens kinematics after the SN fades"
```

### 6.1 Extending statuses

`rules.yaml` is the single source of truth for the workflow; nothing about statuses is hard-coded in the app. Requirements on the implementation:

- The app reads the `statuses` list at load time and builds the status pill, the dashboard filter, the "change status" menu (from `transitions`) and the next-steps panel from it. Adding a status is a one-block edit to `rules.yaml` plus one `status:<id>` label in the data repo, which `setup-labels.js` creates idempotently on re-run.
- `transitions` is advisory: the menu lists the declared transitions first, with an "other" option that allows any status, so an unanticipated path never blocks anyone.
- Each status may carry optional keys: `terminal` (excluded from the active dashboard), `requires` (candidate YAML fields that must be filled when entering the status; the app prompts for them), `color`, and `tasks_template` (a list of sub-issues to create automatically on entering the status, e.g. the three triggers under `lensed_sn`).
- Renaming a status id requires a migration: `setup-labels.js --rename old:new` relabels all issues. Prefer adding new statuses over renaming. (Done once: `awaiting_classification_spectrum` → `awaiting_confirmation`, since confirmation can also come from imaging. `--rename` relabels issues only — it does not edit the `status:` field in issue bodies, so check bodies separately.)
- Candidates whose `status` is not in the list are shown with a warning pill rather than hidden, so a typo in `rules.yaml` is visible, not silent.
- Vocabularies (`false_positive_type`, later `sn_type`, `lens_type`, etc.) follow the same pattern and populate dropdowns in the forms.
- `tasks_template` (auto-creating sub-issues on entering a status) is **not implemented**; tracks (§6.2) plus the Add-task form cover this for now.
- `requires` only works for **top-level** candidate fields: `changeCandidateStatus` merges extra fields flat, so a nested field like `time_delays.measured` would be written as a literal dotted key.
- A new status `color` must also be added to `KNOWN_COLORS` (`src/lib/format.js`), `.pill.<color>` in `style.css`, and `STATUS_COLORS` in `setup-labels.js` — otherwise it silently renders gray.

### 6.2 Workflow model: phases and tracks

The science workflow is not one linear sequence after confirmation (steps 3a and 3b run in
parallel; step 4 is gated on an *event* while 3a keeps running), so it is modelled in two layers:

- **Status = phase.** A candidate is in exactly one phase at a time. The rule for adding a
  phase: *a status changes only when the kind of attention the candidate needs changes.*
  Phases: `new_candidate` → `awaiting_confirmation` → (`false_positive`, terminal) or
  `lensed_sn` ("Live follow-up": time-critical, SN visible, nightly visibility matters) →
  `post_fade` (not time-critical, target is the lens system) → `data_complete` (terminal).
- **Tracks = parallel workstreams within a phase.** Each status lists the `tracks` expected in
  it. A track carries its purposes, responsible role, allowed modes/instruments/facilities,
  default cadence, and optionally an event gate (`starts_on`) and `per_image`. Every task
  records its `track` (and `image` for per-image tracks).
- **Step 4 is a track, not a phase**, because photometric monitoring must continue while
  early-phase spectroscopy of the next image runs.
- **Track state** is derived, never stored: *waiting* (a `starts_on` event hasn't happened),
  *not started* (no tasks), *active* (any open task), *done* (has tasks and all are closed).
- **`per_image` semantics:** once trailing image X has `image_dates.X.detected`, it is
  *eligible*; it is *targeted* only if a task with `image: X` exists. Eligible-but-untargeted
  images show as "not targeted", never as missing/overdue, and never block the track from
  being done or the candidate from moving to `post_fade`. In practice we expect to target
  only the second-appearing image; targeting every trailing image must also work.
- **Instruments are data, not code.** A track's `instruments:` list is what the Add-task form
  offers for it; if empty, anything matching the track's `modes` (or `facilities`) is offered.
  Swapping MUSE for another IFU later is a one-line `rules.yaml` edit.
- **Analysis is out of scope for statuses.** A candidate can be `data_complete` while time
  delays / lens modelling / SN analysis continue; analysis gets its own tracks in Milestone 4.

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
- "New candidate" form → creates parent issue with YAML block and `cand:` label. **[done]**
- "Add task" → creates sub-issue linked to parent. **[done]**
- "Trigger" button → opens a pre-filled mailto to the PI with coordinates, finder-chart link, visibility window, and creates a `type:trigger` sub-issue. **[done]** To = the program PI (instrument-level `pi:` overrides facility `contact.pi`); CC = the mode's lead role (spectroscopy_lead / photometry_lead) + coordinator.
- Change status → updates `status:` label. **[done]** (updates the YAML field and the label together)
- GitHub OAuth via Cloudflare Worker replaces the PAT. **[deferred on purpose — PAT with Issues read & write for now]**

### Milestone 2.5 — workflow phases and tracks (next)

Implements §6.2. Each step is independently shippable; do them in order. Every step keeps
existing candidates working (only additive keys, except the one rename already done).

**Step 0 — done.** Renamed `awaiting_classification_spectrum` → `awaiting_confirmation`
(rules.yaml, `status:` label via `setup-labels.js --rename`).

**Step 1 — fix status-label drift (bug). [done]** `changeCandidateStatus` (`src/lib/write.js`)
used to remove only the status label named in the body it just read, so one stale read left two
`status:*` labels on an issue (seen on #11). Now it removes *every* `status:*` label except the
new one (union of the fresh issue's labels and the body's old status). Covered by mocked-client
tests in `test/write.test.js`; audited that every live candidate has exactly one status label.

**Step 2 — data model (lensed-sn-data). [done]**
- `rules.yaml`: `lensed_sn` relabelled "Live follow-up"; `post_fade` and `data_complete`
  (terminal) added; top-level `tracks:` list and each status's `tracks:` key added as in §6.
  Cross-checked: every transition/track/role/mode/facility/instrument reference resolves.
- `facilities.yaml`: `hst` added — `space_based: true`, WFC3/UVIS (`wfc3_uvis`) and
  WFC3/IR (`wfc3_ir`), PI `shsuyu` (TBC).
- `setup-labels.js`: creates `track:<id>` labels from `rules.yaml` tracks; `blue` added to
  `STATUS_COLORS`. Run: created `status:post_fade`, `status:data_complete`, five `track:*`
  labels, `facility:hst`.
- Issue templates: `candidate.yml` gains `time_delays.reference_image/predicted_err/measured_err`
  and `image_dates`; `trigger.yml` gains `track`, `image`, `role`, `cadence_days`, `until`;
  `observation.yml` gains `track`, `image`, `epochs` (and its example instrument is now `soxs`).
- Until Step 3 lands, the app already shows the new phases in Change-status and the next-steps
  panel (data-driven), but `post_fade`'s blue pill renders gray, and tracks/new fields are not
  yet read or written by the app.

**Step 3 — app library (lensed-sn-tracker `src/lib/`). [done]**
- `format.js`/`style.css`: `blue` added to `KNOWN_COLORS`, `--blue`, `.pill.blue`.
- `rules.js`: `getTrack`, `tracksForStatus`, `tasksForTrack`, `referenceImage`,
  `eligibleImages(track, candidate, tasks)` (trailing = non-reference images with a `detected`
  date, flagged `targeted`), `trackState(track, tasks, candidate)` →
  `waiting|not_started|active|done`, `trackInstruments(track, facilities)` (explicit
  `instruments:` wins, else `facilities:`/`modes:` filter), and `predictedArrivals(candidate)`
  → `[{image, date, errDays}]` for undetected images (anchor = reference image's `detected`,
  else `discovery_date`) — the same arithmetic the Milestone-3 trailing-image alert will use.
- `write.js`: `buildCandidateIssue` writes the full `time_delays` shape and `image_dates: {}`.
  `buildTaskIssue(candidateId, type, fields, { rules, candidate, peopleData })` writes
  `track`/`image`/`role` (role defaults from the track) on every type, `cadence_days`/`until`
  on triggers and `epochs` on observations, adds `track:<id>`, appends "(image X)" to the
  title, and returns `assignees` resolved from the role via `resolveRole`. The context is
  optional, so untracked callers keep working. New `deepMerge` and
  `updateCandidateFields(client, repo, candidate, patch)` (fetch fresh → deep-merge → write →
  return new data; refuses `status`, which must go through `changeCandidateStatus`).
- Tests: `test/rules.test.js` (new, inline fixtures because CI checks out only this repo) and
  extended `test/write.test.js` — 48 tests total.
- Nothing in the UI uses these yet (Step 4). Open data questions surfaced by running
  `trackInstruments` on the real data: should the monitoring tracks exclude HST/JWST (they
  currently match by mode), and should `lens_followup` be restricted (it has no filter)?

**Step 4 — candidate page (`src/pages/candidate.js`).**
- "Follow-up tracks" section replacing the flat task table: one card per track of the current
  status — label, purposes, derived state, its tasks, and "+ Add task" pre-set to that track.
  Per-image tracks list eligible images with "+ Add for image X"; untargeted images read
  "not targeted". Tasks with no/unknown `track` go in an "Other tasks" card.
- Add-task form: Track selector first; it pre-fills task type, restricts instruments
  (`trackInstruments`), cadence and role (hence assignee). The existing mode-driven Wavelength
  band / Images rules still apply.
- "Image timeline" panel: per image, detected / peak / faded dates editable in place (via
  `updateCandidateFields`), plus "next image expected ~date ± err" from `time_delays`.
- Change-status: when every image has a `faded` date, show a hint suggesting `post_fade`
  (a hint only; never automatic).

**Step 5 — dashboard (`src/pages/dashboard.js`).**
- Per-row track indicators for the current phase (e.g. Phot ● Spec ● Space ○ Early-phase ⏳).
- "Hide terminal statuses" toggle, on by default (`activeStatuses` is currently only used by
  the New-candidate form).
- Next action becomes track-aware (earliest due open task across tracks, else the phase's first
  `next_step`).

**Step 6 — docs.** Update both CLAUDE.md files and this section's `[done]` markers.

**Acceptance check** (manual, on a test candidate): confirm → Live follow-up shows four track
cards; add a daily GROND trigger to Photometric monitoring (assignee = photometry_lead);
record image B `detected` → Early-phase spectroscopy becomes eligible for B with MUSE as the
only instrument; add it for B only; set every image `faded` → post-fade hint → move to
`post_fade` → one Lens follow-up card; → `data_complete` hides the row from the dashboard.

**Explicitly deferred:** alert automation (Milestone 3); `tasks_template` auto-creation;
per-epoch append UI (edit `epochs` on GitHub for now); light-curve panel; analysis tracking
(Milestone 4).

### Milestone 4 — analysis tracking (after data gathering works)
- Analysis tracks (time delays, lens modelling, SN properties, lens environment / external
  convergence), independent of the data-gathering phase, so a `data_complete` candidate can
  still show analysis in progress. Design when Milestone 2.5 is in use.

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
