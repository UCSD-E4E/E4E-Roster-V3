import { canAdminOrg, canViewPeople } from './access';
import type { RosterUiContext } from './projects.server';

export interface DashboardSummary {
  canManageProjects: boolean;
  canManagePeople: boolean;
  canManageSettings: boolean;
}

/**
 * Keep dashboard role decisions in one place so the shell does not duplicate
 * policy that the project and people routes enforce server-side.
 */
export function getDashboardSummary(context: RosterUiContext): DashboardSummary {
  const canManagePeople = canViewPeople(context);
  return {
    canManageProjects: canManagePeople,
    canManagePeople,
    canManageSettings: canAdminOrg(context),
  };
}
