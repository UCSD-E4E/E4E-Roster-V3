interface PersonName {
  username: string;
  firstName: string | null;
  lastName: string | null;
}

/** Shared ordering for organization, project, and system people tables. */
export function sortPeople<T extends PersonName>(people: T[], sort: string, direction: string, columns: Record<string, (person: T) => string>): T[] {
  const multiplier = direction === 'desc' ? -1 : 1;
  const nameOrder = (a: T, b: T) => (a.firstName || a.username).localeCompare(b.firstName || b.username)
    || (a.lastName ?? '').localeCompare(b.lastName ?? '') || a.username.localeCompare(b.username);
  const value = Object.prototype.hasOwnProperty.call(columns, sort) ? columns[sort] : undefined;
  return people.sort((left, right) => {
    if (!value) return nameOrder(left, right) * multiplier;
    const a = value(left); const b = value(right);
    if (!a) return b ? 1 : nameOrder(left, right) * multiplier;
    if (!b) return -1;
    return (a.localeCompare(b) || nameOrder(left, right)) * multiplier;
  });
}
