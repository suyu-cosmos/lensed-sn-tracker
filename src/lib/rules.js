// Everything that reads rules.yaml as "the single source of truth for the
// workflow" (plan §6.1): status lookup, role resolution with the
// candidate-override → group-default → unassigned fallthrough (§4.1), and
// the data the dashboard/candidate page need to build their menus without
// any status hard-coded in the app itself.

/** Look up one status definition by id; undefined if rules.yaml has no such id. */
export function getStatus(rules, statusId) {
  return rules.statuses.find((s) => s.id === statusId);
}

/** Statuses to show on the active dashboard (non-terminal ones). */
export function activeStatuses(rules) {
  return rules.statuses.filter((s) => !s.terminal);
}

/**
 * Menu of status transitions for a candidate currently in `statusId`:
 * the declared transitions first (in rules.yaml order), then "other" so an
 * unanticipated path is never blocked (plan §6.1).
 */
export function transitionsFor(rules, statusId) {
  const status = getStatus(rules, statusId);
  const declared = status?.transitions
    ? Object.entries(status.transitions).map(([id, description]) => ({ id, description }))
    : [];
  const other = rules.statuses
    .map((s) => s.id)
    .filter((id) => id !== statusId && !declared.some((d) => d.id === id));
  return { declared, other };
}

/**
 * Resolve who holds a role for one candidate, in the order from plan §4.1:
 * 1. candidate.roles_override[roleId]
 * 2. people.roles[roleId].holder
 * 3. unassigned (candidate leads carry it by default, flagged in the UI)
 *
 * Returns `{ personId, source }` where source is 'override' | 'default' | 'unassigned'.
 */
export function resolveRole(candidate, roleId, peopleData) {
  const override = candidate.roles_override?.[roleId];
  if (override) return { personId: override, source: 'override' };

  const groupDefault = peopleData.roles?.[roleId]?.holder;
  if (groupDefault) return { personId: groupDefault, source: 'default' };

  return { personId: null, source: 'unassigned' };
}

/** Resolve every group-default role name to its current holder for one candidate. */
export function resolveAllRoles(candidate, peopleData) {
  const roleIds = Object.keys(peopleData.roles ?? {});
  return Object.fromEntries(roleIds.map((roleId) => [roleId, resolveRole(candidate, roleId, peopleData)]));
}

export function findPerson(peopleData, personId) {
  return peopleData.people.find((p) => p.id === personId);
}

/** Next-step suggestions for a candidate's current status, straight from rules.yaml. */
export function nextStepsFor(rules, statusId) {
  return getStatus(rules, statusId)?.next_steps ?? [];
}

/** Fields that must be filled before a candidate may enter `statusId` (plan §6.1 `requires`). */
export function requiredFieldsFor(rules, statusId) {
  return getStatus(rules, statusId)?.requires ?? [];
}

export function vocabulary(rules, name) {
  return rules.vocabularies?.[name] ?? [];
}
