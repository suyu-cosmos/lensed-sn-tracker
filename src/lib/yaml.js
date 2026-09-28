// Parsing for the YAML data files (facilities/people/rules) and for the
// fenced ```yaml block that every issue body carries (plan §5.1/§5.2).
// Issues created through the GitHub web UI, the issue forms, or the app
// itself all share this one format, so they stay interchangeable.

import yaml from 'js-yaml';

// js-yaml's default schema auto-converts any bare YYYY-MM-DD (or full
// ISO-8601 datetime) scalar into a native JS Date, in whatever timezone
// the parsing machine happens to be in — which then stringifies as e.g.
// "Fri Apr 30 2027 00:00:00 GMT+0800 (...)" wherever it's displayed
// without going through format.js's formatUtc(). We want every date/
// datetime field to stay a plain string (parsed into a Date explicitly,
// only where and when actually needed), so every load in this app goes
// through JSON_SCHEMA, which has no timestamp type. Confirmed against
// facilities.yaml/people.yaml/rules.yaml and a real issue body that this
// changes nothing else. `yaml.dump` needs no matching change — its
// default schema already quotes date-like strings on write, so an
// app-written body round-trips safely regardless of which schema reads
// it back; hand-typed unquoted dates on GitHub are exactly what this
// fixes.
const LOAD_OPTIONS = { schema: yaml.JSON_SCHEMA };

export function parseYamlFile(text) {
  return yaml.load(text, LOAD_OPTIONS);
}

const YAML_BLOCK_RE = /```ya?ml\r?\n([\s\S]*?)```/;

/**
 * Split an issue body into its structured YAML block and the free-text
 * notes that follow it. Returns `{ data, notes }`; `data` is `null` if the
 * body has no fenced yaml block (e.g. an issue not created through this
 * workflow yet).
 */
export function parseIssueBody(body) {
  if (!body) return { data: null, notes: '' };
  const match = body.match(YAML_BLOCK_RE);
  if (!match) return { data: null, notes: body.trim() };
  const data = yaml.load(match[1], LOAD_OPTIONS) ?? null;
  const notes = body.slice(match.index + match[0].length).trim();
  return { data, notes };
}

/**
 * Render a JS object back into the fenced yaml block issue-body format.
 * `headerComment`, if given, becomes a leading `# <headerComment>` line
 * matching the hand-authored issue templates (`# candidate`, `# trigger`,
 * …) — purely documentation for anyone reading the raw issue on GitHub;
 * parseIssueBody ignores it either way.
 */
export function stringifyIssueBody(data, notes = '', headerComment = null) {
  const header = headerComment ? `# ${headerComment}\n` : '';
  const block = '```yaml\n' + header + yaml.dump(data, { lineWidth: 100 }) + '```';
  return notes ? `${block}\n\n${notes}` : block;
}
