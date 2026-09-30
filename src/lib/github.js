// Thin wrapper around Octokit. Every read the app needs for Milestone 1
// (the three YAML config files, candidate issues, sub-issues, comments)
// lives here so the rest of the app never touches the REST API shape
// directly — useful once Milestone 2 adds writes and Milestone-2 OAuth
// swaps how the token is obtained.

import { Octokit } from 'octokit';

export function makeClient(token) {
  // GitHub sends `Cache-Control: private, max-age=60`, so by default the
  // browser may answer a repeat request from its own cache for up to a minute
  // — an issue closed on GitHub would still look open after a refresh.
  // `no-cache` always revalidates with GitHub (via ETag; an unchanged 304
  // doesn't count against the rate limit), so every read is current.
  return new Octokit({
    auth: token,
    request: { fetch: (url, options) => fetch(url, { ...options, cache: 'no-cache' }) },
  });
}

/** Decode a repo file fetched via contents API (base64) to a UTF-8 string. */
function decodeContent(response) {
  const { content, encoding } = response.data;
  if (encoding !== 'base64') {
    throw new Error(`Unexpected encoding "${encoding}" for ${response.url}`);
  }
  return decodeURIComponent(escape(atob(content.replace(/\n/g, ''))));
}

/** Fetch one file's raw text content from a repo, e.g. "facilities.yaml". */
export async function fetchTextFile(client, { owner, name }, path) {
  const response = await client.rest.repos.getContent({ owner, repo: name, path });
  return decodeContent(response);
}

/** List every open+closed issue in the data repo carrying `type:candidate`. */
export async function listCandidateIssues(client, { owner, name }) {
  return client.paginate(client.rest.issues.listForRepo, {
    owner,
    repo: name,
    labels: 'type:candidate',
    state: 'all',
    per_page: 100,
  });
}

/**
 * List every sub-issue (trigger/observation/analysis/decision) belonging to
 * one candidate, identified by its `cand:<id>` label. Milestone 1 has no
 * native GitHub "sub-issue" link to rely on, so the `cand:<id>` label is the
 * relationship — the candidate.yml form and the app both set it.
 */
export async function listCandidateSubIssues(client, { owner, name }, candidateId) {
  const issues = await client.paginate(client.rest.issues.listForRepo, {
    owner,
    repo: name,
    labels: `cand:${candidateId}`,
    state: 'all',
    per_page: 100,
  });
  return issues.filter((issue) => !issue.labels.some((l) => labelName(l) === 'type:candidate'));
}

/**
 * Create a new issue. Any label name that doesn't already exist in the repo
 * is created automatically by GitHub with a default color (confirmed
 * against the live API — unlike issue-form `labels:` defaults, which can
 * only apply labels that already exist).
 */
export async function createIssue(client, repo, { title, body, labels = [], assignees = [] }) {
  // An assignee who isn't a collaborator on the repo (e.g. a placeholder
  // GitHub username in people.yaml) makes GitHub REJECT the whole create
  // with 422 "assignees X cannot be assigned" — it is NOT silently dropped
  // (confirmed against the live API). So on that specific error, keep only
  // the assignees GitHub says are assignable, retry once with those, and
  // report the rest via `droppedAssignees` so the caller can warn instead of
  // losing the whole write (or a valid co-assignee along with a bad one).
  const { owner, name } = repo;
  try {
    const response = await client.rest.issues.create({ owner, repo: name, title, body, labels, assignees });
    return response.data;
  } catch (err) {
    if (!isAssigneeRejection(err, assignees)) throw err;
    const { ok, dropped } = await splitAssignable(client, repo, assignees);
    const response = await client.rest.issues.create({ owner, repo: name, title, body, labels, ...(ok.length ? { assignees: ok } : {}) });
    return { ...response.data, droppedAssignees: dropped };
  }
}

function isAssigneeRejection(err, assignees) {
  return err.status === 422 && assignees.length > 0 && (err.response?.data?.errors ?? []).some((e) => e.field === 'assignees');
}

/** Split usernames into those GitHub allows as assignees on this repo and those it doesn't (GET /assignees/{user}: 204 vs 404). */
async function splitAssignable(client, { owner, name }, assignees) {
  const checks = await Promise.all(
    assignees.map((assignee) =>
      client.rest.issues
        .checkUserCanBeAssigned({ owner, repo: name, assignee })
        .then(() => true)
        .catch((err) => {
          if (err.status === 404) return false;
          throw err;
        }),
    ),
  );
  return { ok: assignees.filter((_, i) => checks[i]), dropped: assignees.filter((_, i) => !checks[i]) };
}

/**
 * Replace an issue's assignees (e.g. the candidate issue after its main lead
 * changes). Same GitHub behaviour as createIssue: a non-collaborator makes
 * the whole update fail with 422, so on exactly that error retry with only
 * the assignable ones and return the ones that were dropped.
 */
export async function setIssueAssignees(client, repo, issueNumber, assignees) {
  const { owner, name } = repo;
  try {
    await client.rest.issues.update({ owner, repo: name, issue_number: issueNumber, assignees });
    return { dropped: [] };
  } catch (err) {
    if (!isAssigneeRejection(err, assignees)) throw err;
    const { ok, dropped } = await splitAssignable(client, repo, assignees);
    await client.rest.issues.update({ owner, repo: name, issue_number: issueNumber, assignees: ok });
    return { dropped };
  }
}

/** Fetch one issue fresh — used right before an edit to shrink the race window with a concurrent edit made elsewhere (e.g. directly on GitHub). */
export async function getIssue(client, { owner, name }, issueNumber) {
  const response = await client.rest.issues.get({ owner, repo: name, issue_number: issueNumber });
  return response.data;
}

/**
 * Replace an issue's body (e.g. after mutating its parsed YAML block).
 * `extra` can carry `state`/`state_reason` to open or close it in the same call.
 */
export async function updateIssueBody(client, { owner, name }, issueNumber, body, extra = {}) {
  await client.rest.issues.update({ owner, repo: name, issue_number: issueNumber, body, ...extra });
}

/** Add one or more labels to an issue; any name that doesn't exist yet is created automatically. */
export async function addLabels(client, { owner, name }, issueNumber, labels) {
  if (!labels.length) return;
  await client.rest.issues.addLabels({ owner, repo: name, issue_number: issueNumber, labels });
}

/** Remove one label from an issue; a no-op if it isn't currently applied. */
export async function removeLabel(client, { owner, name }, issueNumber, label) {
  await client.rest.issues.removeLabel({ owner, repo: name, issue_number: issueNumber, name: label }).catch((err) => {
    if (err.status !== 404) throw err;
  });
}

/** List threaded comments on any issue (parent or sub-issue). */
export async function listComments(client, { owner, name }, issueNumber) {
  return client.paginate(client.rest.issues.listComments, {
    owner,
    repo: name,
    issue_number: issueNumber,
    per_page: 100,
  });
}

export function labelName(label) {
  return typeof label === 'string' ? label : label.name;
}
