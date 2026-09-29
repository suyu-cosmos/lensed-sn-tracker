// Assembles one coherent snapshot of app state from the data repo: the
// three YAML config files plus every `type:candidate` issue. Pages read
// from this instead of touching Octokit/YAML parsing themselves.

import configJson from '../../config.json';
import { makeClient, fetchTextFile, listCandidateIssues, listCandidateSubIssues, listComments, labelName } from './github.js';
import { parseYamlFile, parseIssueBody } from './yaml.js';

export const config = configJson;

export async function loadAppData(token) {
  const client = makeClient(token);
  const { dataRepo } = config;

  const [facilitiesText, peopleText, rulesText] = await Promise.all([
    fetchTextFile(client, dataRepo, 'facilities.yaml'),
    fetchTextFile(client, dataRepo, 'people.yaml'),
    fetchTextFile(client, dataRepo, 'rules.yaml'),
  ]);

  const facilities = parseYamlFile(facilitiesText).facilities ?? [];
  const people = parseYamlFile(peopleText);
  const rules = parseYamlFile(rulesText);

  const candidateIssues = await listCandidateIssues(client, dataRepo);
  const candidates = candidateIssues
    .map((issue) => {
      const { data, notes } = parseIssueBody(issue.body);
      return { issue, data, notes };
    })
    // A candidate with no parseable YAML block still needs to show up (as a
    // warning), so only fully-missing bodies are dropped here.
    .filter((c) => c.data !== null || c.issue.body);

  return { client, config, facilities, people, rules, candidates };
}

/** Build one {issue, type, data, notes} task entry from a raw GitHub issue. */
export function buildTaskFromIssue(issue) {
  const { data, notes } = parseIssueBody(issue.body);
  const typeLabel = issue.labels.map(labelName).find((l) => l.startsWith('type:'));
  return { issue, type: typeLabel?.slice('type:'.length) ?? 'unknown', data, notes };
}

/** Sub-issues (tasks) and threaded comments for one candidate, fetched on demand. */
export async function loadCandidateDetail(client, candidate) {
  const { dataRepo } = config;
  const candidateId = candidate.data?.id;

  const [subIssues, comments] = await Promise.all([
    candidateId ? listCandidateSubIssues(client, dataRepo, candidateId) : Promise.resolve([]),
    listComments(client, dataRepo, candidate.issue.number),
  ]);

  const tasks = subIssues.map(buildTaskFromIssue);

  return { tasks, comments };
}

export function facilityById(facilities, id) {
  return facilities.find((f) => f.id === id);
}

/**
 * Re-fetch the candidate issue list and replace `ctx.candidates`' contents
 * in place (same array reference, so every page holding a reference to
 * `ctx` sees the update). Call after creating a candidate; adding a task
 * doesn't change this list, so it isn't needed there.
 */
export async function refreshCandidates(ctx) {
  const { dataRepo } = config;
  const candidateIssues = await listCandidateIssues(ctx.client, dataRepo);
  const candidates = candidateIssues
    .map((issue) => {
      const { data, notes } = parseIssueBody(issue.body);
      return { issue, data, notes };
    })
    .filter((c) => c.data !== null || c.issue.body);
  ctx.candidates.length = 0;
  ctx.candidates.push(...candidates);
}
