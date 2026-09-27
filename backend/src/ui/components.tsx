import React from 'react';
import {
  Link,
  Outlet,
  isRouteErrorResponse,
  useActionData,
  useLoaderData,
  useRouteError,
} from 'react-router';
import type { ProjectDetail, ProjectMemberAudit, ProjectSummary, RosterUiContext } from './projects.server';
import type { OrgPerson, OrgPersonEdit, PersonSearchResult } from './people.server';
import type { IntegrationSettings } from './settings.server';
import type { AccountProfile } from './account.server';
import type { DashboardSummary } from './dashboard.server';
import { canAdminOrg } from './access';

export interface ShellData {
  context: RosterUiContext;
}

function FormError(): React.JSX.Element | null {
  const actionData = useActionData() as { formError?: string } | undefined;
  return actionData?.formError ? <p className="form-error" role="alert">{actionData.formError}</p> : null;
}

function SortableHeader({ label, sort, currentSort, direction, wide = false }: { label: string; sort: string; currentSort: string; direction: string; wide?: boolean }): React.JSX.Element {
  const active = currentSort === sort;
  const nextDirection = active && direction === 'asc' ? 'desc' : 'asc';
  return <th className={wide ? 'wide-column' : undefined} aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}><Link className="table-sort" to={`?sort=${sort}&dir=${nextDirection}`}>{label}<span aria-hidden="true">{active ? (direction === 'asc' ? ' ↑' : ' ↓') : ' ↕'}</span></Link></th>;
}

type WorkspacePageHeaderProps = {
  eyebrow: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
};

export function WorkspacePageHeader({
  eyebrow, title, description, actions, children,
}: WorkspacePageHeaderProps): React.JSX.Element {
  return (
    <section className="hero-row project-hero">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="lede">{description}</p>
        {children}
      </div>
      {actions && <div className="project-actions">{actions}</div>}
    </section>
  );
}

