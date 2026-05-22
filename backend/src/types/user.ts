export interface OrgRole {
  orgId: number;
  orgSlug: string;
  orgName: string;
  themeColor: string | null;
  role: 'org_admin' | 'project_lead' | 'member';
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  username: string;
  groups: string[];
  isAdmin: boolean;       // kept for backward compat — same as isSystemAdmin
  isSystemAdmin: boolean;
  isProjectLead: boolean;
  orgRoles: OrgRole[];    // derived at login from org_ldap_group_mappings
}
