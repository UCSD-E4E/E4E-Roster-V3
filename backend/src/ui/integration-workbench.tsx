import React from 'react';
import { useActionData, useLoaderData } from 'react-router';
import type { IntegrationWorkbench } from './settings.server';
import type { RosterUiContext } from './projects.server';

export function IntegrationWorkbenchPanel(): React.JSX.Element {
  const { workbench, context } = useLoaderData() as { workbench: IntegrationWorkbench; context: RosterUiContext };
  const action = useActionData() as { integrationMessage?: string; destinations?: Array<{ id: string; name: string }> } | undefined;
  return <>
    {action?.integrationMessage && <section className="content-card" role="status"><p>{action.integrationMessage}</p>
      {action.destinations && <ul>{action.destinations.map(d => <li key={d.id}><code>{d.id}</code> — {d.name}</li>)}</ul>}</section>}
    <section className="content-card"><h2>Connection checks</h2><p>Verify credentials and list destinations before applying group mappings. Slack commands connect within 15 seconds after saving an app-level token.</p>
      <div className="row-actions">{['slack', 'github'].map(service => <form method="post" key={service}><input type="hidden" name="intent" value="verify" /><input type="hidden" name="service" value={service} /><button className="button secondary">Verify {service} and list destinations</button></form>)}</div>
      <p>GitHub webhook path: <code>/webhooks/github/{context.org.id}</code> (signed events, observation only).</p>
    </section>
    <section className="content-card"><h2>Slack onboarding</h2><p>Configure the roster bot channel and enable weekly checks in Slack settings above. New members receive one invitation, then one channel notification links to the existing Edit User page. Existing member links stay quiet.</p><form method="post"><input type="hidden" name="intent" value="scan-slack" /><button className="button secondary">Check Slack for missing members now</button></form>{workbench.deliveries.length > 0 && <div className="table-wrap"><table><thead><tr><th>Message</th><th>Person</th><th>Status</th></tr></thead><tbody>{workbench.deliveries.map((d,i) => <tr key={i}><td>{d.kind}</td><td>{d.identity}</td><td>{d.status}</td></tr>)}</tbody></table></div>}</section>
    <section className="form-card"><h2>Slack identities in this organization</h2><p>Use a Slack member ID. An administrator can link it here; otherwise the first command links a unique matching roster email. Legacy global Slack names are not used.</p>
      <form method="post" className="workspace-form"><input type="hidden" name="intent" value="link-slack" /><label>Roster member<select name="username">{workbench.identities.map(i => <option key={i.username} value={i.username}>{i.username} {i.external_id ? `(${i.external_id})` : '(not linked)'}</option>)}</select></label>
      <label>Slack member ID<input name="externalId" placeholder="U0123456789" required /></label><button className="button secondary">Link Slack identity</button></form>
    </section>
    <section className="content-card"><div className="section-heading"><div><h2>Preview access grants</h2><p>Only active members of this organization with matching groups and enabled connections are included. This prototype adds access; it does not revoke it.</p></div>
      <form method="post"><input type="hidden" name="intent" value="sync" /><button className="button primary">Apply these grants</button></form></div>
      {workbench.plan.grants.length ? <div className="table-wrap"><table><thead><tr><th>Member</th><th>Service</th><th>External identity</th><th>Destination</th></tr></thead><tbody>{workbench.plan.grants.map(g => <tr key={`${g.service}:${g.externalId}:${g.targetId}`}><td>{g.username}</td><td>{g.service}</td><td>{g.externalId}</td><td><code>{g.targetId}</code></td></tr>)}</tbody></table></div> : <p>No grants planned.</p>}
      {workbench.plan.skipped.length > 0 && <details><summary>{workbench.plan.skipped.length} skipped entries</summary><ul>{workbench.plan.skipped.map((s, i) => <li key={i}>{s.username}: {s.reason}</li>)}</ul></details>}
    </section>
    <section className="content-card"><h2>Recent integration activity</h2>{workbench.events.length ? <div className="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Member</th><th>Result</th></tr></thead><tbody>{workbench.events.map((e, i) => <tr key={i}><td>{e.created_at}</td><td>{e.action}</td><td>{e.target_username ?? '—'}</td><td>{e.details.outcome ?? e.details.error ?? e.details.expiry ?? e.details.event ?? e.details.externalId ?? 'Recorded'}</td></tr>)}</tbody></table></div> : <p>No activity yet.</p>}</section>
  </>;
}
