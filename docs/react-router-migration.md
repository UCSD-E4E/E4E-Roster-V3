# React Router migration

Status: the server-rendered workspace is available under `/orgs/:orgSlug/v2`
and is the local organization-root destination. System administration is
available under `/system/v2`. Legacy Nunjucks workspace URLs now bridge GET
requests to their React replacement and reject legacy writes; the old UI is
no longer mounted. No deployment change is authorized by this work.

## Architecture decision

Use React Router Data Mode inside the existing Express process for the staged
migration. This provides nested layouts, loaders, actions, error boundaries,
and React components while preserving the current Passport session, PostgreSQL
pool, LDAP services, route middleware, and Docker topology.

The initial pages are rendered entirely on the server with hydration disabled.
Links and forms therefore retain normal browser behavior and the roster does
not need a second JSON API. Client-side hydration can be introduced later for
a specific interaction only when its value justifies the extra bundle and
state-management surface.

React Router 7 is pinned because it supports the production image's Node 20
runtime. A move to Framework Mode and its Vite plugin can be reconsidered after
the production runtime and deployment path are intentionally upgraded.

## Boundaries

- `src/ui/*.server.ts` owns database and other server-only access.
- React render components receive serializable loader data and must not import
  the database, LDAP client, secrets, or Express request objects.
- Loaders and actions enforce organization/project policy on the server. Hiding
  a control in a component is never an authorization check.
- Existing `/admin` and `/pl` URLs remain valid during the migration. React
  pages may link to an unconverted legacy operation until that complete
  vertical flow has equivalent tests.
- `/v2` is a transition boundary, not a permanent public URL contract.

## Current workspace slice

- Organization workspace shell and navigation.
- Organization-root dashboard and personal account screen. The organization
  root enters `/v2/dashboard`; the legacy `/dashboard` route remains available
  until route-parity migration is complete.
- Standalone organization selector using the workspace theme, while retaining
  the existing server-side membership selection and system-admin visibility.
- System-administration shell with local break-glass admin management,
  organization creation/theme updates/confirmed deletion, and the read-only
  audit log. These retain system-admin middleware; destructive actions require
  an explicit confirmation field in the new UI.
- System LDAP role mappings, including role changes and membership sync. The
  sync resolves overlapping LDAP groups to the highest mapped role; a utility
  mapping makes a group available to an organization without granting a role.
  Confirmed organization deletion retains audit records by clearing their
  historical organization reference.
- System directory-group provisioning, including optional organization,
  project, GitHub-team, and Slack-channel mapping. A selected project now
  automatically makes its new group available in that project's organization;
  integration choices degrade gracefully when their services are unavailable.
- System-wide directory-user index, with links to the existing LDAP-backed
  create/edit workflows. Provisioning results use a one-time server-session
  page for temporary passwords, never a URL or audit record.
- The disposable integration suite stubs successful LDAP account creation for
  both organization-admin and project-lead provisioning routes, then verifies
  their new users receive an immediate `user_orgs` membership.
- The suite exercises project-lead “add existing person” through the React
  action with a controlled LDAP group update, rejects forged project groups
  before LDAP is called, and verifies a previously missing `user_orgs` row is
  created before the user is returned to the project roster.
- Accessible project list for organization admins and project leads.
- Project member list constrained by both `user_orgs` and mapped project LDAP
  groups.
- Organization People roster, constrained to the active organization.
- Organization-admin and project-lead directory search/add-existing actions.
  Both rank partial username, name, and email matches; organization changes
  are scoped to the active organization, and project changes retain
  non-project LDAP groups while creating a missing organization membership.
- Organization Settings reads and writes, visible only to organization admins;
  secrets are never rendered and an empty secret field retains the stored
  encrypted value.
- Project-member audit history, constrained to the project member and active
  organization.
- Reusable `WorkspacePageHeader`, roster cards/tables, policy helpers, and
  server-only query modules instead of per-route copies of the same layout and
  access checks.
- Organization-admin project creation, name/description editing, and
  organization-owned project-group management.
- Personal account page and contact-information action. SSH-key updates retain
  the established LDAP behavior (and are deliberately skipped for local
  break-glass administrators).
- React actions for organization-member editing, project-member editing, and
  new-person provisioning, with server-side group-scoping checks and LDAP test
  overrides.
- Organization-admin and project-lead new-person provisioning now use the
  same one-time session result page as system provisioning, while enforcing
  organization/project group ownership and creating `user_orgs` membership in
  the same scoped workflow.
- Reusable action-error handling keeps expected validation and LDAP failures
  beside React forms while retaining their HTTP status. This is used by account,
  settings, project, and person write paths rather than duplicating page-level
  error behavior.
- Legacy organization integration mapping reads and deletes are now explicitly
  scoped by `org_id`, preventing a shared LDAP group from exposing or changing
  another organization's GitHub/Slack mappings.
- Organization group-management: scoped LDAP-group creation, optional project
  association, role mappings, integration mappings, and integration sync.
- Directory sync controls for system administrators and organization
  administrators, with an explicit result message. The existing empty-result
  prune guard remains in place.
- React-only security headers: strict no-inline-script CSP, `no-store` cache
  policy for directory and one-time-password pages, and same-origin checks on
  every React state-changing action. Server authorization remains the source
  of truth for all organization/project scope checks.

## Remaining transition work

1. Verify against authorized production-like LDAP, GitHub, and Slack services.
2. Remove dead Nunjucks route/template code after a manual review window. It
   is deliberately disconnected from the application now, so this cleanup has
   no live-route behavior change.
3. Extend the same-origin policy to non-workspace legacy authentication routes
   only after confirming the SSO callback and operational recovery flows.
