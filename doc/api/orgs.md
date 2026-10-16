# Orgs Selector

**Route prefix:** `/orgs`
**Auth:** `requireAuth`

---

## GET /orgs

Renders the org selector page. Fetches all orgs from the DB to enrich with `theme_color`.

| User type | Orgs shown |
|---|---|
| System admin / local admin | All orgs in the DB with role `org_admin` |
| Regular user | Only orgs in `user.orgs` (LDAP-derived + manually assigned) |

Each org entry includes `orgId`, `orgSlug`, `orgName`, `role`, `theme_color`.

| Condition | Output |
|---|---|
| DB error | `500` via error handler |
| Success | Renders `orgs.njk` with colored org buttons |
