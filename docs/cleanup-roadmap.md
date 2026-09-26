# Roster cleanup roadmap

Status: code review and local build completed on `codex/roster-cleanup-plan` (2026-09-25). Production is still deployed manually on `krg-prod`; the production database and AD restore procedures have not yet been confirmed. This is a staged plan, not authorization to run migrations or deploy.

## Local verification

- `npm ci --no-audit --no-fund` and `npm run build` pass in `backend/`.
- All 36 Nunjucks templates compile. The edited add/result templates render with organization-scoped links.
- The compiled Express app serves `/login`, `/local-login`, and `/static/css/main.css` with HTTP 200; an unauthenticated `/` request redirects to `/login`.
- `npm run lint` fails at baseline: its `eslint src` command selects no TypeScript files. There is no ESLint configuration in the repository.
- This machine has no Docker, PostgreSQL installation, or WSL distribution. Authenticated org/project flows, LDAP writes, migrations, and integration behavior require a local service stack or a machine with access to a disposable test environment.

## Product shape to preserve

- An organization has users, projects, and its own organization admins.
- Project leads can manage membership in their assigned projects; organization admins manage their organization; system admins manage cross-organization setup.
- AD/LDAP remains the identity and group source. PostgreSQL keeps roster metadata, organization/project relationships, integration settings, and audit history.
- The primary UI should be an organization workspace with **People**, **Projects**, and **Settings**. A project contains its member management. Show system administration only to system admins. Keep account editing reachable from the user menu. This removes the separate project-lead navigation and duplicate user-creation pages without removing their permissions.

## What the code currently does

