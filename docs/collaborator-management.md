# Collaborator invitation management

`/collab-manage` lets an explicitly authorized roster user create single-use,
email-bound invitations to Authentik's existing
`krg-collaborator-enrollment` flow. Enrollment creates an email-verified,
Authentik-local external user. It never creates a Samba account or roster entry.

## Granting access

System administrators open **System → Collab admins** at
`/system/v2/collab-admins`, select a roster username, and grant `collab-admins`.
They can grant themselves access there. Existing break-glass system
administrators use the same system administration controls.

The grant is independent of project-lead, organization-admin, and system-admin
roles, so those roles can coexist. It is stored in `roster_role_grants`, rather
than an LDAP group or OIDC claim; organization-level group editors cannot grant
it. Every request checks the grant in the database. Revocation takes effect on
the next request, including for existing sessions.

All users without a grant receive HTTP 403 at `/collab-manage`, including
anonymous visitors and system administrators. Grant and revoke actions are
audited. An explicit grant permits invitations for every partner in the catalog;
it is not scoped to the administrator's roster organizations.

## Creating an invitation

1. Open `/collab-manage` and enter the collaborator's email.
2. Select the tenant and partner organization fetched from Authentik.
3. Select an invitation lifetime: 1, 3, 7, 14, or 30 days.
4. Create the invitation and copy the returned enrollment URL. The result also
   lists direct application links to share with the collaborator.

Each invitation has exactly one tenant/org pair: the existing enrollment flow
stores scalar `tenant` and `org` user attributes. It cannot enroll a single
account into multiple organizations by selecting multiple groups.

The backend refetches the catalog before creating the invitation and rejects
unknown or removed pairs. It sends only `attributes.tenant`, `attributes.org`,
and `attributes.invited_email` as fixed data. Users choose their own username,
name, and password during enrollment; email confirmation activates the account.
The email confirmation link expires after 30 minutes, separately from the
invitation lifetime.

The invitation link is shown once through a session-backed redirect. Result
pages are private/no-store and links are not included in audit records or
request URLs. Roster records invitation attempts; Authentik records creation
and redemption. On an ambiguous provider timeout, check Authentik before
creating another invitation; the backend does not retry a create automatically.
Revoking a collab administrator does not revoke invitations they already issued.

## Authentik catalog

Authentik does not have a native directory of the application-specific partner
org IDs. The infrastructure repository publishes `attributes.roster_collaborators`
on the configured Authentik brand, derived from the existing tenant and partner
configuration. Roster fetches that brand through the Authentik API; it does not
read Samba, scan users, or retrieve reusable invitation bearer tokens.

Example brand attribute structure (IDs and URLs here are illustrative):

```json
{
  "roster_collaborators": {
    "flow": "11111111-1111-4111-8111-111111111111",
    "flowSlug": "krg-collaborator-enrollment",
    "tenants": [{
      "id": "fishsense",
      "name": "FishSense",
      "organizations": [{ "id": "reef", "name": "REEF" }],
      "applications": [{ "name": "FishSense web", "url": "https://fishsense.example.org/" }]
    }]
  }
}
```

Manage the catalog through `terraform/authentik/roster_collaborators.tf` in
`KastnerRG/krg-infra`. Brand metadata is configuration, not authorization by
itself: application access continues to use `collaborator_tenants.tf` and each
application's tenant/workspace isolation. Removing a catalog entry prevents new
roster invites; it does not revoke existing users or issued invites. Never put
credentials or invitation tokens in brand attributes.

Application URLs must be direct HTTPS links outside Authentik. FishSense's
mobile-provider `blank://blank` callback is not a web destination and is omitted.
Label Studio's direct destination is `https://app.heartex.com/`; the collaborator
may need to choose company SSO there, since the Authentik tile uses a separate
IdP-initiated SAML URL.

## Token and runtime configuration

### Why a new credential is needed

The checked-in roster runtime configuration supplies no Authentik management API
token. This is a configuration finding, not an audit of every token or secret
in the live deployment. The credentials already present serve different purposes:

| Existing credential | What it does | Why it is not used for this page |
|---|---|---|
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | Identify the roster application during browser sign-in | The existing authorization-code flow requests `openid profile email groups`, not management API access |
| Signed-in user's OIDC tokens | Identify that user and supply roster role claims | Invitation creation should use a controlled backend identity rather than depend on each user's Authentik API permissions |
| `LDAP_BIND_PASSWORD` | Lets roster read/write Samba AD | Samba credentials cannot authorize Authentik REST API calls |
| Infrastructure's `secret/krg-deploy/authentik-admin-token` | Lets the deployment process configure Authentik | It is broadly privileged and is not supplied to the roster; distributing it to a web application would expand its exposure |
| An invitation's `itoken` | Lets an invitee redeem that invitation | It is an enrollment bearer link, not a credential for creating more invitations |

