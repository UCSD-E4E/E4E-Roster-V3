# Integrated Slack / GitHub prototype

The existing roster backend now owns provider clients, Slack Socket Mode, GitHub webhook ingress, group-based access planning, execution, and audit history. The default Compose stack contains only the backend and PostgreSQL. The old `slackbot/` and `github-app/` directories remain as historical code; they are no longer launched by the default stack.

## Local simulation: available without credentials

Open **http://127.0.0.1:3100/demo**. The demo is bound to loopback and automatically signs you in as a demo administrator. It uses only the dedicated `roster_integrations_demo` database on port 55434. Slack, GitHub, and LDAP adapters are simulated, and no OIDC or directory sync runs. Do not put real credentials in simulation mode: verification there is simulated too.

The database container is `roster-integrations-prototype-db`. To restart after this chat:

```bash
docker start roster-integrations-prototype-db
cd /home/shperry/KRG/E4E-Roster-V3/backend
npm run demo:integrations
```

On a fresh checkout, create the container instead of starting it:

```bash
docker run -d --name roster-integrations-prototype-db \
  -p 127.0.0.1:55434:5432 \
  -e POSTGRES_DB=roster_integrations_demo \
  -e POSTGRES_USER=roster_demo -e POSTGRES_PASSWORD=roster_demo \
  postgres:16-alpine
```

Use the existing settings pages linked from the demo home:

1. Open E4E settings. Preview grants and apply them. Only E4E members appear, even though KRG uses the same LDAP group.
2. Verify each provider and inspect destination IDs. Open group settings to change mappings.
3. Run `/roster-check` as `UE4EALICE` in `TE4EDEMO` using the simulator.
4. Run `/roster-extend`, then check as `UKRGALICE` in `TKRGDEMO`. The same account expiration is visible in both organizations.
5. Try the E4E user ID in KRG: it is rejected. Disabled and expired members are excluded from access grants.
6. Return to `/demo` to see simulated provider effects. Settings also shows persistent organization audit events.

An extension renews an expiring account through 90 days from the database's current date. It never shortens a later expiration or converts a non-expiring account into an expiring account. Repeated requests do not accumulate additional time. Disabled accounts cannot self-extend; an expired but enabled account can renew.

Demo roster changes and audit records persist across restarts; simulated effects on the demo home are in memory. The simulation reinitializes fake integration configuration on startup, but retains modified account expirations.

## Optional real Slack / GitHub sandbox

This mode uses **real provider APIs** and its own `roster_integrations_sandbox` database. LDAP remains simulated, so account extensions affect only the sandbox roster, never AD. Use test workspaces, organizations, channels, teams, and accounts. The UI has a local demo administrator and must stay bound to loopback.

Stop the simulation process with Ctrl-C, then:

```bash
docker exec roster-integrations-prototype-db createdb -U roster_demo roster_integrations_sandbox
cd /home/shperry/KRG/E4E-Roster-V3/backend
# Generate this once, retain it securely, and use the same value on every sandbox restart.
export ENCRYPTION_KEY="$(openssl rand -hex 32)"
npm run demo:integrations -- --live-providers
```

The database may already exist; do not recreate or drop it. Losing/changing `ENCRYPTION_KEY` makes previously saved secrets unreadable; re-enter all connection secrets if that happens. The script does not load the repository's `.env` or use its production database/directory credentials.

The seeded connections start disabled, group destinations are empty, and GitHub usernames and Slack identity links are unset. Configure only the providers you want to test. Each roster organization has its own provider settings. Automatic scheduled grants are off unless `INTEGRATION_AUTO_SYNC=true`; saving a roster GitHub username can reconcile that person's existing mapped groups immediately.

## Weekly Slack onboarding and one-time channel notifications

In each organization's existing Slack settings, set **Roster bot channel ID**, invite the bot and the project leads to that channel, and enable **Check Slack weekly**. Configure `ROSTER_BASE_URL` to the public roster origin (HTTPS in production). Add the new `chat:write` and `im:write` bot scopes by reinstalling the app from the updated manifest, and register `/roster-connect` alongside the existing commands.

The existing backend checks due organizations at startup and hourly; each successful workspace scan schedules its next scan seven days later. The explicit **Check Slack for missing members now** button uses the same function. Scans exclude bots, deactivated users, guests, accounts without an email, known organization members, linked Slack accounts, and known disabled roster accounts.

