import React from 'react';
import { Link, useLoaderData } from 'react-router';
import { FormError, WorkspacePageHeader } from './components';
import { IntegrationWorkbenchPanel, IntegrationResult } from './integration-workbench';
import type { IntegrationSettings, OrganizationGroups } from './settings.server';

export type SettingsTab = 'groups' | 'integrations' | 'debug';

function Popup({ id, title, children }: { id: string; title: string; children: React.ReactNode }): React.JSX.Element {
  return <section popover="auto" id={id} className="settings-popup" aria-label={title}>
    <header><h2>{title}</h2><button type="button" className="popup-close" popoverTarget={id} popoverTargetAction="hide" aria-label={`Close ${title}`}>×</button></header>
    {children}
  </section>;
}

function GroupFields({ intent, group }: { intent: string; group?: string }): React.JSX.Element {
  return <><input type="hidden" name="intent" value={intent} />{group && <input type="hidden" name="ldapGroup" value={group} />}</>;
}

function GroupsPanel({ directory }: { directory: OrganizationGroups }): React.JSX.Element {
  return <>
    <div className="settings-toolbar"><div><h2>Organization groups</h2><p>Set member types, project assignments, and service access in one place.</p></div><div className="row-actions">
      <form method="post"><GroupFields intent="sync" /><button className="button secondary">Sync integrations</button></form>
      <button className="button primary" type="button" popoverTarget="create-group">Create group</button>
    </div></div>
    <Popup id="create-group" title="Create organization group"><form className="workspace-form" method="post"><GroupFields intent="create" />
      <label>Group name<input name="groupName" required /></label><label>Initial project <span className="form-optional">optional</span><select name="projectId" defaultValue=""><option value="">Organization only</option>{directory.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <button className="button primary">Create group</button></form></Popup>
    <section className="content-card group-directory"><div className="table-wrap"><table><thead><tr><th>Group</th><th>Member type</th><th>Project assignments</th><th>Integrations</th></tr></thead><tbody>
      {directory.groups.map((g, index) => <tr key={g.name}><td><strong>{g.name}</strong></td>
        <td><form method="post" className="group-role-form"><GroupFields intent="role" group={g.name} /><label className="sr-only" htmlFor={`group-role-${index}`}>Member type for {g.name}</label><select id={`group-role-${index}`} name="role" defaultValue={g.role ?? ''}><option value="">No role</option><option value="member">Member</option><option value="project_lead">Project lead</option><option value="org_admin">Organization admin</option><option value="utility">Utility (no membership)</option></select><button className="row-link action-link">Save</button></form></td>
        <td><button className="group-cell-button" type="button" popoverTarget={`projects-${index}`} aria-label={`Edit projects for ${g.name}`}><span className="tag-row">{g.projects.length ? g.projects.map(p => <span className="tag small" key={p.id}>{p.name}</span>) : <span className="cell-placeholder">Assign projects</span>}</span><span className="cell-edit">Edit ↗</span></button>
          <Popup id={`projects-${index}`} title={`${g.name} projects`}><form className="workspace-form" method="post"><GroupFields intent="projects" group={g.name} /><p className="form-copy">Members of this group appear in each selected project.</p><fieldset className="project-choices"><legend>Project assignments</legend>{directory.projects.map(p => <label key={p.id}><input type="checkbox" name="projectIds" value={p.id} defaultChecked={g.projects.some(assigned => assigned.id === p.id)} />{p.name}</label>)}{!directory.projects.length && <p>No projects have been created yet.</p>}</fieldset><button className="button primary">Save assignments</button></form></Popup>
        </td>
        <td><button className="group-cell-button" type="button" popoverTarget={`integrations-${index}`} aria-label={`Edit integrations for ${g.name}`}><span className="tag-row">{g.mappings.length ? g.mappings.map(m => <span className="tag small" key={m.id}>{m.service === 'slack' ? 'Slack' : m.service === 'github' ? 'GitHub' : m.service} · {m.target_name}</span>) : <span className="cell-placeholder">Add integration</span>}</span><span className="cell-edit">Edit ↗</span></button>
          <Popup id={`integrations-${index}`} title={`${g.name} integrations`}>
            {g.mappings.length > 0 && <ul className="integration-targets">{g.mappings.map(m => <li key={m.id}><div><strong>{m.target_name}</strong><small>{m.service} · {m.target_id}</small></div><form method="post"><GroupFields intent="delete" group={g.name} /><input type="hidden" name="id" value={m.id} /><button className="danger-link" aria-label={`Remove ${m.target_name}`}>Remove</button></form></li>)}</ul>}
            <form className="workspace-form" method="post"><GroupFields intent="add" group={g.name} /><h3>Add integration target</h3><label>Integration<select name="service" defaultValue="slack"><option value="slack">Slack channel</option><option value="github">GitHub team</option></select></label><label>Target ID<input name="targetId" required placeholder="Channel ID or team slug" /></label><label>Display name<input name="targetName" required /></label><button className="button primary">Add integration</button></form>
          </Popup>
        </td>
      </tr>)}
    </tbody></table></div>{!directory.groups.length && <div className="empty-state compact"><p>No groups yet. Create a group to start assigning access.</p></div>}</section>
    <p className="settings-footnote">Member type changes take effect after directory membership sync. Integration sync applies the access granted by these mappings.</p>
  </>;
}

export function SettingsPage(): React.JSX.Element {
  const { settings, directory, tab, saved } = useLoaderData() as { settings: IntegrationSettings; directory: OrganizationGroups; tab: SettingsTab; saved: boolean };
  return <><WorkspacePageHeader eyebrow="Organization workspace" title="Settings" description="Manage your organization’s groups, connected services, and support tools." />
    <nav className="settings-tabs" aria-label="Organization settings">{(['groups','integrations','debug'] as const).map(value => <Link key={value} to={`/settings?tab=${value}`} aria-current={tab === value ? 'page' : undefined}>{value === 'groups' ? 'Groups' : value === 'integrations' ? 'Integrations' : 'Debug'}</Link>)}</nav>
    <FormError />{saved && <p className="save-notice settings-saved" role="status">Changes saved.</p>}<IntegrationResult />
    {tab === 'groups' && <GroupsPanel directory={directory} />}
    {tab === 'integrations' && <><div className="settings-intro"><h2>Connected services</h2><p>Connections are specific to this organization. Saved secrets remain hidden; leave them blank to retain them.</p></div>
      <section className="settings-grid settings-connections" aria-label="Integration settings">
        <section className="form-card"><form className="workspace-form" method="post"><input type="hidden" name="intent" value="github" /><p className="eyebrow">Integration</p><h2>GitHub</h2><label><span><input type="checkbox" name="enabled" value="true" defaultChecked={settings.github.enabled} /> Enable GitHub integration</span></label><label>App ID<input name="appId" defaultValue={settings.github.appId} /></label><label>Installation ID<input name="installationId" defaultValue={settings.github.installationId} /></label><label>Organization<input name="org" defaultValue={settings.github.org} /></label><label>Private key <span className="form-optional">{settings.github.hasPrivateKey ? 'configured; leave blank to retain' : 'optional until enabled'}</span><textarea name="privateKey" rows={4} autoComplete="off" /></label><label>Webhook secret <span className="form-optional">{settings.github.hasWebhookSecret ? 'configured; leave blank to retain' : 'optional for outgoing operations'}</span><input name="webhookSecret" type="password" autoComplete="new-password" /></label><button className="button primary" type="submit">Save GitHub settings</button></form></section>
        <section className="form-card"><form className="workspace-form" method="post"><input type="hidden" name="intent" value="slack" /><p className="eyebrow">Integration</p><h2>Slack</h2><label><span><input type="checkbox" name="enabled" value="true" defaultChecked={settings.slack.enabled} /> Enable Slack integration</span></label><label>Workspace ID<input name="teamId" defaultValue={settings.slack.teamId} /></label><label>Bot token <span className="form-optional">{settings.slack.hasBotToken ? 'configured; leave blank to retain' : 'optional until enabled'}</span><input name="botToken" type="password" autoComplete="new-password" /></label><label>App-level token (xapp…) <span className="form-optional">{settings.slack.hasAppToken ? 'configured; leave blank to retain' : 'needed for Socket Mode commands'}</span><input name="appToken" type="password" autoComplete="new-password" /></label><label>Roster bot channel ID<input name="onboardingChannelId" defaultValue={settings.slack.onboardingChannelId} placeholder="C0123456789" /><span className="form-hint">Invite the bot and project leads to this channel. Join and GitHub review notices link to Edit User.</span></label><label><span><input type="checkbox" name="onboardingEnabled" value="true" defaultChecked={settings.slack.onboardingEnabled} /> Check Slack weekly and invite missing members to connect</span><span className="form-hint">People can always use /roster-connect while Slack is enabled. This setting controls automatic invitations.</span></label><button className="button primary" type="submit">Save Slack settings</button></form></section>
      </section>
    </>}
    {tab === 'debug' && <div className="settings-debug"><IntegrationWorkbenchPanel /></div>}
  </>;
}
