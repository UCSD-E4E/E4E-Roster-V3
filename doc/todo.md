# Known Issues & Technical Debt

---

## Medium

### Secondary email and phone not written back to LDAP
`POST /orgs/:orgSlug/account` updates the DB only. Deferred until the LDAP extended-attribute strategy is decided.

---

## Low

### MemoryStore used in production
Sessions are lost on every container restart, forcing all users to re-authenticate. The production stack has a Postgres DB available.

**Fix:** Use `connect-pg-simple` with the existing DB pool.

---

### Deleting an LDAP mapping does not sync user_orgs
When a system admin removes an LDAP → role mapping, existing `user_orgs` rows are not updated. Users who were granted a role via that mapping keep it until they next log in.

**Fix:** Either re-evaluate affected `user_orgs` rows on mapping delete, or document the deferred-revocation behaviour in the UI.