export function RosterShell(): React.JSX.Element {
  const { context } = useLoaderData() as ShellData;
  const isAdmin = canAdminOrg(context);

  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${context.org.name} workspace — Roster`}</title>
        <link rel="stylesheet" href="/static/css/react-roster.css" />
        <script src="/static/js/react-roster-theme.js" defer />
      </head>
      <body>
        <div className="workspace-shell" style={{ '--org-color': context.org.themeColor ?? '#3157d5' } as React.CSSProperties}>
          <header className="workspace-header">
            <Link to="/projects" className="brand-mark" aria-label={`${context.org.name} workspace`}>
              <span className="brand-symbol">{context.org.name.slice(0, 1).toUpperCase()}</span>
              <span>
                <strong>{context.org.name}</strong>
                <small>Roster workspace</small>
              </span>
            </Link>
            <nav aria-label="Organization navigation">
              <Link to="/projects">Projects</Link>
              <Link to="/people">People</Link>
              {isAdmin && <Link to="/settings">Settings</Link>}
            </nav>
            <div className="account-cluster">
              <Link to="/account">{context.user.name || context.user.username}</Link>
              <button className="theme-toggle" id="theme-toggle" type="button" aria-label="Switch color theme">Light mode</button>
              <a href="/orgs">Switch org</a>
            </div>
          </header>
          <main className="workspace-main">
            <Outlet />
          </main>
        </div>
      </body>
    </html>
  );
}

export function DashboardPage(): React.JSX.Element {
  const { summary, context } = useLoaderData() as { summary: DashboardSummary; context: RosterUiContext };
  const firstName = (context.user.name || context.user.username).split(/\s+/)[0];
  return <>
    <WorkspacePageHeader eyebrow="Organization workspace" title={`Welcome, ${firstName}`} description={`${context.org.name} keeps directory identity in LDAP and roster access in the organization workspace.`} />
    <section className="dashboard-grid" aria-label="Workspace destinations">
      <Link className="settings-card dashboard-card" to="/account"><p className="eyebrow">Personal</p><h2>My account</h2><p>Review your roster identity, contact details, integrations, and SSH keys.</p><span className="card-action">Open account <span aria-hidden="true">→</span></span></Link>
      {summary.canManageProjects && <Link className="settings-card dashboard-card" to="/projects"><p className="eyebrow">Workspace</p><h2>Projects</h2><p>View eligible projects and manage their member groups and roster where your role permits.</p><span className="card-action">Open projects <span aria-hidden="true">→</span></span></Link>}
      {summary.canManagePeople && <Link className="settings-card dashboard-card" to="/people"><p className="eyebrow">Workspace</p><h2>People</h2><p>Browse the active organization roster and manage people when you are an organization administrator.</p><span className="card-action">Open people <span aria-hidden="true">→</span></span></Link>}
      {summary.canManageSettings && <Link className="settings-card dashboard-card" to="/settings"><p className="eyebrow">Administration</p><h2>Settings</h2><p>Configure this organization’s GitHub and Slack integrations without exposing secrets.</p><span className="card-action">Open settings <span aria-hidden="true">→</span></span></Link>}
    </section>
  </>;
}

export function AccountPage(): React.JSX.Element {
  const { profile, saved, context } = useLoaderData() as { profile: AccountProfile | null; saved: boolean; context: RosterUiContext };
  if (!profile) return <section className="empty-state"><h2>Account not synced</h2><p>Your account has not been synced to the roster yet. Contact an administrator if this is unexpected.</p></section>;
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || context.user.name || context.user.username;
  return <>
    <WorkspacePageHeader eyebrow="Account" title="My account" description="Review your roster identity and keep your long-term contact information current." />
    {saved && <p className="save-notice" role="status">Changes saved.</p>}
    <div className="account-grid">
      <section className="form-card account-summary"><h2>Identity</h2><dl className="account-details">
        <dt>Name</dt><dd>{name}</dd><dt>Username</dt><dd><code>{context.user.username}</code></dd>
        <dt>Institutional email</dt><dd>{profile.email || '—'}</dd><dt>Role</dt><dd>{profile.role || '—'}</dd>
        <dt>Status</dt><dd><span className={`status ${profile.disabled ? 'disabled' : 'active'}`}>{profile.disabled ? 'Disabled' : 'Active'}</span></dd>
        <dt>Expiry</dt><dd>{profile.expiryDate || 'No expiry'}</dd>
      </dl></section>
      <section className="form-card account-summary"><h2>Integrations</h2><dl className="account-details">
        <dt>GitHub</dt><dd>{profile.githubUsername || '—'}</dd><dt>Slack</dt><dd>{profile.slackUsername || '—'}</dd>
      </dl><p className="form-copy">To update GitHub or Slack, contact your project lead or an administrator.</p></section>
      {profile.ldapGroups.length > 0 && <section className="form-card account-summary"><h2>Groups</h2><div className="tag-row">{profile.ldapGroups.map((group) => <span className="tag" key={group}>{group}</span>)}</div></section>}
    </div>
    <section className="form-card account-editor"><form className="workspace-form" method="post"><FormError /><div className="form-section"><h2>Contact information</h2><label>Long-term email <span className="form-optional">personal; persists after graduation</span><input type="email" name="secondaryEmail" defaultValue={profile.secondaryEmail ?? ''} autoComplete="email" /></label><label>Phone number<input type="tel" name="phone" defaultValue={profile.phone ?? ''} autoComplete="tel" /></label></div>{!context.user.isLocalAdmin && <div className="form-section"><h2>SSH keys</h2><label>SSH public keys <span className="form-optional">one ed25519 key per line; replaces existing keys</span><textarea name="sshKeys" rows={5} defaultValue={profile.sshPublicKeys.join('\n')} autoComplete="off" /></label></div>}<div className="form-actions"><button className="button primary" type="submit">Save changes</button></div></form></section>
  </>;
}

export function ProjectsPage(): React.JSX.Element {
  const { projects, context } = useLoaderData() as { projects: ProjectSummary[]; context: RosterUiContext };
  const totalMembers = projects.reduce((sum, project) => sum + project.memberCount, 0);
  const isAdmin = canAdminOrg(context);

  return (
    <>
      <section className="hero-row">
        <div>
          <p className="eyebrow">Organization workspace</p>
          <h1>Projects</h1>
          <p className="lede">Project membership is derived from approved LDAP groups and constrained to the {context.org.name} roster.</p>
        </div>
        <div className="project-list-actions">
          <div className="summary-panel" aria-label="Project summary">
            <span><strong>{projects.length}</strong> projects</span>
            <span><strong>{totalMembers}</strong> project seats</span>
          </div>
          {isAdmin && <Link className="button primary" to="/projects/new">Create project</Link>}
        </div>
      </section>

      {projects.length === 0 ? (
        <section className="empty-state">
          <h2>No accessible projects</h2>
          <p>No projects currently match your organization role and LDAP groups.</p>
        </section>
      ) : (
        <section className="project-grid" aria-label="Projects">
          {projects.map((project) => (
            <Link key={project.id} to={`/projects/${project.id}`} className="project-card">
              <div className="project-card-topline">
                <span className="project-icon">{project.name.slice(0, 2).toUpperCase()}</span>
                <span className="member-count">{project.memberCount} {project.memberCount === 1 ? 'member' : 'members'}</span>
              </div>
              <h2>{project.name}</h2>
              <p>{project.description || 'No description has been added yet.'}</p>
              <div className="tag-row">
                {project.groups.map((group) => <span className="tag" key={group}>{group}</span>)}
              </div>
              <span className="card-action">Open project <span aria-hidden="true">→</span></span>
            </Link>
          ))}
        </section>
      )}
    </>
  );
}

export function ProjectPage(): React.JSX.Element {
  const { project, context } = useLoaderData() as { project: ProjectDetail; context: RosterUiContext };
  const isAdmin = canAdminOrg(context);
  const legacyProjectBase = `/orgs/${context.org.slug}/pl/projects/${project.id}/users`;

  return (
    <>
      <Link to="/projects" className="back-link">← All projects</Link>
      <WorkspacePageHeader
        eyebrow="Project"
        title={project.name}
        description={project.description || 'No description has been added yet.'}
        actions={
          <>
          {isAdmin && <Link className="button secondary" to={`/projects/${project.id}/settings`}>Project settings</Link>}
          <Link className="button secondary" to={`/projects/${project.id}/members/add`}>Add existing person</Link>
          <Link className="button primary" to={`/projects/${project.id}/members/new`}>Create person</Link>
          </>
        }
      >
        <div className="tag-row">
          {project.groups.map((group) => <span className="tag" key={group}>{group}</span>)}
        </div>
      </WorkspacePageHeader>

      <section className="content-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Roster</p>
            <h2>{project.memberCount} {project.memberCount === 1 ? 'member' : 'members'}</h2>
          </div>
          <p>Only organization members matching this project’s groups appear here.</p>
        </div>
        {project.members.length === 0 ? (
          <div className="empty-state compact"><p>No roster members match this project yet.</p></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Person</th><th>Role</th><th>Project groups</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {project.members.map((member) => {
                  const editUrl = isAdmin
                    ? `/orgs/${context.org.slug}/v2/people/${member.username}/edit`
                    : `/orgs/${context.org.slug}/v2/projects/${project.id}/members/${member.username}/edit`;
                  return (
                    <tr key={member.username}>
                      <td><strong><a className="person-link" href={editUrl}>{[member.firstName, member.lastName].filter(Boolean).join(' ') || member.username}</a></strong><small>{member.username} · {member.email}</small></td>
                      <td>{member.role || '—'}</td>
                      <td><div className="tag-row">{member.groups.map((group) => <span className="tag small" key={group}>{group}</span>)}</div></td>
                      <td><span className={member.disabled ? 'status disabled' : 'status active'}>{member.disabled ? 'Disabled' : 'Active'}</span></td>
                      <td>
                        <div className="row-actions">
                          <a className="row-link" href={editUrl}>Manage</a>
                          <Link className="row-link muted-link" to={`/projects/${project.id}/members/${member.username}/audit`}>Log</Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {isAdmin && (
        <details className="admin-editor">
          <summary>Edit project details</summary>
          <form method="post">
            <label>Project name<input name="name" defaultValue={project.name} required /></label>
            <label>Description<textarea name="description" rows={3} defaultValue={project.description ?? ''} /></label>
            <button className="button primary" type="submit">Save project</button>
          </form>
        </details>
      )}
    </>
  );
}

export function ProjectCreatePage(): React.JSX.Element {
  return (
    <>
      <Link to="/projects" className="back-link">← All projects</Link>
      <WorkspacePageHeader eyebrow="Organization workspace" title="Create project" description="Create a project, then assign organization-owned LDAP groups to determine its roster." />
      <section className="form-card">
        <form className="workspace-form" method="post">
          <label>Project name<input name="name" required autoFocus /></label>
          <label>Description <span className="form-optional">optional</span><textarea name="description" rows={4} /></label>
          <div className="form-actions"><button className="button primary" type="submit">Create project</button><Link className="button secondary" to="/projects">Cancel</Link></div>
        </form>
      </section>
    </>
  );
}

export function ProjectSettingsPage(): React.JSX.Element {
  const { settings } = useLoaderData() as { settings: import('./projects.server').ProjectSettings; context: RosterUiContext };
  const { project, orgGroups } = settings;
  const availableGroups = orgGroups.filter((group) => !project.groups.includes(group));

  return (
    <>
      <Link to={`/projects/${project.id}`} className="back-link">← {project.name}</Link>
      <WorkspacePageHeader eyebrow="Project settings" title={project.name} description="Project groups control which organization members appear in this project roster." />
      <div className="settings-grid project-settings-grid">
        <section className="form-card">
          <h2>Project details</h2>
          <form className="workspace-form" method="post">
            <input type="hidden" name="intent" value="update-project" />
            <label>Project name<input name="name" defaultValue={project.name} required /></label>
            <label>Description <span className="form-optional">optional</span><textarea name="description" rows={4} defaultValue={project.description ?? ''} /></label>
            <button className="button primary" type="submit">Save details</button>
          </form>
        </section>
        <section className="form-card">
          <h2>Project groups</h2>
          <p className="form-copy">Only LDAP groups already mapped to this organization can be added.</p>
          {project.groups.length === 0 ? <p className="empty-inline">No groups are assigned yet.</p> : <ul className="group-list">{project.groups.map((group) => <li key={group}><span className="tag">{group}</span><form method="post"><input type="hidden" name="intent" value="remove-group" /><input type="hidden" name="ldapGroup" value={group} /><button className="row-link danger-link" type="submit">Remove</button></form></li>)}</ul>}
          {availableGroups.length > 0 ? <form className="add-group-form" method="post"><input type="hidden" name="intent" value="add-group" /><label htmlFor="new-project-group">Add an organization group</label><div><select id="new-project-group" name="ldapGroup" defaultValue={availableGroups[0]}>{availableGroups.map((group) => <option value={group} key={group}>{group}</option>)}</select><button className="button primary" type="submit">Add group</button></div></form> : <p className="empty-inline">All organization groups are already assigned.</p>}
        </section>
      </div>
    </>
  );
}

export function ProjectAddPersonPage(): React.JSX.Element {
  const { project, query, results, context } = useLoaderData() as {
    project: ProjectDetail;
    query: string;
    results: PersonSearchResult[];
    context: RosterUiContext;
  };

  return (
    <>
      <Link to={`/projects/${project.id}`} className="back-link">← {project.name}</Link>
      <WorkspacePageHeader eyebrow="Project membership" title="Add existing person" description={`Search the roster directory and assign one or more of ${project.name}’s groups.`} />
      <section className="search-card">
        <form className="person-search" method="get">
          <label htmlFor="project-person-search">Find a person</label>
          <div><input id="project-person-search" name="q" type="search" defaultValue={query} placeholder="Username, name, or email" autoFocus /><button className="button primary" type="submit">Search</button></div>
        </form>
      </section>
      <FormError />
      {query && <section className="content-card search-results">
        <div className="section-heading"><div><p className="eyebrow">Search results</p><h2>{results.length} {results.length === 1 ? 'person' : 'people'}</h2></div><p>{results.length === 20 ? 'Showing the first 20 ranked matches.' : `Matches for “${query}”.`}</p></div>
        {results.length === 0 ? <div className="empty-state compact"><p>No directory matches. Try a shorter name, username, or email fragment.</p></div> : <div className="search-result-list">{results.map((person) => {
          const displayName = [person.firstName, person.lastName].filter(Boolean).join(' ') || person.username;
          if (person.isDirectoryAdmin) return <article className="search-result" key={person.username}><div><strong>{displayName}</strong><small>{person.username} · {person.email}</small></div><span className="membership-status">Administrators cannot be managed from a project.</span></article>;
          return <article className="search-result project-person-result" key={person.username}>
            <div><strong>{displayName}</strong><small>{person.username} · {person.email}</small></div>
            <form className="project-member-form" method="post">
              <input type="hidden" name="username" value={person.username} />
              <fieldset><legend>{project.name} groups</legend><div className="check-grid">{project.groups.map((group) => <label key={group}><input type="checkbox" name="groups" value={group} defaultChecked={person.ldapGroups.includes(group)} /> {group}</label>)}</div></fieldset>
              <button className="button primary" type="submit">Add to project</button>
            </form>
          </article>;
        })}</div>}
      </section>}
    </>
  );
}

type PersonCreateFormProps = {
  action?: string;
  cancelTo: string;
  groups: string[];
  mode: 'organization' | 'project';
  projectName?: string;
};

function PersonCreateForm({ action, cancelTo, groups, mode, projectName }: PersonCreateFormProps): React.JSX.Element {
  const organizationMode = mode === 'organization';
  return <section className="form-card person-form-card"><form className="workspace-form" method="post" action={action}>
    <div className="form-section"><h2>Basic information</h2><div className="form-two-column"><label>First name<input name="firstName" required autoComplete="off" /></label><label>Last name<input name="lastName" required autoComplete="off" /></label></div><label>Institutional email<input name="email" type="email" required autoComplete="off" /><span className="form-hint">Used to generate the username.</span></label><label>Long-term email <span className="form-optional">optional</span><input name="secondaryEmail" type="email" autoComplete="off" placeholder="personal@example.com" /></label><label>Phone <span className="form-optional">optional</span><input name="phone" type="tel" autoComplete="off" placeholder="+1 555 000 0000" /></label></div>
    {organizationMode ? <div className="form-section"><h2>Account</h2><div className="form-two-column"><label>Role<select name="role" required defaultValue=""><option value="" disabled>Choose a role</option><option value="student">Student</option><option value="researcher">Researcher</option><option value="staff">Staff</option><option value="alumni">Alumni</option></select></label><label>Expiry date<input name="expiryDate" type="date" required /></label></div></div> : <div className="form-section"><h2>Account</h2><p className="form-copy">Project-created accounts are students and expire after 90 days. An organization admin can change either later.</p></div>}
    <div className="form-section"><h2>Access</h2><p className="form-copy">{organizationMode ? 'Choose organization LDAP groups.' : `Choose one or more groups belonging to ${projectName}.`}</p>{groups.length ? <div className="check-grid form-check-grid">{groups.map((group) => <label key={group}><input type="checkbox" name="ldapGroups" value={group} defaultChecked={!organizationMode} /> {group}</label>)}</div> : <p className="empty-inline">No eligible LDAP groups are configured.</p>}</div>
    {organizationMode && <label>SSH public keys <span className="form-optional">optional, one per line</span><textarea name="sshKeys" rows={4} autoComplete="off" placeholder="ssh-ed25519 AAAA..." /></label>}
    <div className="form-section"><h2>Integrations <span className="form-optional">optional</span></h2><div className="form-two-column"><label>GitHub username<input name="githubUsername" autoComplete="off" /></label><label>Slack username<input name="slackUsername" autoComplete="off" /></label></div></div>
    <div className="form-actions"><button className="button primary" type="submit">{organizationMode ? 'Create person' : 'Create project member'}</button><Link className="button secondary" to={cancelTo}>Cancel</Link></div>
  </form></section>;
}

export function PeopleCreatePage(): React.JSX.Element {
  const { groups } = useLoaderData() as { groups: string[]; context: RosterUiContext };
  return <><Link to="/people" className="back-link">← People</Link><WorkspacePageHeader eyebrow="Organization workspace" title="Create person" description="Create a directory account and add it to this organization’s roster immediately." /><PersonCreateForm cancelTo="/people" groups={groups} mode="organization" /></>;
}

export function PeopleEditPage(): React.JSX.Element {
  const { person, groups } = useLoaderData() as { person: OrgPersonEdit; groups: string[]; context: RosterUiContext };
  const displayName = [person.firstName, person.lastName].filter(Boolean).join(' ') || person.username;
  return <>
    <Link to="/people" className="back-link">← People</Link>
    <WorkspacePageHeader eyebrow="Organization workspace" title={displayName} description={`Edit ${person.username}'s directory profile and organization-owned group assignments.`} />
    <section className="form-card person-form-card"><form className="workspace-form" method="post"><FormError />
      <div className="form-section"><h2>Basic information</h2><div className="form-two-column"><label>First name<input name="firstName" defaultValue={person.firstName ?? ''} required autoComplete="off" /></label><label>Last name<input name="lastName" defaultValue={person.lastName ?? ''} required autoComplete="off" /></label></div><label>Institutional email<input name="email" type="email" defaultValue={person.email ?? ''} required autoComplete="off" /><span className="form-hint">Changes the LDAP email but not the username.</span></label><label>Long-term email <span className="form-optional">optional</span><input name="secondaryEmail" type="email" defaultValue={person.secondaryEmail ?? ''} autoComplete="off" /></label><label>Phone <span className="form-optional">optional</span><input name="phone" type="tel" defaultValue={person.phone ?? ''} autoComplete="off" /></label></div>
      <div className="form-section"><h2>Account</h2><div className="form-two-column"><label>Role<select name="role" defaultValue={person.role ?? ''}><option value="">Unset</option><option value="student">Student</option><option value="researcher">Researcher</option><option value="staff">Staff</option><option value="alumni">Alumni</option></select></label><label>Expiry date <span className="form-optional">optional</span><input name="expiryDate" type="date" defaultValue={person.expiryDate ?? ''} /></label></div></div>
      <div className="form-section"><h2>Organization groups</h2><p className="form-copy">Groups outside this organization are preserved and cannot be changed here.</p>{groups.length ? <div className="check-grid form-check-grid">{groups.map((group) => <label key={group}><input type="checkbox" name="groups" value={group} defaultChecked={person.ldapGroups.includes(group)} /> {group}</label>)}</div> : <p className="empty-inline">No organization LDAP groups are configured.</p>}</div>
      <label>SSH public keys <span className="form-optional">one per line; replaces existing keys</span><textarea name="sshKeys" rows={4} autoComplete="off" defaultValue={person.sshPublicKeys.join('\n')} placeholder="ssh-ed25519 AAAA..." /></label>
      <div className="form-section"><h2>Integrations <span className="form-optional">optional</span></h2><div className="form-two-column"><label>GitHub username<input name="githubUsername" defaultValue={person.githubUsername ?? ''} autoComplete="off" /></label><label>Slack username<input name="slackUsername" defaultValue={person.slackUsername ?? ''} autoComplete="off" /></label></div></div>
      <div className="form-actions"><button className="button primary" type="submit">Save changes</button><Link className="button secondary" to="/people">Cancel</Link></div>
    </form></section>
  </>;
}

