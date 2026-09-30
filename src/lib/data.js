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
/**
 * Combine a just-refetched task list with tasks the page already knew about
 * (incl. one it just created). The label-filtered list can lag behind recent
 * writes and omit an issue created moments ago, so a refetch alone must never
 * drop a known task: fresh copies win, known-but-missing ones are kept.
 * Newest issue first, like the list endpoint.
 */
export function mergeTasks(fresh, known) {
  const byNumber = new Map(known.map((t) => [t.issue.number, t]));
  for (const t of fresh) byNumber.set(t.issue.number, t);
  return [...byNumber.values()].sort((a, b) => b.issue.number - a.issue.number);
}

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
