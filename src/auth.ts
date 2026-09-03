import { sign, verify } from 'hono/jwt';
import { bufToHex, hexToBuf, randHex, type Env } from './lib';

export type JWTPayload = {
  uid: number;
  email: string;
  role: string;
  name: string;
  exp: number;
};

// ⚠️ 仅本地开发兜底密钥：未设置 SESSION_SECRET 时使用。生产环境必须通过 `wrangler secret put SESSION_SECRET` 设置强随机值！
const FALLBACK_SECRET = 'dev-secret-change-me';

export function getSecret(env: Env): string {
  return env.SESSION_SECRET || FALLBACK_SECRET;
}

async function pbkdf2Hex(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bufToHex(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2Hex(password, salt, 100000);
  return `${bufToHex(salt)}:${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hash] = stored.split(':');
  if (!saltHex || !hash) return false;
  const computed = await pbkdf2Hex(password, hexToBuf(saltHex), 100000);
  // constant-time compare
  if (computed.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

export async function issueToken(env: Env, user: { id: number; email: string; role: string; name: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    uid: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    exp: now + 60 * 60 * 24 * 30, // 30 days
  };
  return await sign(payload, getSecret(env), 'HS256');
}

export async function verifyToken(env: Env, token: string): Promise<JWTPayload | null> {
  try {
    const payload = await verify(token, getSecret(env), 'HS256');
    return payload as unknown as JWTPayload;
  } catch {
    return null;
  }
}

export async function genInviteCode(): Promise<string> {
  // 8-char uppercase alphanumeric, easy to type
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[bytes[i] % chars.length];
  return code;
}

export function generateVerifyToken(): string {
  return randHex(24);
}

// Cookie helpers
export function authCookie(token: string): string {
  return `fc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

export function clearCookie(): string {
  return 'fc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') || '';
  const parts = header.split(';');
  for (const part of parts) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

// Read current user from request (if any)
export async function currentUser(env: Env, request: Request): Promise<JWTPayload | null> {
  const token = getCookie(request, 'fc_session');
  if (!token) return null;
  return await verifyToken(env, token);
}