export function ProjectCreatePersonPage(): React.JSX.Element {
  const { project } = useLoaderData() as { project: ProjectDetail; context: RosterUiContext };
  return <><Link to={`/projects/${project.id}`} className="back-link">← {project.name}</Link><WorkspacePageHeader eyebrow="Project membership" title="Create person" description={`Create a person and assign them directly to ${project.name}.`} /><PersonCreateForm cancelTo={`/projects/${project.id}`} groups={project.groups} mode="project" projectName={project.name} /></>;
}

export function PersonProvisionResultPage(): React.JSX.Element {
  const { result, returnTo } = useLoaderData() as { result: import('./roster-provision.server').RosterProvisionResult; returnTo: string; context: RosterUiContext };
  const created = result.ldapStatus === 'success' || result.ldapStatus === 'already_exists';
  return <section className="content-card provision-result"><p className="eyebrow">Person provisioning</p><h1>{created ? 'Person ready' : 'Person was not created'}</h1><p className="lede">{result.ldapMessage}</p><dl className="account-details"><dt>Username</dt><dd><code>{result.username}</code></dd><dt>Email</dt><dd>{result.email}</dd></dl>{result.tempPassword && <section className="temporary-password"><h2>Temporary password</h2><p>Copy this now. It is displayed once and is not included in a URL or audit record.</p><code>{result.tempPassword}</code></section>}{result.sshResults.length > 0 && <section><h2>SSH keys</h2><ul>{result.sshResults.map((entry, index) => <li key={index}><code>{entry.preview}</code> — {entry.message}</li>)}</ul></section>}<div className="form-actions"><Link className="button primary" to={returnTo}>Return to roster</Link>{created && <Link className="button secondary" to={returnTo.includes('/projects/') ? `${returnTo}/members/${result.username}/edit` : `/people/${result.username}/edit`}>Manage person</Link>}</div></section>;
}

