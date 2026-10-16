import { Request, Response, NextFunction } from 'express';
import { getOrgBySlug } from '../services/db';
import { OrgMembership } from '../types/user';

// Validates the user is a member of the org in :orgSlug and attaches
// req.currentOrg + req.currentOrgMembership for downstream handlers.
// System admins always pass through (they can access any org).
export async function requireOrgMember(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.isAuthenticated() || !req.user) {
    res.redirect('/login');
    return;
  }

  const { orgSlug } = req.params;
  if (!orgSlug) {
    res.status(400).send('Missing org slug.');
    return;
  }

  const org = await getOrgBySlug(orgSlug);
  if (!org) {
    res.status(404).send(`Organisation '${orgSlug}' not found.`);
    return;
  }

  req.currentOrg = { id: org.id, slug: org.slug, name: org.name, theme_color: org.theme_color ?? null };

  if (req.user.isSystemAdmin || req.user.isLocalAdmin) {
    // System/local admins get a synthetic org_admin membership so downstream
    // helpers that check req.currentOrgMembership always see a role.
    req.currentOrgMembership = {
      orgId: org.id,
      orgSlug: org.slug,
      orgName: org.name,
      role: 'org_admin',
    } satisfies OrgMembership;
    return next();
  }

  const membership = req.user.orgs.find((o) => o.orgSlug === orgSlug);
  if (!membership) {
    res.status(403).send(`Access denied: you are not a member of '${org.name}'.`);
    return;
  }

  req.currentOrgMembership = membership;
  next();
}
