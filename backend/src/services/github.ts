import { NewUser, ProvisionResult, SystemStatus } from './types';

// TODO: implement with @octokit/rest
// npm install @octokit/rest

export async function checkUser(_username: string): Promise<SystemStatus> {
  throw new Error('GitHub service not yet implemented');
}

export async function inviteUser(_user: NewUser): Promise<ProvisionResult> {
  throw new Error('GitHub service not yet implemented');
}

export async function listTeams(): Promise<Array<{ slug: string; name: string }>> {
  throw new Error('GitHub service not yet implemented');
}
