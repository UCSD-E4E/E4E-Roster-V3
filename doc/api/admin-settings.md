# Admin — Settings

**Route prefix:** `/orgs/:orgSlug/admin/settings`
**Auth:** `requireAuth` → `requireOrgMember` → `requireOrgAdmin`

Stores per-org GitHub and Slack integration credentials in `org_integrations`. Secret values (private key, bot token) are encrypted at rest via `services/crypto`.

---

## GET /orgs/:orgSlug/admin/settings

Loads GitHub and Slack config for the current org. Private values are never sent to the browser — the page only shows whether they are set (`hasPrivateKey`, `hasBotToken`).

| Condition | Output |
|---|---|
| No org context | `400` |
| No config stored yet | Renders page with empty fields and services disabled |
| `?saved=github` or `?saved=slack` | Renders with success banner |
| `?error=` | Renders with error banner |
| Success | Renders settings page |

---

## POST /orgs/:orgSlug/admin/settings/github

Saves GitHub App credentials. If `privateKey` is blank, the existing stored key is preserved.

| Condition | Output |
|---|---|
| No org context | `400` |
| `privateKey` provided | Encrypted and stored |
| `privateKey` blank | Existing encrypted key kept |
| `enabled` = `"true"` | Service enabled; otherwise disabled |
| Success | `302 → /orgs/:orgSlug/admin/settings?saved=github` |

---

## POST /orgs/:orgSlug/admin/settings/slack

Saves Slack credentials. If `botToken` is blank, the existing token is preserved.

| Condition | Output |
|---|---|
| No org context | `400` |
| `botToken` provided | Encrypted and stored |
| `botToken` blank | Existing encrypted token kept |
| `enabled` = `"true"` | Service enabled; otherwise disabled |
| Success | `302 → /orgs/:orgSlug/admin/settings?saved=slack` |
