import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function encryptionKey(): Buffer {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be base64 encoding of exactly 32 random bytes.');
  return key;
}

export function tokenEncryptionConfigured(): boolean {
  return Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || '', 'base64').length === 32;
}

export function encryptToken(value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${nonce.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptToken(value: string): string {
  const [version, nonce, tag, ciphertext] = value.split(':');
  if (version !== 'v1' || !nonce || !tag || !ciphertext) throw new Error('Stored integration token has an unsupported format.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
