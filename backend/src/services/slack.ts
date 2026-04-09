import { NewUser, ProvisionResult, SystemStatus } from './types';

// TODO: implement with @slack/web-api
// npm install @slack/web-api

export async function checkUser(_email: string): Promise<SystemStatus> {
  throw new Error('Slack service not yet implemented');
}

export async function inviteUser(_user: NewUser): Promise<ProvisionResult> {
  throw new Error('Slack service not yet implemented');
}
