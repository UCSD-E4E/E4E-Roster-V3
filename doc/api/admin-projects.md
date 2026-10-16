# Admin — Project Management

**Route prefix:** `/orgs/:orgSlug/admin/projects`
**Auth:** `requireAuth` → `requireOrgMember` → `requireOrgAdmin`

---

## GET /orgs/:orgSlug/admin/projects

Lists all projects with their LDAP group counts.

**Known issue:** query does not filter by `org_id` — all projects across all orgs are shown. See todo.

| Condition | Output |
|---|---|
| DB error | `500` via error handler |
| Success | Renders project list |

---

## POST /orgs/:orgSlug/admin/projects

Creates a new project scoped to the current org.

| Condition | Output |
|---|---|
| Missing name | `400` |
| DB error | `500` via error handler |
| Success | `302 → /orgs/:orgSlug/admin/projects/:newId` |

---

## GET /orgs/:orgSlug/admin/projects/:id

Fetches the project and its assigned LDAP groups. Also fetches all LDAP groups from LDAP for the "add group" dropdown.

**Known issue:** no check that project `:id` belongs to the current org — any org admin can access any project by guessing the ID. See todo.

| Condition | Output |
|---|---|
| Project not found | `404` |
| LDAP unreachable | Renders page with empty group dropdown |
| Success | Renders project detail |

---

## POST /orgs/:orgSlug/admin/projects/:id/groups

Adds an LDAP group to the project.

**Known issue:** no ownership check on the project ID.

| Condition | Output |
|---|---|
| Missing `ldapGroup` | `400` |
| Group already mapped | Silent no-op (ON CONFLICT DO NOTHING) |
| Success | `302 → /orgs/:orgSlug/admin/projects/:id` |

---

## POST /orgs/:orgSlug/admin/projects/:id/groups/remove

Removes an LDAP group from the project.

| Condition | Output |
|---|---|
| Group not mapped | Silent no-op |
| Success | `302 → /orgs/:orgSlug/admin/projects/:id` |

---

## POST /orgs/:orgSlug/admin/projects/:id/edit

Updates project name and description.

**Known issue:** no ownership check on the project ID.

| Condition | Output |
|---|---|
| Missing name | `400` |
| Success | `302 → /orgs/:orgSlug/admin/projects/:id` |

---

## POST /orgs/:orgSlug/admin/projects/:id/delete

Deletes a project (cascades to `project_ldap_groups`).

**Known issue:** no ownership check on the project ID.

| Condition | Output |
|---|---|
| Success | `302 → /orgs/:orgSlug/admin/projects` |
