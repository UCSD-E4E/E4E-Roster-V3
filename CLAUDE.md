# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

E4E Roster is a lab roster management platform for UCSD Engineers for Exploration (E4E). It monitors and links user accounts across E4E's services (~100–200 people/year), enabling joint account creation, single sign-on, and organization-wide stats tracking.

## Stack

**Backend:** TypeScript/Node.js (Express) in `backend/src/` — serves server-rendered pages and REST API endpoints. Python scripts are invoked as child processes for integrations with existing Python automation (Ansible, LDAP scripts).

**Frontend:** Server-rendered via Nunjucks (`.njk` templates in `backend/views/`). Static assets (CSS, client JS) live in `frontend/static/`. No SPA, no build pipeline.

**Database:** Postgres (via Docker) for roster metadata, project assignments, and audit logs. LDAP is the source of truth for identity — the DB is supplementary.

## Commands

### Local development (backend)
```bash
cd backend
cp .env.example .env   # fill in OIDC + SESSION_SECRET values
npm install
npm run dev            # tsx watch mode on src/server.ts
```

### Build & lint
```bash
cd backend
npm run build          # tsc → dist/
npm run lint           # eslint src/
```

### Docker — development (hot reload)
```bash
cp .env.example .env
# First run: builds the dev image
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
# Subsequent starts: no rebuild needed, source is mounted
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```
Source files, views, and static assets are mounted as volumes — nodemon/tsx restarts the backend automatically on save. The DB persists across restarts.

### Docker — production
```bash
cp .env.example .env   # fill in all values including DB_PASSWORD
docker compose up --build          # build and start backend + postgres
docker compose up                  # start without rebuilding
docker compose down -v             # stop and remove volumes
```

The `slackbot` service is stubbed out (commented) in [docker-compose.yml](docker-compose.yml) — uncomment when the slackbot directory exists.

## Architecture

```
Browser
  │
  ├── Login ──────────────────────────────────▶  Authentik (OIDC)
  │                                               │
  │                                               ▼
  │                                          Univention LDAP (Authentik syncs this)
  │
  ▼
Node.js / Express
  │
  ├── OIDC middleware (passport-openidconnect) ──▶  Authentik
  │
  ├── Service layer
  │     ├── LDAP write client (ldapts) ──────────▶  Univention LDAP (new user creation only)
  │     ├── Python bridge (child_process) ────────▶  Ansible / server scripts
  │     ├── GitHub API (@octokit/rest) ───────────▶  GitHub Org
  │     └── Slack API (@slack/web-api) ────────────▶  Slack Org
  │
  └── SQLite / Postgres (roster metadata, projects, audit log)
```

The **Python bridge** is in `scripts/` — Node calls Python scripts via `child_process.spawn`, scripts return JSON on stdout. This preserves existing Ansible/provisioning automation without rewriting it.

## Key Routes

| Route | Access | Purpose |
|---|---|---|
| `/login`, `/auth/callback`, `/logout` | All | OIDC flow via Authentik |
| `/dashboard` | Student+ | Own account status and projects |
| `/check` | Student+ | Account status across all systems |
| `/projects`, `/projects/:id` | Student+ | Lab projects and member lists |
| `/admin/users` | Admin | Full roster table with bulk actions |
| `/admin/users/new` | Admin | Multi-step new user provisioning wizard |
| `/admin/users/:id` | Admin | Per-user detail with audit log |

## Roles

Two roles, sourced from Authentik OIDC token claims (backed by LDAP groups):
- **Student** — `/dashboard`, `/check`, read-only `/projects`
- **Admin/Staff** — everything above + all `/admin/*` routes

## Integration Responsibilities

| Concern | Owner |
|---|---|
| Login / session / MFA | Authentik |
| User identity sync | Authentik ↔ Univention LDAP |
| New user creation | Platform writes to Univention LDAP via `ldapts` |
| Role/group claims in JWT | Authentik (reads from LDAP groups) |
| Server account provisioning | Ansible via Python bridge in `scripts/` |
| GitHub / Slack membership | Node service layer |
| Roster metadata & projects | Platform's own DB |

## Design Principles

- **LDAP is the source of truth** for identity. The platform reads from and writes to it — it does not maintain a parallel user store.
- **Idempotent provisioning.** Every "create account" action checks first and skips if it already exists. Enforce this in Python scripts too.
- **Audit everything.** Every provisioning action (who triggered it, what was done, success/fail) is written to the DB.
- **Fail gracefully per-system.** If GitHub is down, LDAP and Slack provisioning should still succeed; log the failure for retry.
- **New user flow execution log** is streamed live using Server-Sent Events (not WebSockets).
