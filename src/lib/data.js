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

/** Sub-issues (tasks) and threaded comments for one candidate, fetched on demand. */
export async function loadCandidateDetail(client, candidate) {
  const { dataRepo } = config;
  const candidateId = candidate.data?.id;

  const [subIssues, comments] = await Promise.all([
    candidateId ? listCandidateSubIssues(client, dataRepo, candidateId) : Promise.resolve([]),
    listComments(client, dataRepo, candidate.issue.number),
  ]);

  const tasks = subIssues.map((issue) => {
    const { data, notes } = parseIssueBody(issue.body);
    const typeLabel = issue.labels.map(labelName).find((l) => l.startsWith('type:'));
    return { issue, type: typeLabel?.slice('type:'.length) ?? 'unknown', data, notes };
  });

  return { tasks, comments };
}

export function facilityById(facilities, id) {
  return facilities.find((f) => f.id === id);
}
