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
