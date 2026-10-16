# System Admin Routes

**Route prefix:** `/system`
**Auth:** `requireAuth` → `requireSystemAdmin` (system admin or local admin only)

---

## GET /system → GET /system/local-admins (redirect)

---

## GET /system/users

Lists all users across all orgs (no org filter).

| Condition | Output |
|---|---|
| DB error | `500` |
| Success | Renders global user table |

---

## POST /system/users/sync

Triggers a full LDAP → DB sync.

| Condition | Output |
|---|---|
| LDAP unreachable | `500 { ok: false, message }` |
| Success | `200 { ok: true, synced, errors }` |

---

## GET /system/users/new

Renders new user form with all LDAP groups.

| Condition | Output |
|---|---|
| LDAP unreachable | Renders with "could not fetch groups" hint |
| Success | Renders form |

---

## POST /system/users/new

Creates LDAP account and DB row. No org is automatically assigned.

| Condition | Output |
|---|---|
| LDAP fails | Renders result page with failure |
| LDAP already exists | Renders result page with warning; DB still upserted |
| GitHub username provided | Async GitHub invite triggered |
| Success | Renders `new-result` page with temp password |

---

## GET /system/users/:username/edit

| Condition | Output |
|---|---|
| User not found | `404` |
| LDAP unreachable | Renders with empty group list / SSH keys |
| Success | Renders edit form |

---

## POST /system/users/:username/edit

| Condition | Output |
|---|---|
| Any LDAP operation fails | Re-renders form with error; DB not updated |
| Success | `302 → /system/users` |

---

## GET /system/groups/new

Renders new group form with optional project, GitHub team, and Slack channel assignment. Uses 2 s timeout on external service fetches.

| Condition | Output |
|---|---|
| External services unreachable | Renders with empty dropdowns and "unreachable" hints |
| Success | Renders form |

---

## POST /system/groups

Creates an LDAP group. Does NOT automatically assign the group to any org — system admin must use LDAP Mappings to associate it with an org.

| Condition | Output |
|---|---|
| Missing name | `302 → /system/groups/new?error=...` |
| LDAP fails | `302 → /system/groups/new?error=<message>` |
| Project ID provided | Row in `project_ldap_groups` |
| GitHub/Slack provided | Row in `group_mappings` (no `org_id`) |
| Success | `302 → /system/users` |

**Known issue:** on success, redirects to `/system/users` instead of a relevant page. See todo.

---

## GET /system/local-admins

Lists all local admin accounts with status and last-used timestamps.

---

## POST /system/local-admins

Creates or re-enables a local admin account (bcrypt hash stored).

| Condition | Output |
|---|---|
| Missing username or password | `302 → /system/local-admins?error=...` |
| Username already exists | Updates password hash and re-enables account |
| Success | `302 → /system/local-admins` |

---

## POST /system/local-admins/:id/delete

Permanently deletes a local admin account.

---

## POST /system/local-admins/:id/toggle

Enables or disables a local admin account.

---

## GET /system/orgs

Lists all orgs with member counts and theme colors.

---

## POST /system/orgs

Creates a new org. `themeColor` must be a valid `#RRGGBB` hex value; invalid values are stored as `null`.

| Condition | Output |
|---|---|
| Missing slug or name | `302 → /system/orgs?error=...` |
| Success | `302 → /system/orgs` |

---

## POST /system/orgs/:id/theme

Updates an org's theme color.

| Condition | Output |
|---|---|
| Invalid hex value | `302 → /system/orgs?error=Invalid+color+value` |
| Success | `302 → /system/orgs` |

---

## POST /system/orgs/:id/delete

Deletes an org and cascades to `user_orgs`, `org_ldap_group_mappings`, `org_groups`, etc.

---

## GET /system/orgs/:id/ldap-mappings

Shows LDAP group → role mappings for an org. Allows setting which LDAP groups grant `member`, `project_lead`, or `org_admin` in this org.

---

## POST /system/orgs/:id/ldap-mappings

Adds or updates an LDAP group → role mapping. Also inserts the group into `org_groups` so it appears in the org's Group Management page.

| Condition | Output |
|---|---|
| Missing group or role | `302 → .../ldap-mappings?error=...` |
| Conflict | Updates existing mapping role |
| Success | `302 → /system/orgs/:id/ldap-mappings` |

---

## POST /system/orgs/:id/ldap-mappings/:mappingId/delete

Removes an LDAP → role mapping. Does **not** remove the group from `org_groups`.

| Condition | Output |
|---|---|
| Success | `302 → /system/orgs/:id/ldap-mappings` |
