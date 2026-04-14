# Architecture Decisions

This file records decisions that were made pragmatically and should be
revisited when time or infrastructure allows.

---

## Slack Bot: Socket Mode

**Decision:** The Slack bot uses Socket Mode (outbound WebSocket) rather than
an HTTP webhook endpoint.

**Why:** At the time of implementation the bot runs inside the internal Docker
stack with no guaranteed public URL. Socket Mode requires no inbound port
exposure and no TLS certificate management for the bot itself.

**Trade-offs:**
- Simpler ops — no reverse proxy / ngrok / tunnel needed.
- Slightly higher latency for slash command responses vs HTTP.
- Requires the `connections:write` scope and a separate App-Level Token
  (`xapp-...`) in addition to the Bot Token.

**Revisit when:** The stack moves to a publicly reachable host (e.g. behind
the university's nginx). At that point switching to HTTP webhooks removes the
App-Level Token dependency and is more standard.

---

## LDAP Extended Attributes for Slack / GitHub IDs

**Decision:** Slack member IDs and GitHub usernames are stored as Univention
Extended Attributes (`settings/extended_attribute`) on user objects in LDAP,
rather than only in the platform's Postgres roster DB.

**Why:** LDAP is the source of truth for identity. Other tooling (Ansible,
Authentik, future integrations) can read these values directly without going
through the roster API.

**Revisit when:** If the Univention schema management becomes a maintenance
burden, consider whether the Postgres copy is sufficient for all consumers.
