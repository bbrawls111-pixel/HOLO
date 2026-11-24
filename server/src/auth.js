import crypto from 'node:crypto';
import { one, q } from './db.js';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)', tokenHash(token), userId, Date.now());
  return token;
}

export async function deleteSession(token) {
  if (token) await q('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
}

export async function getUserByToken(token) {
  if (!token) return null;
  return one('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', tokenHash(token));
}

export function bearerToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1].trim() : null;
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

// Защита от перебора пароля: 10 неудачных попыток за 10 минут с одного IP.
const WINDOW = 10 * 60 * 1000;

export async function checkLoginRate(ip) {
  const row = await one('SELECT COUNT(*)::int AS n FROM login_attempts WHERE ip = ? AND at > ?', ip, Date.now() - WINDOW);
  return row.n < 10;
}

export async function recordFailedLogin(ip) {
  await q('INSERT INTO login_attempts (ip, at) VALUES (?, ?)', ip, Date.now());
  await q('DELETE FROM login_attempts WHERE at < ?', Date.now() - WINDOW);
}
