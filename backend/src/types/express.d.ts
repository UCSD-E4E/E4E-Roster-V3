import { AuthUser, OrgMembership } from './user';
import { WizardState } from '../services/types';
import type { SystemProvisionResult } from '../ui/system.server';
import type { RosterProvisionResult } from '../ui/roster-provision.server';

declare global {
  namespace Express {
    interface User extends AuthUser {}

    interface Request {
      // Populated by requireOrgMember middleware for /org/:orgSlug routes
      currentOrg?: { id: number; slug: string; name: string; theme_color: string | null };
      currentOrgMembership?: OrgMembership;
    }
  }
}

declare module 'express-session' {
  interface SessionData {
    wizard?: WizardState;
    systemProvisionResult?: SystemProvisionResult;
    rosterProvisionResult?: RosterProvisionResult;
  }
}

export {};
