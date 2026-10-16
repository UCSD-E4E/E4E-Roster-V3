# Project Lead Routes

**Route prefix:** `/orgs/:orgSlug/pl`
**Auth:** `requireAuth` → `requireOrgMember` → `requireProjectLead`

`requireProjectLead` passes: system admins, any org admin (in any org), or users with `project_lead` role in at least one org.

All `/pl/projects/:projectId/users/*` routes additionally run `requireProjectAccess`: project leads must belong to a group assigned to the project; system admins and org admins pass through unconditionally.

---

## GET /orgs/:orgSlug/pl/projects

Lists projects.

| User type | Projects shown |
|---|---|
| System admin or any org admin | All projects in DB (no org filter — see todo) |
| Project lead | Only projects whose LDAP groups overlap with the user's own `groups` |

---

## GET /orgs/:orgSlug/pl/projects/:projectId/users

Lists project members — users whose `ldap_groups` overlap with the project's assigned groups.

| Condition | Output |
|---|---|
| Project not found / access denied | `404` or `403` |
| Project has no LDAP groups | Renders with warning banner |
| Success | Renders member table |

---

## GET /orgs/:orgSlug/pl/projects/:projectId/users/:username/edit

Fetches user from DB for editing. Only project-scoped fields are editable (project groups, contact info, GitHub/Slack, disabled flag). PLs cannot edit admin-group users.

| Condition | Output |
|---|---|
| Project access denied | `403` |
| User not found | `404` |
| User is in admin group | `403` |
| Success | Renders edit form with project groups only |

---

## POST /orgs/:orgSlug/pl/projects/:projectId/users/:username/edit

Saves changes. Preserves non-project LDAP groups — only project-assigned groups are modified.

| Condition | Output |
|---|---|
| Project access denied | `403` |
| User in admin group | `403` |
| LDAP group update fails | Re-renders form with error; DB not updated |
| Success | `302 → /orgs/:orgSlug/pl/projects/:projectId/users` |

---

## GET /orgs/:orgSlug/pl/projects/:projectId/users/add

Search form to add an existing user to the project.

| Condition | Output |
|---|---|
| No `?q` | Empty search form |
| User not found | "No user found" message |
| User is in admin group | Error: admin users cannot be managed via project portal |
| User found | Shows user with project group checkboxes |

---

## POST /orgs/:orgSlug/pl/projects/:projectId/users/add

Adds the user to selected project groups. Non-project groups are preserved.

| Condition | Output |
|---|---|
| User not found | `404` |
| User in admin group | `403` |
| LDAP update fails | `500` |
| Success | `302 → /orgs/:orgSlug/pl/projects/:projectId/users` |

**Known issue:** redirect uses a hardcoded `/pl/projects/...` path instead of `orgBase`. See todo.

---

## GET /orgs/:orgSlug/pl/projects/:projectId/users/new

Renders new user form scoped to project groups only.

| Condition | Output |
|---|---|
| Project has no groups | Renders form with empty groups list |
| Success | Renders form (expiry pre-set to 90 days, role locked to "student") |

---

## POST /orgs/:orgSlug/pl/projects/:projectId/users/new

Creates LDAP account. Role is always `student`; expiry is always 90 days from now — these are enforced server-side and cannot be changed by a PL.

| Condition | Output |
|---|---|
| LDAP create fails | Renders result page with failure |
| LDAP already exists | Renders result page with warning |
| DB write fails | `500` |
| Success | Renders `new-result` page with temp password |

---

## GET /orgs/:orgSlug/pl/projects/:projectId/users/:username/audit

Shows the audit log for a user (`audit_log` table, filtered by `target_username`).

| Condition | Output |
|---|---|
| User not found | `404` |
| User is in admin group | `403` |
| Success | Renders audit log |
