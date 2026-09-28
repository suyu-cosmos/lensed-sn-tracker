// Regression coverage for a real bug: js-yaml's default schema
// auto-converts bare YYYY-MM-DD (and full ISO datetime) scalars into
// native JS Date objects, which then stringify as a verbose
// locale/timezone-dependent string ("Fri Apr 30 2027 00:00:00 GMT+...")
// wherever displayed via a template literal instead of formatUtc(). Every
// load in this app must go through JSON_SCHEMA to keep these as strings.

import { describe, it, expect } from 'vitest';
import { parseYamlFile, parseIssueBody } from '../src/lib/yaml.js';

describe('date-like scalars stay plain strings', () => {
  it('parseYamlFile does not convert a bare date into a Date object', () => {
    const parsed = parseYamlFile('semester_end: 2027-04-30\nsemester_start: 2027-07-01T00:00:00Z\n');
    expect(parsed.semester_end).toBe('2027-04-30');
    expect(typeof parsed.semester_end).toBe('string');
    expect(parsed.semester_start).toBe('2027-07-01T00:00:00Z');
    expect(typeof parsed.semester_start).toBe('string');
  });

  it('parseIssueBody does not convert discovery_date/obs_utc into Date objects', () => {
    const body = [
      '```yaml',
      '# candidate',
      'id: LSN-test',
      'discovery_date: 2026-09-08',
      'obs_utc: 2026-09-19T05:42:00Z',
      '```',
    ].join('\n');
    const { data } = parseIssueBody(body);
    expect(data.discovery_date).toBe('2026-09-08');
    expect(data.obs_utc).toBe('2026-09-19T05:42:00Z');
  });
});