1. **The two user counts use different membership rules.** `admin/users.ts` lists users from `user_orgs`; `pl/users.ts` lists anyone whose `ldap_groups` overlaps a project's groups; `pl/index.ts` counts them the same way. A person can therefore appear in a project and not the organization's admin roster. New users created by either org admins or project leads do not insert a `user_orgs` row. Login and the manual mapping-sync route populate that table, so visibility can depend on whether someone has logged in or an admin ran a sync.
2. **Project and user authorization is too broad in several handlers.** Project-lead project queries and project access do not constrain `projects.org_id`. `isAnyOrgAdmin` grants the admin shortcut for an admin of *any* organization. The project edit and audit handlers load users by username without requiring membership in that project. Submitted project group names are merged without checking that they belong to the project; org-admin editing has the analogous problem for org groups. These are correctness and access-control work, ahead of visual redesign.
3. **Membership has multiple writers.** LDAP groups, `user_orgs`, and `org_ldap_group_mappings` can disagree. `auth.ts` upserts derived roles on login but does not remove stale derived memberships when mappings or groups disappear. The mapping-deletion debt is already recorded in `doc/todo.md`. Define whether an org membership is manual or LDAP-derived before changing queries or running a backfill.
4. **Data changes lack a safe release mechanism.** `runMigrations()` alters tables on startup with no schema version. `syncUsers()` deletes all DB users omitted from a successful nonempty LDAP result, which cascades to `user_orgs`; a partial LDAP response can lose metadata even though the empty-response guard passes. Project and org delete routes also cascade. There is no test suite or verified restore path in this checkout.
5. **The UI repeats flows.** Org admin, project lead, and system admin each have separate user lists, creation forms, result screens, and edit handlers. There are 36 Nunjucks templates and 14 route files. Shared macros cover only a few elements. Issue [#50](https://github.com/UCSD-E4E/E4E-Roster-V3/issues/50) identifies broken links and poor existing-user search. This branch fixes the hard-coded `/admin` and `/pl` links in two result screens and the project-lead add form; the search remains exact match with `LIMIT 1` and needs a fuller redesign.

## Delivery sequence

### 0. Make recovery and verification possible

- Record the production Git commit, compose configuration, PostgreSQL volume, AD backup owner, and deployed environment. Take a database backup and prove a restore into a disposable database. Confirm AD recovery separately because roster actions write AD before the local DB.
- Prepare a de-identified database fixture that retains multi-org, shared-group, project-lead, stale-membership, and missing-user cases. Do not commit production personal data or secrets.
- Add schema-versioned, additive migrations with a documented rollback/restore step. Stop the automatic user-prune path until it can detect partial LDAP results and preserve metadata.
- Add CI for TypeScript build and focused tests. Repair the `npm run lint` script/config; it currently finds no `.ts` files, and no ESLint configuration is present.

**Exit:** a disposable restore succeeds; the current data shape and counts are recorded; a failed release has a tested rollback.

### 1. Unify membership and close authorization gaps

- Specify a single membership rule: a project belongs to exactly one org; a project member must be an org member and match a mapped project group. Give manual and LDAP-derived org grants an explicit provenance so mapping removal does not silently retain access or erase an intentional grant.
- Reconcile existing `users`, `user_orgs`, LDAP groups, and mappings in a report before any write. Review exceptions, then backfill memberships with a dry-run and audit trail. Create/update memberships during new-user and add-existing flows, not only at login.
- Centralize org/project/user scoping in query and permission helpers. Use these for list, count, view, edit, add, and audit paths; validate every submitted group against the active org/project. Ensure a lead can act only on assigned projects and eligible users.
- Test a matrix covering two organizations, overlapping LDAP groups, admins of one org visiting another, ordinary project members, and POST requests that forge group names or usernames.

**Exit:** every listed project member appears in that organization's roster, project counts match their member lists, unauthorized read and write attempts fail, and new users immediately appear in the correct roster.

### 2. Merge repeated flows and redesign navigation

- Build shared people queries and create/edit services. Keep role-specific policy as parameters, with one page for adding an existing person and one for creating a person. Use shared Nunjucks partials for fields, search results, status, errors, and audit history.
- Replace exact-match `LIMIT 1` search with ranked, paginated username/name/email search, clear existing-membership status, and confirmation of the chosen person. Handle duplicates and no results without dead ends. This completes issue [#50](https://github.com/UCSD-E4E/E4E-Roster-V3/issues/50).
- Use one organization shell and three main destinations: People, Projects, Settings. A project detail includes members and lead controls; admin-only controls appear in place. Simplify redirects so old URLs keep working during transition.
- Establish spacing, typography, colors, responsive tables/forms, keyboard focus, and plain-language success/error messages. Remove row-wide click handlers in favor of accessible links. Keep the present server-rendered stack unless a concrete UI need justifies more client code.
- Prototype the shell against fixtures and review it at desktop and mobile widths before converting every page.

**Exit:** common tasks require fewer page changes, search works for partial names, and role changes do not create three divergent page implementations.

### 3. Ship safely and maintain it

- Add a read-only health/version endpoint and a deploy runbook that records the commit, backup, migration version, smoke checks, and rollback. Stage against restored data before production.
- Separate optional GitHub/Slack integration failures from core roster availability. `krg-infra` currently disables both bots via a compose override pending credentials.
- Track the deployment work in issue [#35](https://github.com/UCSD-E4E/E4E-Roster-V3/issues/35). The current `krg-infra` Nix definition uses a Git checkout at `/var/lib/krg/e4e-roster` plus a manual pull/restart. Its ADR 0016 proposes moving roster to an Incus tenant; that is an infrastructure project to coordinate, not a requirement for the UI cleanup.
- Roll out in small increments, checking real org/project counts and onboarding/editing behavior after each deploy.

**Exit:** the running version is visible, smoke checks pass, and rollback is documented and tested.

## Boundaries and decisions needed

- Confirm whether project membership is defined by LDAP group, an explicit project assignment, or both. The current implementation equates group overlap with project membership.
- Confirm how a user becomes a project lead for a *specific* project. The current org-wide `project_lead` role plus LDAP group overlap is only an approximation.
- Confirm whether organization membership from LDAP is automatic, manually granted, or both, and what should happen when the granting group disappears.
- Confirm production backup owners and whether a de-identified data snapshot can be made available for local tests. No remote-machine access is assumed.

## Deployment evidence

- Roster compose: `docker-compose.yml` defines backend, PostgreSQL 16, GitHub App, Slack bot, and Traefik routes. PostgreSQL uses the `postgres_data` named volume.
- `krg-infra/nix/hosts/krg-prod/default.nix` lines 240–258 registers `e4e-roster` with `krg.composeStacks`, reading the roster repo checkout and an infra-owned override.
- `krg-infra/nix/docker-compose/e4e-roster/disable-bots.override.yml` places the two bot services behind a disabled profile.
- `krg-infra/terraform/authentik/roster_secrets.tf` describes database/session/LDAP secrets in OpenBao and a manually populated `.env`.
- The user confirms production still uses manual deployment on `krg-prod` and is unsure whether backups have been restored successfully.
