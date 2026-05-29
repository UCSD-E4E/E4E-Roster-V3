# E4E Roster — Developer Docs

## API Reference

Each file covers one route group, documenting every endpoint, all input conditions, and all output cases.

| File | Routes |
|---|---|
| [api/auth.md](api/auth.md) | `/login`, `/auth/login`, `/auth/callback`, `/logout`, `/local-login`, `/local-logout` |
| [api/orgs.md](api/orgs.md) | `/orgs` |
| [api/account.md](api/account.md) | `/orgs/:orgSlug/account` |
| [api/admin-users.md](api/admin-users.md) | `/orgs/:orgSlug/admin/users/**` |
| [api/admin-groups.md](api/admin-groups.md) | `/orgs/:orgSlug/admin/groups/**` |
| [api/admin-group-management.md](api/admin-group-management.md) | `/orgs/:orgSlug/admin/integrations/**` |
| [api/admin-projects.md](api/admin-projects.md) | `/orgs/:orgSlug/admin/projects/**` |
| [api/admin-settings.md](api/admin-settings.md) | `/orgs/:orgSlug/admin/settings/**` |
| [api/pl.md](api/pl.md) | `/orgs/:orgSlug/pl/**` |
| [api/system.md](api/system.md) | `/system/**` |

## Access Control Summary

| Role | Can access |
|---|---|
| Unauthenticated | `/login`, `/local-login`, `/auth/*` |
| Any authenticated | `/orgs`, `/orgs/:orgSlug/dashboard`, `/orgs/:orgSlug/account` |
| `member` | Above only |
| `project_lead` | Above + `/orgs/:orgSlug/admin/users` (read-only) + `/orgs/:orgSlug/pl/**` |
| `org_admin` | Above + all `/orgs/:orgSlug/admin/**` |
| System/local admin | Everything above + `/system/**`; treated as `org_admin` in every org |

## Known Issues

See [todo.md](todo.md) for a prioritized list of bugs, security gaps, and incomplete features found during the API review.
