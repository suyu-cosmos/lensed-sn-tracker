// Vitest coverage for createIssue's assignee-rejection retry (github.js).
// GitHub rejects the whole create with 422 when an assignee isn't a repo
// collaborator (confirmed live) — the app must still create the issue.

import { describe, it, expect, vi } from 'vitest';
import { createIssue } from '../src/lib/github.js';

const repo = { owner: 'o', name: 'r' };
const assigneeError = () =>
  Object.assign(new Error('Validation Failed'), {
    status: 422,
    response: { data: { errors: [{ field: 'assignees', code: 'invalid', value: ['stefant'] }] } },
  });

describe('createIssue', () => {
  it('retries without assignees when GitHub rejects them, and reports which were dropped', async () => {
    const create = vi.fn().mockRejectedValueOnce(assigneeError()).mockResolvedValueOnce({ data: { number: 5, assignees: [] } });
    const issue = await createIssue({ rest: { issues: { create } } }, repo, { title: 't', body: 'b', labels: ['x'], assignees: ['stefant'] });
    expect(issue.number).toBe(5);
    expect(issue.droppedAssignees).toEqual(['stefant']);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty('assignees');
    expect(create.mock.calls[1][0].labels).toEqual(['x']);
  });

  it('does not retry (or swallow) any other error', async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    await expect(createIssue({ rest: { issues: { create } } }, repo, { title: 't', body: 'b', assignees: ['a'] })).rejects.toThrow('Forbidden');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('passes a normal create straight through', async () => {
    const create = vi.fn().mockResolvedValue({ data: { number: 6, assignees: [{ login: 'shsuyu' }] } });
    const issue = await createIssue({ rest: { issues: { create } } }, repo, { title: 't', body: 'b', assignees: ['shsuyu'] });
    expect(issue.droppedAssignees).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