No change to the roster's OIDC client secret or requested OIDC scopes is needed.
The companion infrastructure change creates **`svc-roster-invitations`**, a local
Authentik service account, and an **`intent = "api"`** token for that identity.
This is not a Samba account, a new user login, or an app-password token.

### Runtime values and API calls

Configure the roster backend with:

| Environment variable | Value |
|---|---|
| `AUTHENTIK_URL` | Authentik HTTPS origin, e.g. `https://auth.krg.ucsd.edu` |
| `AUTHENTIK_BRAND_ID` | UUID of the brand containing the collaborator catalog |
| `AUTHENTIK_API_TOKEN` | Service-account token with intent `api` |

The backend sends `Authorization: Bearer <token>` over HTTPS to exactly these API
operations:

- `GET /api/v3/core/brands/<AUTHENTIK_BRAND_ID>/`: fetch the configured catalog.
- `POST /api/v3/stages/invitation/invitations/`: create an invitation and receive
  its UUID. Roster combines that UUID with the catalog's enrollment flow slug
  to construct the enrollment link; application links come from the catalog.

The token is never returned to the browser. A person granted `collab-admins`
does not need a personal Authentik API token or Authentik administrator status.
The roster role authorizes use of the page; the service account authorizes the
backend's API calls.

### Required permissions and their limits

Permissions belong to the service account's **Roster collaborator invitation API**
RBAC role; the token authenticates as that account:

| Permission | Scope | Purpose |
|---|---|---|
| `authentik_stages_invitation.add_invitation` | Global | Create single-use invitations |
| `view_brand` on `authentik_brands.brand` | Catalog brand only | Read available tenant/org pairs and direct links |
| `view_flow` on `authentik_flows.flow` | Collaborator enrollment flow only | Read/select the enrollment flow |

It does not need Samba privileges, Authentik superuser status, group/user writes,
or permission to list existing invitations. Authentik's add-invitation permission
is a model permission; the roster enforces the permitted flow and tenant/org
payload. Keep the token on the backend and do not reuse the infrastructure
deployment administrator token.

The global add-invitation permission is broader than the roster form: it does
not itself enforce single use, invited email, a maximum lifetime, or the
catalog's tenant/org pairs. Those restrictions are enforced by the roster
backend. A compromised service-account token could bypass that form, which is
why it must remain a protected backend secret. Object-scoped read permissions
do not turn creation into a field-scoped authorization rule.

### Provisioning and activation

The infrastructure change declares the service account, role, permissions, API
token, and secret write-back at
`secret/krg-prod/authentik-managed/roster-invitations` (`url`, `brand_id`, `token`).
Infrastructure PR #644 includes the runtime wiring and deployment order. Merge
roster PR #88 first, then the infrastructure PR. The normal fleet deploy creates
an empty secret path with CAS=0 before the shared renderer runs, provisions the
actual token in Authentik's configuration phase, and rerenders it into the
root-only `/run/krg/roster/invitations.env`. Compose reads this file in raw mode.
No manual token creation or follow-up template change is needed.

The deployment then requires a clean roster `main` checkout, fast-forwards it to
the merged main, builds/reloads the backend, compares the running credentials to
the rendered file without logging them, and checks the live catalog read. It
fails rather than overwriting local source changes or accepting stale
credentials. The API settings are temporarily blank only during the first
pre-Authentik render; existing required roster secrets remain fail-closed.

For the complete sequence and recovery notes, see
[the infrastructure runbook](https://github.com/KastnerRG/krg-infra/blob/main/docs/roster-collaborator-api.md)
(available on main once PR #644 merges).

The infrastructure repository records historical failures of Authentik's RBAC
assignment endpoints in `terraform/authentik/proxmox_ldap.tf`. Validate role
assignment with the deployed version and verify the dedicated token can read
the catalog and create a sandbox invite before enabling the runtime settings.
Do not work around an assignment failure by granting superuser access.

### Verification, rotation, and revocation

Before activation, verify with the dedicated identity that the configured brand
is readable and that one disposable test invitation can be created for an
approved tenant/org. Confirm it is single-use, email-bound, and uses the expected
enrollment flow. Have an Authentik operator remove an unused test invitation;
the service account intentionally has no invitation list/delete permissions.
Local mocked-provider tests and OpenTofu validation do not prove that the live
RBAC assignment endpoints work.

The proposed token follows the existing infrastructure pattern and is
non-expiring. It needs deliberate rotation: replace
`authentik_token.roster_invitations` through OpenTofu, verify the OpenBao value is
updated, rerender the runtime environment, and recreate/restart the backend via
the normal deployment. Never print the key to verify rotation. If a token is
exposed, revoke it promptly in Authentik and reconcile that action through IaC.
Revoking the service token prevents API use but does not revoke already-issued
invitations or existing external accounts.

API references: [brand retrieval](https://api.goauthentik.io/reference/core-brands-retrieve/),
[invitation creation](https://api.goauthentik.io/reference/stages-invitation-invitations-create/),
and [invitation enrollment](https://docs.goauthentik.io/users-sources/user/invitations/).
