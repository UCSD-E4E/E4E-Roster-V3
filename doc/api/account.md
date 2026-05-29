# Account

**Route prefix:** `/orgs/:orgSlug/account`
**Auth:** `requireAuth` → `requireOrgMember`

All roles (member, project_lead, org_admin, system admin) can access their own account.

---

## GET /orgs/:orgSlug/account

Fetches the user's own row from the `users` table.

| Condition | Output |
|---|---|
| User not yet synced to DB | Renders page with `profile: null` and a warning banner |
| `?saved=1` in query | Renders page with "Changes saved" banner |
| Default | Renders account page with profile data |

LDAP groups shown are **all** groups the user belongs to (not filtered to org scope) — see todo.

---

## POST /orgs/:orgSlug/account

Saves `secondaryEmail` and `phone` back to the `users` table. These fields are NOT written to LDAP (deferred — see todo).

| Condition | Output |
|---|---|
| DB update fails | `500` via error handler |
| Success | `302 → /orgs/:orgSlug/account?saved=1` |
