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

## Production VM Configuration

### Port Exposure

Only the main backend should be reachable from the internet. The internal services communicate over the Docker network and must **not** be publicly accessible.

| Service | Port | Exposure |
|---|---|---|
| Backend (web UI + API) | 3000 | Public — reverse proxy (nginx/Caddy) |
| GitHub App | 3001 | Internal only — firewall off |
| Slack Bot internal API | 3002 | Internal only — firewall off |
| PostgreSQL | 5432 | Internal only — firewall off |

### Firewall Rules (ufw example)

```bash
# Allow public web traffic
ufw allow 80/tcp
ufw allow 443/tcp

# Block internal service ports from external access
ufw deny 3001/tcp
ufw deny 3002/tcp
ufw deny 5432/tcp
```

If using Docker's default bridge network, also ensure the Docker daemon is not binding internal ports to `0.0.0.0`. In `docker-compose.yml`, internal services should omit the `ports:` key entirely (they communicate over the internal Docker network by service name) or bind explicitly to `127.0.0.1`:

```yaml
ports:
  - "127.0.0.1:3001:3001"   # github-app — localhost only
  - "127.0.0.1:3002:3002"   # slackbot internal API — localhost only
```

### Why the Slack Bot Exposes an HTTP Port

The Slack bot uses Socket Mode (outbound WebSocket to Slack) and does not need a public URL. However, it runs a small internal HTTP server on port **3002** used exclusively for service-to-service communication within the Docker network (e.g. the backend queries it for Slack channel lists and triggers channel invites). This port must never be exposed to the internet.

See `docs/decisions.md` for the full Socket Mode rationale.
