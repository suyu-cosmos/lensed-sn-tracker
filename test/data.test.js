// Vitest coverage for mergeTasks (data.js): a lagging refetch must never drop
// a task the page already knows about (e.g. two triggers added back to back).

import { describe, it, expect } from 'vitest';
import { mergeTasks } from '../src/lib/data.js';

const task = (number, state = 'open') => ({ issue: { number, state }, data: {} });

describe('mergeTasks', () => {
  it('keeps known tasks missing from a lagging refetch, newest first', () => {
    const merged = mergeTasks([], [task(25), task(24)]);
    expect(merged.map((t) => t.issue.number)).toEqual([25, 24]);
  });

  it('prefers the refetched copy of a task over the known one', () => {
    const merged = mergeTasks([task(24, 'closed')], [task(25), task(24, 'open')]);
    expect(merged.map((t) => `${t.issue.number}:${t.issue.state}`)).toEqual(['25:open', '24:closed']);
  });
});