Each missing person receives one DM with a seven-day, single-use browser link. Invitations are recorded before delivery; scans and restarts do not send reminders or automatically retry failed messages. After expiration, the person can explicitly request a replacement through `/roster-connect`. Replacements invalidate old links. Settings shows invitation and join-message delivery states.

The link opens the roster's existing SSO sign-in, preserves a hashed continuation across session regeneration, and then collects the person's GitHub username. Opening a link never claims it. Completion requires an active directory account. Matching Slack and roster emails use the direct completion flow. If no roster metadata exists yet, the existing directory upsert creates it from that authenticated person's directory account. No directory account, project, or resource group is created by onboarding. If the Slack and roster emails differ, the browser displays a ten-minute confirmation code. Run `/roster-connect CODE` from the exact invited Slack account and workspace, then return to the browser and click **Finish connection**. The proof is bound to the signed-in roster account and single-use invitation.

Successful completion adds a **regular organization member** only if membership is missing, and links the Slack identity in that organization. Existing membership roles are preserved. One message is posted to that organization's configured roster bot channel **only when organization membership is newly added**. It links directly to the existing `/orgs/<slug>/v2/people/<username>/edit` page. That page retains its existing administrator permission checks; project leads can coordinate assignment with an organization administrator. There is no separate approval/assignment page, reminder workflow, or automatic role/group elevation. A person already in the global roster who joins a second organization is a new member of that second organization and generates one notification there; merely linking an existing organization member sends no join notification. A pending GitHub submission can still generate a separate one-time review notification.

GitHub usernames submitted by members are stored separately as pending metadata. They do not overwrite a trusted username or trigger grants. The existing Edit User form displays the submitted value for an administrator to verify and save; My Account shows its pending status. A pending submission from an existing organization member sends one review message linking to Edit User; a newly joined member's join message includes that review request. Failed messages are recorded without automatic retry. This is username collection, not GitHub OAuth ownership verification.

In the local simulation, open organization Settings, run the scan, then return to `/demo`. A clickable simulated DM appears under **New member onboarding**. Opening it explicitly simulates SSO as `new-member-demo`; submission produces one simulated channel message with an Edit User link. Real SSO remains covered by an automated callback/session test; the live-provider sandbox's automatic demo admin is intentionally rejected by the personal linking flow. Use the normal backend with configured SSO for a real end-to-end sign-in test.

To run the isolated onboarding suite:

```bash
docker exec roster-integrations-prototype-db createdb -U roster_demo roster_onboarding_test
cd /home/shperry/KRG/E4E-Roster-V3/backend
npm run test:onboarding
```

The suite covers scan suppression, one-time notifications and failed deliveries, tenant channels, existing-role preservation, second-organization enrollment, single-use/expired links, cross-email ownership confirmation, disabled accounts/connections, and the actual Passport callback with session regeneration and CSRF checks. As with the other test databases, create it only if it does not already exist.

### Slack setup

For the prototype, create **a separate Slack app for each test workspace**. Reusing one distributed app across workspaces requires shared Socket Mode receiver routing, which is not implemented here.

