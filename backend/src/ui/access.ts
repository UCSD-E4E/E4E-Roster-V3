import { data } from 'react-router';
import type { RosterUiContext } from './projects.server';

export function canAdminOrg(context: RosterUiContext): boolean {
  return context.user.isSystemAdmin || context.user.isLocalAdmin === true ||
    context.membership.role === 'org_admin';
}

export function canViewPeople(context: RosterUiContext): boolean {
  return canAdminOrg(context) || context.membership.role === 'project_lead';
}

export function requireOrgAdmin(context: RosterUiContext): void {
  if (!canAdminOrg(context)) throw data('Organisation admin access required.', { status: 403 });
}
