# Roster setup checklist

Use this for the combined roster backend, Slack, and GitHub deployment on `krg-prod`. The [full deployment guide](deployment.md) contains the copyable infrastructure configuration and troubleshooting details.

The [release scope](deployment.md#before-a-real-server-trial) retains existing LDAP, session storage, and session authorization behavior. The infra PR contains the OpenBao wiring below; host activation is pending, and the application currently reads `ENCRYPTION_KEY` from its environment, with no file-key or Transit support.

## 1. Configure OpenBao secret delivery

1. Keep the existing infrastructure-managed secrets:

   | KV-v2 path | Fields |
   |---|---|
   | `secret/krg-prod/authentik-managed/roster` | `db_password`, `session_secret` |
   | `secret/krg-prod/authentik-managed/roster-oidc` | `client_id`, `client_secret` |
   | `secret/krg-prod/authentik-managed/roster-ldap` | `bind_password` |

2. Store the encryption key as `encryption_key` at `secret/krg-prod/roster-crypto`. For existing encrypted records, retain the same key. For a fresh installation, use the [key creation command](deployment.md#42-seed-or-import-the-encryption-key).
3. Apply the [OpenBao Agent templates](deployment.md#43-render-runtime-files-with-the-existing-host-agent) to render restricted runtime files:
   - `/run/krg/roster/backend.env`: database, session, OIDC, LDAP secrets, and `ENCRYPTION_KEY`.
   - `/run/krg/roster/compose.env`: `DB_PASSWORD` for host-side Compose interpolation.
4. Apply the [Compose override and systemd ordering](deployment.md#44-wire-compose-and-systemd). Use Compose 2.30 or newer. Replace the historical bot override, require `openbao-agent.service`, and load `compose.env` into the roster systemd service. Keep secrets out of the checkout `.env`.

## 2. Configure the roster

In `/var/lib/krg/e4e-roster/.env`, set the following nonsecret values for your deployment:

```dotenv
NODE_ENV=production
PORT=3000
ROSTER_HOST=roster.example.com
ROSTER_BASE_URL=https://roster.example.com
DB_HOST=db
DB_PORT=5432
DB_NAME=e4e_roster
DB_USER=e4e
OIDC_ISSUER_URL=https://auth.example.com/application/o/roster/
OIDC_REDIRECT_URI=https://roster.example.com/auth/callback
SYSTEM_ADMIN_GROUP=system-admin
LDAP_URL=ldaps://directory.example.com
LDAP_BIND_DN=CN=svc_roster,CN=Users,DC=example,DC=com
LDAP_BASE_DN=DC=example,DC=com
LDAP_USERS_DN=CN=Users,DC=example,DC=com
LDAP_GROUPS_DN=CN=Users,DC=example,DC=com
LDAP_DOMAIN=example.com
INTEGRATION_AUTO_SYNC=false
```

Register the exact callback URL in Authentik. Provide `openid profile email groups` claims and a stable directory username. Ensure your administrator belongs to `SYSTEM_ADMIN_GROUP`. Verify the LDAP search scope before startup: synchronization starts immediately.

## 3. Start the application

1. Back up the existing database and matching encryption key. Preserve the Compose project identity and database volume.
2. Deploy the reviewed infrastructure configuration and confirm the Agent rendered its files successfully.
3. Build the backend image from the intended application revision, then recreate it using the existing `e4e-roster` Compose/systemd deployment procedure. A restart alone does not build an image or reload changed container environment values.
4. Run only the backend and PostgreSQL. Route HTTPS through Traefik; keep backend port 3000 and PostgreSQL port 5432 private. Do not run the old Slack/GitHub sidecars or enable `SKIP_OIDC`.
5. Sign in through SSO. Startup applies database migrations automatically.

## 4. Create organizations

In system administration, create each organization and map directory groups to its roles. Configure its projects and directory groups. Confirm an organization administrator can open `/orgs/<slug>/v2/settings`.

Repeat the following provider setup separately for each organization.

## 5. Connect Slack

1. Create a Slack app in the organization's workspace using [backend/slack-app-manifest.yml](../backend/slack-app-manifest.yml).
2. Enable Socket Mode. Create an app-level `xapp-…` token with `connections:write`.
3. Install the app and copy its `xoxb-…` Bot User OAuth Token. Confirm `/roster-connect`, `/roster-check`, and `/roster-extend` are installed.
4. In organization Settings, enter the workspace ID (`T…`), bot token, and app-level token. Enable Slack and click **Verify slack and list destinations**.
5. Create a roster bot channel, invite the bot and project leads/admins, and save its channel ID under **Roster bot channel ID**. Invite the bot manually to any private destination channels.

Use a distinct Slack app/workspace connection per roster organization. Socket Mode needs outbound connectivity; no inbound Slack endpoint is required.

## 6. Connect GitHub

1. Register a GitHub App in the matching GitHub organization. Set its homepage to the roster URL and grant **Organization permissions → Members: Read and write**.
2. Generate a private key, install the app into that organization, and record its App ID and Installation ID.
3. In roster organization Settings, enter the GitHub organization, App ID, Installation ID, and private key. Enable GitHub and verify/list destinations.
4. If using webhooks, copy the webhook URL shown in roster Settings into the GitHub App, configure the same webhook secret on both sides, and enable membership events. Webhooks are optional for outgoing membership grants.

## 7. Test, then enable onboarding

1. Have a test user run `/roster-connect`, sign in through SSO, and enter a GitHub username. They must already have an active directory account; Slack and roster email addresses must match.
2. Verify/save the GitHub username using the existing **Edit User** page. Self-submitted usernames remain pending until reviewed.
3. In organization Settings → Groups, map a test group to Slack channel IDs and GitHub team slugs. Preview, then apply grants. Accept any GitHub organization invitation before checking team access.
4. Test `/roster-check` and `/roster-extend`. Expiration changes affect the shared directory account across organizations.
5. Enable **Check Slack weekly** after the test succeeds. New organization members are added as regular members and generate one message in the configured bot channel, linking to **Edit User** for project/group assignment. Linking an existing organization member sends no join notification.
6. Optionally enable `INTEGRATION_AUTO_SYNC=true` after verifying mappings. Keeping it false disables scheduled grants only; manual apply and relevant user saves can still grant access.

Keep database backups and the matching encryption key recoverable together. See the [full runbook](deployment.md) for acceptance tests, updates, and rollback.
