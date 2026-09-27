import React from 'react';

export interface SelectableOrganization {
  orgId: number;
  orgSlug: string;
  orgName: string;
  role: string;
  themeColor: string | null;
}

export function OrganizationSelector({
  organizations, isSystemAdmin,
}: { organizations: SelectableOrganization[]; isSystemAdmin: boolean }): React.JSX.Element {
  return <html lang="en" data-theme="dark"><head>
    <meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Select organization — Roster</title><link rel="stylesheet" href="/static/css/react-roster.css" />
    <script src="/static/js/react-roster-theme.js" defer />
  </head><body><main className="selector-page"><section className="selector-card">
    <div className="selector-header"><p className="eyebrow">Roster</p><h1>Select organization</h1><p className="lede">Choose the workspace you want to manage.</p></div>
    <div className="selector-list">
      {organizations.map((organization) => <a className="selector-option" key={organization.orgId} href={`/orgs/${organization.orgSlug}/v2/dashboard`} style={{ '--org-color': organization.themeColor ?? '#3157d5' } as React.CSSProperties}>
        <span><strong>{organization.orgName}</strong><small>{organization.role.replace('_', ' ')}</small></span><span aria-hidden="true">→</span>
      </a>)}
      {organizations.length === 0 && <p className="form-copy">You do not currently belong to an organization.</p>}
    </div>
    <div className="selector-actions">{isSystemAdmin && <a className="button secondary" href="/system">System administration</a>}<button className="theme-toggle selector-theme-toggle" id="theme-toggle" type="button">Light mode</button><form method="post" action="/logout"><button className="selector-signout" type="submit">Sign out</button></form></div>
  </section></main></body></html>;
}
