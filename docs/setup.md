# Setup Guide

## Prerequisites

- [Node.js 20+](https://nodejs.org/) (local dev)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (full stack)
- An Authentik instance with an OIDC application configured — see [authentik.md](authentik.md)

---

## Local Development

Runs only the backend. You'll need a reachable Postgres instance (or use Docker just for the DB).

```bash
# 1. Install dependencies
cd backend
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — fill in OIDC_* and SESSION_SECRET at minimum

# 3. Start the dev server (tsx watch mode)
npm run dev
```

Open http://localhost:3000. The server restarts automatically on file changes.

**Run just the database via Docker while developing locally:**
```bash
docker compose up db -d
```
Then add `DATABASE_URL=postgres://e4e:<DB_PASSWORD>@localhost:5432/e4e_roster` to `backend/.env`.

---

## Docker — Development (recommended)

Source files, templates, and static assets are mounted as volumes so the backend hot-reloads on save. Postgres persists across restarts without losing data.

```bash
# 1. Configure environment (first time only)
cp .env.example .env
# Edit .env — set NODE_ENV=dev, fill in OIDC_* and SESSION_SECRET at minimum

# 2. First run — builds the dev image
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

# Subsequent starts — no rebuild needed
docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Rebuild the backend image (only needed after adding/removing npm packages)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up backend --build
```

The backend is available at http://localhost:3000. Edit any `.ts`, `.njk`, or `.css` file and the server restarts automatically inside the container.

---

## Docker — Production

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env — set NODE_ENV=production, fill in all values including DB_PASSWORD

# 2. Build and start
docker compose up --build

# Subsequent starts (no rebuild needed)
docker compose up

# Stop everything and remove volumes (resets the database)
docker compose down -v
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | Yes | Long random string for signing session cookies |
| `OIDC_ISSUER_URL` | Yes | Authentik provider discovery URL (see [authentik.md](authentik.md)) |
| `OIDC_CLIENT_ID` | Yes | Authentik application client ID |
| `OIDC_CLIENT_SECRET` | Yes | Authentik application client secret |
| `OIDC_REDIRECT_URI` | Yes | Must match a redirect URI configured in Authentik |
| `ADMIN_GROUP` | No | Authentik/LDAP group name for admin access (default: `e4e-admin`) |
| `DB_PASSWORD` | Docker only | Postgres password |
| `DB_NAME` | No | Postgres database name (default: `e4e_roster`) |
| `DB_USER` | No | Postgres user (default: `e4e`) |
| `PORT` | No | Port to listen on (default: `3000`) |

Generate a strong `SESSION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Adding the Slack Bot Worker

When the `slackbot/` service is ready, uncomment the `slackbot` block in [docker-compose.yml](../docker-compose.yml). It shares the same `.env` file and depends on the `db` service.