1. Open [Your Slack Apps](https://api.slack.com/apps), choose **Create New App → From a manifest**, select the test workspace, and paste `backend/slack-app-manifest.yml`.
2. Confirm **Socket Mode** is enabled. Under **Basic Information → App-Level Tokens**, generate an app-level token with `connections:write`. This is the `xapp-…` token.
3. Install the app to the workspace from **OAuth & Permissions**. Copy its **Bot User OAuth Token**, `xoxb-…`.
4. Find the workspace ID (`T…`; it appears in the Slack web client's workspace URL). In the roster organization's Settings, enter workspace ID, bot token, app-level token, enable Slack, and save.
5. Use **Verify slack and list destinations**. A token from another workspace is rejected. Socket Mode connections refresh within about 15 seconds. No tunnel or public Slack request URL is needed.
6. Copy your Slack member ID from your profile's menu. Under **Slack identities in this organization**, link it to `alice-demo`. This administrator-approved link avoids needing your real email in the demo fixture. In normal use, the first command can link a unique matching institutional email from Slack's authenticated API.
7. In that workspace, run `/roster-check` and `/roster-extend`. Replies are ephemeral. In this sandbox, LDAP changes are simulated.
8. Add a channel mapping for `shared-demo` using a real channel ID (`C…`) from the destination list. Preview, then apply grants. For a private channel, invite the bot manually first; only private channels visible to the bot can be listed/used.

The manifest requests command, member/email lookup, channel listing/joining, and channel invitation scopes. Reinstall the app if scopes change. If commands do not respond, inspect the backend log for the tenant's connection status and check the app-level token, installed bot scopes, and workspace ID.

References: [Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode), [authorization](https://docs.slack.dev/tools/bolt-js/concepts/authorization/).

### GitHub setup

1. In the test GitHub organization, open **Settings → Developer settings → GitHub Apps → New GitHub App**. Use a unique name and a homepage URL such as `http://localhost:3100`.
2. For outgoing team access tests, uncheck **Active** under Webhook initially. No public URL, OAuth callback, user authorization, or PAT is needed for this flow.
3. Set **Organization permissions → Members → Read and write**. Repository administration permissions are not needed for assigning existing teams. Direct repository grants are outside this prototype.
4. Register the app, record its numeric **App ID**, generate a private key, and install the app on the test organization. The installation URL includes the numeric **Installation ID**.
5. In the roster organization's Settings, enter App ID, Installation ID, GitHub organization login, and the full PEM private key. Enable GitHub, save, and click **Verify github and list destinations**. The backend checks that the installation belongs to that organization and has Members write permission.
6. In People, edit `alice-demo` and set the GitHub username to **your own test account**. Directory writes in this sandbox are simulated. Avoid enabling scheduled sync during setup.
7. Under group settings for `shared-demo`, add a GitHub mapping using the real team slug from the destination list. Preview and apply. A pending invitation is recorded as pending; the recipient must accept before access becomes active. The team can already hold the desired repository permissions.

For inbound webhook testing:

1. Set a webhook secret in both GitHub App settings and the roster organization's Settings.
2. Expose only `/webhooks/github/<roster-org-id>` through your preferred HTTPS tunnel to localhost:3100. The exact path is shown on the roster Settings page. Do not expose the sandbox's automatically authenticated UI.
3. Set the GitHub App webhook URL to that HTTPS route, activate webhooks, and subscribe to Organization membership events. A signed ping should return 202.
4. Membership deliveries must match the configured installation and GitHub organization. The prototype records them in the organization audit log; it does not grant or revoke access in response to webhooks.

The optional Smee Compose helper forwards to the backend route, but a forwarding service must preserve the original request body and signature header. Do not disable verification to work around a proxy issue.

References: [team membership API and required permissions](https://docs.github.com/en/rest/teams/members), [installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation), [webhook signature verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

## Tests

The dedicated prototype suite refuses to run against a database other than `roster_integrations_test`. It resets data only in that test database:

```bash
docker exec roster-integrations-prototype-db createdb -U roster_demo roster_integrations_test
cd /home/shperry/KRG/E4E-Roster-V3/backend
npm run test:integrations-prototype
npm run build
```

Coverage includes cross-tenant grants and Slack identities, shared LDAP groups/destination names, disabled/expired accounts, disabled/ambiguous connections, failure reporting, email linking, shared expiry, LDAP failure, signed webhook tenant matching, and GitHub installation ownership. Provider calls are faked; the GitHub authentication ownership check uses a mocked HTTP response and generated test key. Existing roster tests are separate and retain their own test database configuration.

## Prototype limits and migration notes

- No production deployment or external provider operations were performed during implementation.
- No agreement signing, prerequisite engine, access revocation, direct repository permissions, or GitHub OAuth identity verification yet. GitHub usernames remain administrator-managed roster metadata.
- Weekly discovery and one-time onboarding messages are opt-in per organization. Scanning does not bulk-link identities; commands and the browser flow perform linking, and administrators can link explicitly.
- No durable queue/retry worker. Provider failures are audited and can be retried manually. Grant execution has an organization-level advisory lock; plans are rechecked before effects, but external provider calls and database writes cannot form one transaction.
- GitHub webhooks are observation-only and do not yet deduplicate delivery IDs. Slack token rotation and shared multi-workspace app receivers are not implemented.
- An LDAP update can succeed before a later PostgreSQL failure; a durable operation record/reconciliation path is still needed before production use of extensions.
- Legacy global `users.slack_username` fields remain for compatibility with existing profile screens. They are ignored by the integration system; use Settings to link each workspace identity. Legacy mappings with null `org_id` remain stored but are ignored and need manual organization assignment.
- The migration adds `integration_identities` with membership foreign keys and changes mapping uniqueness to include organization. It does not infer tenant identity from old credentials or global Slack values. Disabling a connection stops future effects and closes its socket on the next refresh; it does not revoke existing provider access.
- Organization settings and group mappings remain separate concerns: connection credentials belong to organization settings; destinations belong to groups.
