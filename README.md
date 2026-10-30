# E4E Roster

E4E is quite a large organization, organizing nearly 100 - 200 people each year. Since onboarding is decentralized, its hard to know who is involved with the lab at a given time.  This roster handles this by monitoring user accounts created across E4E's services and linking them together. This allows for a new things such as joint account creation, single sign on, as well as tracking E4E's stats and growth over time. 

## System Overview

## Web UI
- Viewing User data
- Admin: Adding Users
- Admin: Tracking project stats

## Slack Bot
- Allow users to check permissions
- Request permission for applications
- Admin: Review User Requests
- Admin: Create new users
    - New SSO Account
    - New Server Accounts
    - Add github to org
    - Invite user to slack and have them link them with SSO?

## Service Layer
- SSO/LDAP
- Server Management [multi-server support]
    - Kastner-ML
- Github Org [mutli-org support]
- Slack Org [mutli-org support]

## Backend End Tracking
TODO

---

## Deployment

Start with the [minimal roster setup checklist](docs/roster-setup.md).

Use the [full deployment runbook](docs/deployment.md) for the combined backend, per-organization Slack/GitHub setup, weekly onboarding, OpenBao secret delivery, acceptance tests, and rollback. The guide distinguishes working behavior from security and infrastructure changes still needed before server deployment.

For the isolated local demo, see [the integration prototype guide](docs/integrations-prototype.md).

### Production port exposure

| Component | Port | Exposure |
|---|---|---|
| Roster backend, including Slack/GitHub adapters | 3000 | Traefik and optionally host loopback; public access through HTTPS 443 |
| PostgreSQL | 5432 | Internal Docker network only |

Slack uses outbound Socket Mode. GitHub delivers signed webhooks to the existing backend. The historical standalone `slackbot` and `github-app` containers and ports 3001/3002 are retired from the default stack.