export function ProjectMemberEditPage(): React.JSX.Element {
  const { project, member } = useLoaderData() as { project: ProjectDetail; member: import('./projects.server').ProjectMemberEdit; context: RosterUiContext };
  const displayName = [member.firstName, member.lastName].filter(Boolean).join(' ') || member.username;
  return <><Link to={`/projects/${project.id}`} className="back-link">← {project.name}</Link><WorkspacePageHeader eyebrow="Project membership" title={displayName} description={`Manage ${member.username}'s ${project.name} membership.`} />
    <section className="form-card person-form-card"><form className="workspace-form" method="post"><FormError />
      <div className="form-section"><h2>Contact and account</h2><label>Long-term email <span className="form-optional">optional</span><input name="secondaryEmail" type="email" defaultValue={member.secondaryEmail ?? ''} /></label><label>Phone <span className="form-optional">optional</span><input name="phone" type="tel" defaultValue={member.phone ?? ''} /></label><div className="form-two-column"><label>GitHub username<input name="githubUsername" defaultValue={member.githubUsername ?? ''} /></label><label>Slack username<input name="slackUsername" defaultValue={member.slackUsername ?? ''} /></label></div><label>Account status<select name="disabled" defaultValue={member.disabled ? 'true' : 'false'}><option value="false">Active</option><option value="true">Disabled</option></select></label></div>
      <div className="form-section"><h2>Project groups</h2><p className="form-copy">Other group memberships are preserved.</p><div className="check-grid form-check-grid">{project.groups.map((group) => <label key={group}><input type="checkbox" name="groups" value={group} defaultChecked={member.ldapGroups.includes(group)} /> {group}</label>)}</div></div>
      <label>SSH public keys <span className="form-optional">one per line; replaces existing keys</span><textarea name="sshKeys" rows={4} defaultValue={member.sshPublicKeys.join('\n')} /></label>
      <div className="form-actions"><button className="button primary" type="submit">Save changes</button><Link className="button secondary" to={`/projects/${project.id}`}>Cancel</Link></div>
    </form></section></>;
}

