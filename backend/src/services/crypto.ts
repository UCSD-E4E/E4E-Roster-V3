import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

// ENCRYPTION_KEY must be a 64-character hex string (32 bytes).
// Generate with: openssl rand -hex 32
function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be set to a 64-character hex string. Generate with: openssl rand -hex 32');
  }
  return Buffer.from(hex, 'hex');
}

// Returns a base64 string: [12-byte IV][16-byte auth tag][ciphertext]
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const data = Buffer.from(ciphertext, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// Encrypt only if the value looks like plaintext (not already encrypted base64).
// Used when upserting integration configs to avoid double-encrypting on re-save.
export function encryptField(value: string): string {
  try {
    decrypt(value);
    return value; // already encrypted — pass through
  } catch {
    return encrypt(value);
  }
}
