# Admin — Group Management (Integrations)

**Route prefix:** `/orgs/:orgSlug/admin/integrations`
**Auth:** `requireAuth` → `requireOrgMember` → `requireOrgAdmin`

Groups shown are limited to those explicitly assigned to the org via `org_groups` (created by org admin) or `org_ldap_group_mappings` (added by system admin). Users' cross-org groups are never leaked here.

---

## GET /orgs/:orgSlug/admin/integrations

Loads the org's group list. If a group is selected via `?group=`, also loads its GitHub/Slack mappings and its current org role.

| Condition | Output |
|---|---|
| No `?group=` | Renders page with group list; right panel shows placeholder |
| Group selected | Renders page with org role card + GitHub + Slack mappings |
| DB error | `500` via error handler |

---

## POST /orgs/:orgSlug/admin/integrations/role

Sets or clears the org role for a group in `org_ldap_group_mappings`. This controls what role members of this LDAP group are automatically granted in this org on next login.

| Condition | Output |
|---|---|
| Missing `ldapGroup` | `400` |
| `role` is empty string | Deletes the mapping (group grants no role in this org) |
| `role` is `member`, `project_lead`, or `org_admin` | Upserts mapping |
| Success | `302 → /orgs/:orgSlug/admin/integrations?group=<name>` |

---

## POST /orgs/:orgSlug/admin/integrations/mappings

Adds a GitHub or Slack integration mapping for a group.

| Condition | Output |
|---|---|
| Missing `ldapGroup`, `service`, `targetId`, or `targetName` | `400` |
| Mapping already exists | Silent no-op (ON CONFLICT DO NOTHING) |
| Success | `302 → /orgs/:orgSlug/admin/integrations?group=<name>` |

---

## POST /orgs/:orgSlug/admin/integrations/mappings/:id/delete

Removes a GitHub or Slack mapping.

| Condition | Output |
|---|---|
| ID not found | Silent no-op (DELETE affects 0 rows) |
| Success | `302 → /orgs/:orgSlug/admin/integrations?group=<name>` |

---

## POST /orgs/:orgSlug/admin/integrations/sync

Triggers a GitHub/Slack sync for the current org. Returns JSON.

| Condition | Output |
|---|---|
| Sync throws | `500 { ok: false, message }` |
| Success | `200 { ok: true, githubOps, slackOps, errors? }` |

---

## GET /orgs/:orgSlug/admin/integrations/api/teams
## GET /orgs/:orgSlug/admin/integrations/api/channels

Proxy endpoints used by the integrations UI dropdowns to fetch available GitHub teams and Slack channels.

| Condition | Output |
|---|---|
| Upstream service unreachable | `502 { error: "... unreachable" }` |
| Success | `200` with upstream JSON |
