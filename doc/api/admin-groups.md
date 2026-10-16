# Admin — Group Creation

**Route prefix:** `/orgs/:orgSlug/admin/groups`
**Auth:** `requireAuth` → `requireOrgMember` → `requireOrgAdmin`

---

## GET /orgs/:orgSlug/admin/groups/new

Renders the new group form. Fetches projects from DB and attempts to fetch GitHub teams + Slack channels (2 s timeout each).

| Condition | Output |
|---|---|
| GitHub app unreachable / timeout | Renders form with empty GitHub dropdown and "unreachable" hint |
| Slackbot unreachable / timeout | Renders form with empty Slack dropdown and "unreachable" hint |
| `?error=` in query | Renders form with error banner |
| Success | Renders group creation form |

---

## POST /orgs/:orgSlug/admin/groups

Creates an LDAP group and optionally links it to a project, GitHub team, and/or Slack channel.

| Condition | Output |
|---|---|
| Missing group name | `302 → new?error=Group+name+is+required` |
| LDAP group creation fails | `302 → new?error=<message>` |
| LDAP group already exists | Continues (treated as success); audit logged with `alreadyExisted: true` |
| Project ID provided | Row inserted into `project_ldap_groups` |
| GitHub team provided | Row inserted into `group_mappings` |
| Slack channel provided | Row inserted into `group_mappings` |
| Org context present | Group recorded in `org_groups` (makes it visible in Group Management) |
| Success | `302 → /orgs/:orgSlug/admin/integrations?created=<name>` |