export function PeoplePage(): React.JSX.Element {
  const { people, sync, sort, direction, context } = useLoaderData() as { people: OrgPerson[]; sync: string | null; sort: string; direction: string; context: RosterUiContext };
  const isAdmin = canAdminOrg(context);

  return (
    <>
      <WorkspacePageHeader
        eyebrow="Organization workspace"
        title="People"
        description={`People who belong to the ${context.org.name} roster. Their groups determine project membership.`}
        actions={isAdmin ? <>
          <form method="post"><input type="hidden" name="intent" value="sync" /><button className="button secondary" type="submit">Sync directory</button></form>
          <Link className="button secondary" to="/people/add">Add existing person</Link>
          <Link className="button primary" to="/people/new">Create person</Link>
        </> : undefined}
      />
      {sync && <p className="save-notice" role="status">Directory sync complete — {sync.split(',')[0]} updated, {sync.split(',')[1]} removed, {sync.split(',')[2]} errors.</p>}
      <section className="content-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Roster</p>
            <h2>{people.length} {people.length === 1 ? 'person' : 'people'}</h2>
          </div>
          <p>Only people with an organization membership appear here.</p>
        </div>
        {people.length === 0 ? <div className="empty-state compact"><p>No people belong to this organization yet.</p></div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><SortableHeader label="Person" sort="name" currentSort={sort} direction={direction} /><SortableHeader label="Organization role" sort="role" currentSort={sort} direction={direction} /><SortableHeader label="Groups" sort="groups" currentSort={sort} direction={direction} /><SortableHeader label="Expiry" sort="expiry" currentSort={sort} direction={direction} wide /><SortableHeader label="Status" sort="status" currentSort={sort} direction={direction} /><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{people.map((person) => (
                <tr key={person.username}>
                  <td><strong>{isAdmin ? <Link className="person-link" to={`/people/${person.username}/edit`}>{[person.firstName, person.lastName].filter(Boolean).join(' ') || person.username}</Link> : ([person.firstName, person.lastName].filter(Boolean).join(' ') || person.username)}</strong><small>{person.username} · {person.email}</small></td>
                  <td>{person.orgRole.replace('_', ' ')}</td>
                  <td><div className="tag-row table-tags">{person.groups.length ? person.groups.map((group) => <span className="tag small" key={group}>{group}</span>) : '—'}</div></td>
                  <td className="wide-column">{person.expiryDate ?? 'No expiry'}</td>
                  <td><span className={person.disabled ? 'status disabled' : 'status active'}>{person.disabled ? 'Disabled' : 'Active'}</span></td>
                  <td>{isAdmin && <Link className="row-link" to={`/people/${person.username}/edit`}>Manage</Link>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

export function SettingsPage(): React.JSX.Element {
  const { settings } = useLoaderData() as { settings: IntegrationSettings; context: RosterUiContext };

  return (
    <>
      <WorkspacePageHeader
        eyebrow="Organization workspace"
        title="Settings"
        description="Integration configuration belongs to this organization and is available only to organization administrators. Secrets are write-only."
      />
      <p className="form-copy"><Link className="row-link" to="/settings/groups">Manage group roles and integration mappings</Link></p>
      <FormError />
      <section className="settings-grid" aria-label="Integration settings">
        <section className="form-card"><form className="workspace-form" method="post"><input type="hidden" name="intent" value="github" /><p className="eyebrow">Integration</p><h2>GitHub</h2><label><span><input type="checkbox" name="enabled" value="true" defaultChecked={settings.github.enabled} /> Enable GitHub integration</span></label><label>App ID<input name="appId" defaultValue={settings.github.appId} /></label><label>Installation ID<input name="installationId" defaultValue={settings.github.installationId} /></label><label>Organization<input name="org" defaultValue={settings.github.org} /></label><label>Private key <span className="form-optional">{settings.github.hasPrivateKey ? 'configured; leave blank to retain' : 'optional until enabled'}</span><textarea name="privateKey" rows={4} autoComplete="off" /></label><button className="button primary" type="submit">Save GitHub settings</button></form></section>
        <section className="form-card"><form className="workspace-form" method="post"><input type="hidden" name="intent" value="slack" /><p className="eyebrow">Integration</p><h2>Slack</h2><label><span><input type="checkbox" name="enabled" value="true" defaultChecked={settings.slack.enabled} /> Enable Slack integration</span></label><label>Workspace ID<input name="teamId" defaultValue={settings.slack.teamId} /></label><label>Bot token <span className="form-optional">{settings.slack.hasBotToken ? 'configured; leave blank to retain' : 'optional until enabled'}</span><input name="botToken" type="password" autoComplete="new-password" /></label><button className="button primary" type="submit">Save Slack settings</button></form></section>
      </section>
    </>
  );
}

export function GroupMappingsPage(): React.JSX.Element {
  const { mappings } = useLoaderData() as { mappings: import('./settings.server').OrgGroupMappingSettings; context: RosterUiContext };
  const selected = mappings.selectedGroup;
  return <><Link to="/settings" className="back-link">← Settings</Link><WorkspacePageHeader eyebrow="Organization workspace" title="Group mappings" description="Set organization roles and map roster groups to GitHub teams or Slack channels." /><FormError /><div className="settings-grid"><section className="content-card"><form className="person-search" method="get"><label htmlFor="mapping-group">Choose a group</label><div><select id="mapping-group" name="group" defaultValue={selected ?? ''}><option value="">Select a group</option>{mappings.groups.map((group) => <option key={group} value={group}>{group}</option>)}</select><button className="button secondary" type="submit">Open</button></div></form></section><section className="form-card"><form className="workspace-form" method="post"><input type="hidden" name="intent" value="create" /><h2>Create organization group</h2><label>Group name<input name="groupName" required /></label><label>Project <span className="form-optional">optional</span><select name="projectId" defaultValue=""><option value="">Organization-only group</option>{mappings.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button className="button secondary" type="submit">Create group</button></form></section></div>{selected ? <div className="settings-grid"><section className="form-card"><form className="workspace-form" method="post"><input type="hidden" name="intent" value="role" /><input type="hidden" name="ldapGroup" value={selected} /><h2>{selected} role</h2><p className="form-copy">Assigning a role grants it to matching directory users after membership sync.</p><label>Organization role<select name="role" defaultValue={mappings.role ?? ''}><option value="">No role</option><option value="member">Member</option><option value="project_lead">Project lead</option><option value="org_admin">Organization admin</option><option value="utility">Utility (no membership)</option></select></label><button className="button primary" type="submit">Save role</button></form></section><section className="form-card"><form className="workspace-form" method="post"><input type="hidden" name="intent" value="add" /><input type="hidden" name="ldapGroup" value={selected} /><h2>Add integration mapping</h2><label>Service<select name="service" defaultValue="github"><option value="github">GitHub team</option><option value="slack">Slack channel</option></select></label><label>Target ID<input name="targetId" required placeholder="team slug or channel ID" /></label><label>Target name<input name="targetName" required placeholder="Visible name" /></label><button className="button primary" type="submit">Add mapping</button></form></section></div> : null}{selected ? <section className="content-card"><div className="section-heading"><div><p className="eyebrow">Integration targets</p><h2>{mappings.mappings.length} {mappings.mappings.length === 1 ? 'mapping' : 'mappings'}</h2></div><form method="post"><input type="hidden" name="intent" value="sync" /><input type="hidden" name="ldapGroup" value={selected} /><button className="button secondary" type="submit">Sync integrations</button></form></div>{mappings.mappings.length === 0 ? <p className="empty-inline">No integration targets are mapped to this group.</p> : <div className="table-wrap"><table><thead><tr><th>Service</th><th>Target</th><th></th></tr></thead><tbody>{mappings.mappings.map((mapping) => <tr key={mapping.id}><td>{mapping.service}</td><td><code>{mapping.targetId}</code> {mapping.targetName}</td><td><form method="post"><input type="hidden" name="intent" value="delete" /><input type="hidden" name="ldapGroup" value={selected} /><input type="hidden" name="id" value={mapping.id} /><button className="danger-link" type="submit">Remove</button></form></td></tr>)}</tbody></table></div>}</section> : <section className="empty-state compact"><p>Select an organization group to manage its role and integration targets.</p></section>}</>;
}

export function PeopleAddPage(): React.JSX.Element {
  const { query, results, context } = useLoaderData() as {
    query: string;
    results: PersonSearchResult[];
    context: RosterUiContext;
  };

  return (
    <>
      <Link to="/people" className="back-link">← People</Link>
      <WorkspacePageHeader
        eyebrow="Organization workspace"
        title="Add existing person"
        description="Search the roster directory by username, name, or email. Results show whether the person already belongs to this organization."
      />
      <section className="search-card">
        <form className="person-search" method="get">
          <label htmlFor="person-search">Find a person</label>
          <div>
            <input id="person-search" name="q" type="search" defaultValue={query} placeholder="Username, name, or email" autoFocus />
            <button className="button primary" type="submit">Search</button>
          </div>
        </form>
      </section>
      <FormError />
      {query && (
        <section className="content-card search-results">
          <div className="section-heading">
            <div><p className="eyebrow">Search results</p><h2>{results.length} {results.length === 1 ? 'person' : 'people'}</h2></div>
            <p>{results.length === 20 ? 'Showing the first 20 ranked matches.' : `Matches for “${query}”.`}</p>
          </div>
          {results.length === 0 ? <div className="empty-state compact"><p>No directory matches. Try a shorter name, username, or email fragment.</p></div> : (
            <div className="search-result-list">
              {results.map((person) => {
                const displayName = [person.firstName, person.lastName].filter(Boolean).join(' ') || person.username;
                const alreadyMember = Boolean(person.orgRole);
                return <article className="search-result" key={person.username}>
                  <div><strong>{displayName}</strong><small>{person.username} · {person.email}</small></div>
                  <div className="search-result-actions">
                    <span className={alreadyMember ? 'status active' : 'membership-status'}>{alreadyMember ? `Current role: ${person.orgRole?.replace('_', ' ')}` : 'Not in this organization'}</span>
                    <form method="post">
                      <input type="hidden" name="username" value={person.username} />
                      <label className="sr-only" htmlFor={`role-${person.username}`}>Organization role for {displayName}</label>
                      <select id={`role-${person.username}`} name="role" defaultValue={person.orgRole ?? 'member'}>
                        <option value="member">Member</option><option value="project_lead">Project lead</option><option value="org_admin">Organization admin</option>
                      </select>
                      <button className="button primary" type="submit">{alreadyMember ? 'Update access' : 'Add to organization'}</button>
                    </form>
                  </div>
                </article>;
              })}
            </div>
          )}
        </section>
      )}
    </>
  );
}

export function ProjectAuditPage(): React.JSX.Element {
  const { audit } = useLoaderData() as { audit: ProjectMemberAudit; context: RosterUiContext };
  const personName = [audit.member.firstName, audit.member.lastName].filter(Boolean).join(' ') || audit.member.username;

  return (
    <>
      <Link to={`/projects/${audit.project.id}`} className="back-link">← {audit.project.name}</Link>
      <WorkspacePageHeader
        eyebrow="Project activity"
        title={personName}
        description={`Audit history for ${audit.member.username} within ${audit.project.name}.`}
      >
        <div className="tag-row">{audit.member.groups.map((group) => <span className="tag" key={group}>{group}</span>)}</div>
      </WorkspacePageHeader>
      <section className="content-card">
        <div className="section-heading">
          <div><p className="eyebrow">Activity</p><h2>{audit.entries.length} {audit.entries.length === 1 ? 'entry' : 'entries'}</h2></div>
          <p>Entries are limited to this organization and newest first.</p>
        </div>
        {audit.entries.length === 0 ? <div className="empty-state compact"><p>No audit entries for this person in this organization.</p></div> : (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead>
            <tbody>{audit.entries.map((entry, index) => <tr key={`${entry.createdAt}-${index}`}>
              <td>{new Date(entry.createdAt).toLocaleString()}</td><td>{entry.actor}</td><td>{entry.action.replace(/_/g, ' ')}</td><td className="audit-details">{entry.details || '—'}</td>
            </tr>)}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}

export function RouteErrorPage(): React.JSX.Element {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = isRouteErrorResponse(error)
    ? (typeof error.data === 'string' ? error.data : error.statusText)
    : 'The roster could not load this page.';

  return (
    <main className="standalone-error">
      <p className="eyebrow">Error {status}</p>
      <h1>{message}</h1>
      <a href="/orgs">Return to organizations</a>
    </main>
  );
}
