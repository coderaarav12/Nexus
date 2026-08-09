import crypto from 'node:crypto';
import { config } from '../config';

// ---------- random / hashing ----------

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---------- password hashing (scrypt) ----------
// stored format: scrypt$N$r$p$saltB64$hashB64

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [, n, r, p, saltB64, hashB64] = stored.split('$');
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ---------- access tokens (HMAC-signed, JWT-like) ----------

interface TokenPayload {
  uid: number;
  did?: number;
  role: string;
  exp: number;
  iat: number;
  jti: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function signAccessToken(uid: number, role: string, did: number | undefined): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        uid,
        did,
        role,
        exp: Date.now() + config.accessTokenMinutes * 60000,
        iat: Date.now(),
        jti: randomToken(16),
      } satisfies TokenPayload),
    ),
  );
  const sig = crypto.createHmac('sha256', config.tokenSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyAccessToken(token: string): TokenPayload | null {
  try {
    const [header, payload, sig] = token.split('.');
    if (!header || !payload || !sig) return null;
    const expected = crypto.createHmac('sha256', config.tokenSecret).update(`${header}.${payload}`).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown as TokenPayload;
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// ---------- login grants (short-lived, single-use) ----------

export function signLoginGrant(uid: number): { token: string; jti: string } {
  const jti = randomToken(16);
  const payload = b64url(
    Buffer.from(
      JSON.stringify({ uid, purpose: 'login_grant', exp: Date.now() + 5 * 60000, jti }),
    ),
  );
  const sig = crypto.createHmac('sha256', config.tokenSecret).update(`grant.${payload}`).digest('base64url');
  return { token: `grant.${payload}.${sig}`, jti };
}

export function verifyLoginGrant(token: string): { uid: number; jti: string } | null {
  try {
    const [prefix, payload, sig] = token.split('.');
    if (prefix !== 'grant') return null;
    const expected = crypto.createHmac('sha256', config.tokenSecret).update(`grant.${payload}`).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.purpose !== 'login_grant' || data.exp < Date.now()) return null;
    return { uid: data.uid as unknown as number, jti: data.jti as string };
  } catch {
    return null;
  }
}

// ---------- TOTP (RFC 6238) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function computeTotp(secret: string, timeStep = 30, offset = 0): string {
  const counter = Math.floor(Date.now() / 1000 / timeStep) + offset;
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 1000000;
  return code.toString().padStart(6, '0');
}

export function verifyTotp(secret: string, code: string, window = 1): boolean {
  for (let w = -window; w <= window; w++) {
    if (computeTotp(secret, 30, w) === code) return true;
  }
  return false;
}

export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => randomToken(8).replace(/-/g, '').slice(0, 10));
}

export function otpauthUrl(username: string, secret: string): string {
  return `otpauth://totp/Nexus:${encodeURIComponent(username)}?secret=${secret}&issuer=Nexus&period=30&digits=6`;
}

// ---------- symmetric encryption (TOTP secrets at rest) ----------

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.masterKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  const [v, ivB64, tagB64, dataB64] = stored.split(':');
  if (v !== 'v1') throw new Error('unknown secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.masterKey, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
