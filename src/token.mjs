// The loopback API token (ADR-10). The server writes a fresh random token next to its
// database at each start; the CLI and the MCP adapter read it and send it as a bearer
// token; the browser signs in with a one-time code and then holds a session cookie.
// The server keeps only SHA-256 digests and compares them in constant time.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const secretBytes = 32;
const secretPattern = /^[A-Za-z0-9_-]{43}$/u;
export const codeLifetimeMs = 60 * 1000;
export const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const maxCodes = 32;
const maxSessions = 64;
const maxTokenFileBytes = 256;

const defaultDatabase = fileURLToPath(new URL('../.context-ledger/ledger.sqlite', import.meta.url));

/** The token file of a database: the database path with `.token` added. */
export function tokenFileFor(database) {
  return resolve(database) + '.token';
}

/** Where a client looks: CONTEXT_LEDGER_DB as given, else the repository's default database. */
export function clientTokenFile(env = process.env) {
  return tokenFileFor(env.CONTEXT_LEDGER_DB ?? defaultDatabase);
}

const newSecret = () => randomBytes(secretBytes).toString('base64url');
const digest = text => createHash('sha256').update(text, 'utf8').digest();
const digestKey = text => digest(text).toString('hex');

/**
 * Writes a fresh token file and returns the token. An existing file (or link) at the
 * path is removed first and the new one is created exclusively, so a file or link put
 * there in between makes this fail instead of writing through it. Mode 0600 applies on
 * POSIX; on Windows the file takes its folder's ACL.
 */
export function writeTokenFile(path) {
  const token = newSecret();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeSync(descriptor, token + '\n');
  } finally {
    closeSync(descriptor);
  }
  return token;
}

/** Reads a client's token, or returns undefined when the file is missing, unreadable or malformed. */
export async function readTokenFile(path) {
  let file;
  try {
    file = await open(path, 'r');
    const buffer = Buffer.alloc(maxTokenFileBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxTokenFileBytes) return undefined;
    const token = buffer.subarray(0, bytesRead).toString('utf8').trim();
    return secretPattern.test(token) ? token : undefined;
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => {});
  }
}

/** The value of one cookie in a Cookie header, or undefined. */
function cookieValue(header, name) {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** Keeps a map of digest -> expiry under a size bound, dropping expired and then oldest entries. */
function remember(map, key, expiresAt, limit, now) {
  for (const [entry, expiry] of map) if (expiry <= now) map.delete(entry);
  while (map.size >= limit) map.delete(map.keys().next().value);
  map.set(key, expiresAt);
}

function takeValid(map, key, now) {
  const expiry = map.get(key);
  if (expiry === undefined) return false;
  if (expiry <= now) {
    map.delete(key);
    return false;
  }
  return true;
}

/** The server's side: the token digest, one-time sign-in codes and browser sessions. */
export function createAuth({ token, port, now = Date.now }) {
  const tokenDigest = digest(token);
  const codes = new Map();
  const sessions = new Map();
  const cookieName = `context_ledger_${port}`;

  const bearer = request => {
    const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/u.exec(request.headers.authorization ?? '');
    return Boolean(match) && timingSafeEqual(digest(match[1]), tokenDigest);
  };
  const session = request => {
    const value = cookieValue(request.headers.cookie, cookieName);
    return value !== undefined && secretPattern.test(value) && takeValid(sessions, digestKey(value), now());
  };

  return {
    cookieName,
    /** True when the request carries the bearer token. */
    bearer,
    /** True when the request carries the bearer token or a live session cookie. */
    allowed: request => bearer(request) || session(request),
    /** A new one-time sign-in code. */
    mintCode() {
      const code = newSecret();
      remember(codes, digestKey(code), now() + codeLifetimeMs, maxCodes, now());
      return code;
    },
    /** Uses up a code; returns the Set-Cookie value of a new session, or undefined. */
    redeem(code) {
      if (typeof code !== 'string' || !secretPattern.test(code)) return undefined;
      const key = digestKey(code);
      const valid = takeValid(codes, key, now());
      codes.delete(key);
      if (!valid) return undefined;
      const id = newSecret();
      remember(sessions, digestKey(id), now() + sessionLifetimeMs, maxSessions, now());
      return `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeMs / 1000}`;
    },
  };
}
