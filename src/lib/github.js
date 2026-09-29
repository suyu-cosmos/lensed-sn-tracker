// Thin wrapper around Octokit. Every read the app needs for Milestone 1
// (the three YAML config files, candidate issues, sub-issues, comments)
// lives here so the rest of the app never touches the REST API shape
// directly — useful once Milestone 2 adds writes and Milestone-2 OAuth
// swaps how the token is obtained.

import { Octokit } from 'octokit';

export function makeClient(token) {
  return new Octokit({ auth: token });
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
export async function createIssue(client, { owner, name }, { title, body, labels = [], assignees = [] }) {
  // An assignee who isn't a collaborator on the repo (e.g. a placeholder
  // GitHub username in people.yaml) makes GitHub REJECT the whole create
  // with 422 "assignees X cannot be assigned" — it is NOT silently dropped
  // (confirmed against the live API; an earlier comment here claimed
  // otherwise and broke task creation for placeholder role holders). So on
  // that specific error, retry once without assignees and report which ones
  // were dropped via `droppedAssignees`, so the caller can warn instead of
  // losing the whole write.
  try {
    const response = await client.rest.issues.create({ owner, repo: name, title, body, labels, assignees });
    return response.data;
  } catch (err) {
    const assigneeRejected =
      err.status === 422 && assignees.length > 0 && (err.response?.data?.errors ?? []).some((e) => e.field === 'assignees');
    if (!assigneeRejected) throw err;
    const response = await client.rest.issues.create({ owner, repo: name, title, body, labels });
    return { ...response.data, droppedAssignees: assignees };
  }
}

/** Fetch one issue fresh — used right before an edit to shrink the race window with a concurrent edit made elsewhere (e.g. directly on GitHub). */
export async function getIssue(client, { owner, name }, issueNumber) {
  const response = await client.rest.issues.get({ owner, repo: name, issue_number: issueNumber });
  return response.data;
}

/** Replace an issue's body (e.g. after mutating its parsed YAML block). */
export async function updateIssueBody(client, { owner, name }, issueNumber, body) {
  await client.rest.issues.update({ owner, repo: name, issue_number: issueNumber, body });
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
