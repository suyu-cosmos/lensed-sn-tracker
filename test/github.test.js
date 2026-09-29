// Vitest coverage for createIssue's assignee-rejection retry (github.js).
// GitHub rejects the whole create with 422 when an assignee isn't a repo
// collaborator (confirmed live) — the app must still create the issue.

import { describe, it, expect, vi } from 'vitest';
import { createIssue, setIssueAssignees } from '../src/lib/github.js';

const repo = { owner: 'o', name: 'r' };
const assigneeError = () =>
  Object.assign(new Error('Validation Failed'), {
    status: 422,
    response: { data: { errors: [{ field: 'assignees', code: 'invalid', value: ['stefant'] }] } },
  });

describe('createIssue', () => {
  const notAssignable = () => vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

  it('retries without assignees when GitHub rejects them, and reports which were dropped', async () => {
    const create = vi.fn().mockRejectedValueOnce(assigneeError()).mockResolvedValueOnce({ data: { number: 5, assignees: [] } });
    const issues = { create, checkUserCanBeAssigned: notAssignable() };
    const issue = await createIssue({ rest: { issues } }, repo, { title: 't', body: 'b', labels: ['x'], assignees: ['stefant'] });
    expect(issue.number).toBe(5);
    expect(issue.droppedAssignees).toEqual(['stefant']);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty('assignees');
    expect(create.mock.calls[1][0].labels).toEqual(['x']);
  });

  it('keeps the assignable co-assignee when only one of two is rejected', async () => {
    const create = vi.fn().mockRejectedValueOnce(assigneeError()).mockResolvedValueOnce({ data: { number: 7, assignees: [{ login: 'shsuyu' }] } });
    const checkUserCanBeAssigned = vi.fn(({ assignee }) =>
      assignee === 'shsuyu' ? Promise.resolve({}) : Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })),
    );
    const issue = await createIssue({ rest: { issues: { create, checkUserCanBeAssigned } } }, repo, {
      title: 't',
      body: 'b',
      assignees: ['shsuyu', 'alejandram'],
    });
    expect(create.mock.calls[1][0].assignees).toEqual(['shsuyu']);
    expect(issue.droppedAssignees).toEqual(['alejandram']);
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

describe('setIssueAssignees', () => {
  it('replaces the assignees, and on a 422 assignee rejection clears them and reports the dropped ones', async () => {
    const ok = vi.fn().mockResolvedValue({});
    expect(await setIssueAssignees({ rest: { issues: { update: ok } } }, repo, 3, ['shsuyu'])).toEqual({ dropped: [] });
    expect(ok.mock.calls[0][0]).toMatchObject({ issue_number: 3, assignees: ['shsuyu'] });

    const update = vi.fn().mockRejectedValueOnce(assigneeError()).mockResolvedValueOnce({});
    const checkUserCanBeAssigned = vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    expect(await setIssueAssignees({ rest: { issues: { update, checkUserCanBeAssigned } } }, repo, 3, ['stefant'])).toEqual({ dropped: ['stefant'] });
    expect(update.mock.calls[1][0].assignees).toEqual([]);
  });
});
