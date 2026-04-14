# TODO

## New User Testing Checklist

When adding a new user, verify the following three integrations work end-to-end:

- [ ] **SSO account created in Univention** — user appears in LDAP and can log in via Authentik
- [ ] **GitHub org invite sent** — user receives an invitation to UCSD-E4E on GitHub after their `github_username` is saved to the roster
- [ ] **Slack DM received** — if the user is already in the E4E Slack workspace, they receive a DM asking them to register their SSO account (or if already registered, the sync links their Slack ID)
