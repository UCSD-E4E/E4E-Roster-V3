import { AuthUser, OrgMembership } from './user';
import { WizardState } from '../services/types';

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
  }
}

export {};
