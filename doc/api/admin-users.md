# Admin — User Management

**Route prefix:** `/orgs/:orgSlug/admin/users`
**Auth:** `requireAuth` → `requireOrgMember` → see per-route notes

GET `/` is accessible to `project_lead` and above. All other routes require `org_admin` (or system/local admin).

---

## GET /orgs/:orgSlug/admin/users

Lists users who are members of the current org (`user_orgs` join). LDAP groups shown per user are filtered to groups that belong to the org (`org_groups` table).

| Condition | Output |
|---|---|
| DB error | `500` via error handler |
| Success | Renders user table with org-scoped data |

---

## POST /orgs/:orgSlug/admin/users/sync

Triggers a full LDAP → DB sync. Returns JSON.

| Condition | Output |
|---|---|
| LDAP unreachable | `500 { ok: false, message }` |
| Success | `200 { ok: true, synced, errors }` |

---

## GET /orgs/:orgSlug/admin/users/add

Search form for adding an existing system user to the org.

| Condition | Output |
|---|---|
| No `?q` query | Renders empty search form |
| User not found | Renders form with "no user found" message |
| User found, already in org | Renders form with current role pre-selected and update warning |
| User found, not in org | Renders form with role selector |

---

## POST /orgs/:orgSlug/admin/users/add

Adds or updates a user's membership in the org via `user_orgs` (upsert).

| Condition | Output |
|---|---|
| Missing `username` or `role` | `400` |
| Username not in `users` table | `404` |
| DB error | `500` via error handler |
| Success | `302 → /orgs/:orgSlug/admin/users` |

---

## GET /orgs/:orgSlug/admin/users/new

Renders new user form. Fetches all LDAP groups for checkbox selection.

| Condition | Output |
|---|---|
| LDAP unreachable | Renders form with "could not fetch groups" hint |
| Success | Renders new user form |

---

## POST /orgs/:orgSlug/admin/users/new

Creates an LDAP account, optional SSH keys, and a DB row.

| Condition | Output |
|---|---|
| LDAP create fails | Renders result page showing failure |
| LDAP already exists | Renders result page showing warning; DB row still upserted |
| LDAP succeeds; SSH key fails | Renders result page showing partial success per key |
| GitHub username provided | Triggers async GitHub org invite (non-blocking) |
| DB write fails | `500` via error handler |
| Success | Renders `new-result` page with temp password |

---

## GET /orgs/:orgSlug/admin/users/:username/edit

Fetches user from DB and LDAP (for current SSH keys). Shows all LDAP groups for checkbox selection.

| Condition | Output |
|---|---|
| Username not in DB | `404` |
| LDAP unreachable | Renders form with "could not fetch groups" hint; SSH keys shown as empty |
| Success | Renders edit form |

Note: shows **all** LDAP groups, not org-scoped groups — see todo.

---

## POST /orgs/:orgSlug/admin/users/:username/edit

Applies group, expiry, SSH key, and profile field changes.

| Condition | Output |
|---|---|
| Username not in DB | `404` |
| Any LDAP operation fails | Re-renders edit form with error message; DB not updated |
| All LDAP succeeds | DB row updated; GitHub invite triggered if GitHub username set |
| Success | `302 → /orgs/:orgSlug/admin/users` |
