import React from 'react';
import { useLoaderData } from 'react-router';

export function SystemCollabAdminsPage(): React.JSX.Element {
  const { grants, users, self } = useLoaderData() as { grants: { username: string; granted_by: string }[]; users: { username: string }[]; self: string };
  const usernames = [...new Set([self, ...users.map((user) => user.username)])];
  return <><section className="hero-row"><div><p className="eyebrow">System administration</p><h1>Collaborator administrators</h1><p className="lede">Only system administrators can grant or revoke the independent collab-admins role. System administrators also need an explicit grant to open invitations.</p></div></section>
    <section className="form-card"><form method="post" className="workspace-form"><input type="hidden" name="intent" value="grant" /><label>Roster username<select name="username" required>{usernames.map((username) => <option key={username} value={username}>{username}{username === self ? ' (you)' : ''}</option>)}</select></label><button className="button primary" type="submit">Grant collab-admins</button></form></section>
    <section className="content-card"><h2>Current grants</h2>{grants.length ? <ul>{grants.map((grant) => <li key={grant.username}><strong>{grant.username}</strong> — granted by {grant.granted_by}<form method="post"><input type="hidden" name="intent" value="revoke" /><input type="hidden" name="username" value={grant.username} /><button type="submit" className="danger-link">Revoke {grant.username}</button></form></li>)}</ul> : <p>No collaborator administrators have been granted access.</p>}<a href="/collab-manage">Open collaborator invitations</a></section></>;
}
