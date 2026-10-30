import React from 'react';
import type { PersonStatus as Status } from './person-status.server';

export function PersonStatus({ status, username }: { status: Status; username: string }): React.JSX.Element {
  const id = `person-status-${username}`;
  return <><button type="button" className={`status status-${status.kind} status-trigger`} popoverTarget={id} aria-label={`${status.label}: status details for ${username}`}>{status.label}</button>
    <section popover="auto" id={id} className="settings-popup person-status-popup" aria-label={`Status for ${username}`}>
      <header><div><h2>{status.label}</h2><p className="form-copy">{username}</p></div><button type="button" className="popup-close" popoverTarget={id} popoverTargetAction="hide" aria-label="Close status details">×</button></header>
      <dl className="person-status-details">{status.details.map((detail,i) => <div key={i}><dt>{detail.label}</dt><dd>{detail.message}{detail.checkedAt && <small>Last checked: <time dateTime={new Date(detail.checkedAt).toISOString()}>{new Date(detail.checkedAt).toISOString().replace('T',' ').slice(0,19)} UTC</time></small>}</dd></div>)}</dl>
    </section></>;
}
