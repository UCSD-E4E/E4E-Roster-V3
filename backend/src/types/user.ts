export type OrgRole = 'org_admin' | 'project_lead' | 'member';

export interface OrgMembership {
  orgId: number;
  orgSlug: string;
  orgName: string;
  role: OrgRole;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  username: string;
  groups: string[];          // raw LDAP groups from OIDC token
  isSystemAdmin: boolean;
  orgs: OrgMembership[];     // all orgs this user belongs to (LDAP-derived + DB)
  isLocalAdmin?: boolean;    // set only for break-glass local admin sessions
}

// Convenience helpers used by middleware
export function hasOrgRole(user: AuthUser, orgSlug: string, ...roles: OrgRole[]): boolean {
  if (user.isSystemAdmin) return true;
  const membership = user.orgs.find((o) => o.orgSlug === orgSlug);
  return membership !== undefined && roles.includes(membership.role);
}

export function isOrgAdmin(user: AuthUser, orgSlug: string): boolean {
  return hasOrgRole(user, orgSlug, 'org_admin');
}

export function isAnyOrgAdmin(user: AuthUser): boolean {
  return user.isSystemAdmin || user.orgs.some((o) => o.role === 'org_admin');
}
