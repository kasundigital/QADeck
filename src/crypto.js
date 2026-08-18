const crypto = require('crypto');

function keyFromEnv() {
  const raw = process.env.CREDENTIALS_KEY || 'development-only-qadeck-key-change-me';
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromEnv(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

function decrypt(payload) {
  if (!payload) return '';
  const [ivRaw, tagRaw, dataRaw] = String(payload).split('.');
  if (!ivRaw || !tagRaw || !dataRaw) return '';
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyFromEnv(),
    Buffer.from(ivRaw, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

module.exports = { encrypt, decrypt };
