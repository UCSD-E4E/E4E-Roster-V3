import React from 'react';

export function SlackConnectPage(props: { organization?: string; username?: string; githubUsername?: string; error?: string; completed?: boolean; accountPath?: string; confirmationCode?: string; slackEmail?: string }): React.JSX.Element {
  return <html lang="en"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Connect Slack — Roster</title><link rel="stylesheet" href="/static/css/react-roster.css" /></head>
    <body><main className="workspace-main"><section className="hero-row"><div><p className="eyebrow">Roster onboarding</p><h1>{props.completed ? 'Your account is connected' : props.confirmationCode ? 'Confirm your Slack account' : 'Connect your Slack account'}</h1><p className="lede">{props.organization ? `${props.organization} roster` : 'Sign in with your existing roster account.'}</p></div></section>
      <section className="form-card person-form-card">
        {props.error && <p role="alert" className="form-error">{props.error}</p>}
        {props.completed ? <><p>Your Slack identity is linked and your GitHub username has been submitted. Project and resource groups are assigned separately.</p><a className="button primary" href={props.accountPath}>Open my account</a></> : props.username ? <form method="post" action="/connect/slack" className="workspace-form">
          <p>Connect the Slack account from your invitation to <strong>{props.username}</strong>. If you are new to this organization, you will join as a regular member.</p>
          {props.confirmationCode && <section className="slack-confirmation"><p>Your Slack and roster emails differ. In the Slack workspace for <strong>{props.organization}</strong>, use the account <strong>{props.slackEmail}</strong> and run:</p><pre><code>/roster-connect {props.confirmationCode}</code></pre><p>After Slack confirms the connection to <strong>{props.username}</strong>, return here and finish. The code expires in 10 minutes.</p><input type="hidden" name="githubUsername" value={props.githubUsername} /></section>}
          {!props.confirmationCode && <><label>GitHub username<input name="githubUsername" required maxLength={39} defaultValue={props.githubUsername ?? ''} autoComplete="off" placeholder="octocat" /></label>
          <p className="form-hint">Enter your username, not a profile URL. This submits it for review; it does not prove ownership or grant GitHub access.</p></>}
          <button className="button primary">{props.confirmationCode ? 'Finish connection' : 'Connect my account'}</button>
        </form> : !props.error ? <><p>Your Slack invitation will be preserved while you sign in.</p><a className="button primary" href="/auth/login">Sign in with SSO</a><p>You need an existing SSO account. Contact a project lead if you do not have one.</p></> : <p>Return to Slack and run <code>/roster-connect</code> for a new link, or contact your roster administrator.</p>}
      </section></main></body></html>;
}
