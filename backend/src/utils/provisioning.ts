export function ninetyDaysFromNow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 90);
  return d.toISOString().slice(0, 10);
}

export function triggerGithubInvite(githubUsername: string): void {
  const base = process.env.GITHUB_APP_URL ?? 'http://github-app:3001';
  fetch(`${base}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ githubUsername }),
  }).catch((err) => console.warn(`[provisioning] GitHub invite trigger failed for ${githubUsername}:`, err));
}
