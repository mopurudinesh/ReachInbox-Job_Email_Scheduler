import { createDecipheriv } from 'node:crypto';

export function decryptToken(value: string): string {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY is not configured.');
  const [version, nonce, tag, ciphertext] = value.split(':');
  if (version !== 'v1' || !nonce || !tag || !ciphertext) throw new Error('Stored integration token has an unsupported format.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
