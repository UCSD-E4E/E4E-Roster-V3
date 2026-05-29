# Known Issues & Technical Debt

---

## Medium

### Audit log is sparsely populated
New user creation and project lead actions are not logged. Only `edit_user`, `add_user_to_org`, and `create_ldap_group` are currently written to `audit_log`.

**Fix:** Add `audit_log` inserts to: new user creation (admin + system), PL user edits, PL add-existing, PL new user.

---

### Secondary email and phone not written back to LDAP
`POST /orgs/:orgSlug/account` updates the DB only. A TODO comment in the code notes this is deferred until the LDAP extended-attribute strategy is decided.

---

## Low

### MemoryStore used in production
Sessions are lost on every container restart, forcing all users to re-authenticate. The production stack has a Postgres DB available.

**Fix:** Use `connect-pg-simple` with the existing DB pool.

---

### System group creation doesn't assign group to an org
`POST /system/groups` creates the LDAP group but does not offer a way to assign it to an org's `org_groups` in the same step. System admins need a separate trip to the LDAP Mappings page to make the group visible in an org's Group Management page.

**Fix:** Add an optional org selector to the system `groups/new` form.

---

### Deleting an LDAP mapping does not sync user_orgs
When a system admin removes an LDAP → role mapping, existing `user_orgs` rows are not updated. Users who were granted a role via that mapping keep it until they next log in. This may surprise admins who expect immediate revocation.

**Fix:** Either re-evaluate affected `user_orgs` rows on mapping delete, or document the deferred-revocation behaviour in the UI.
