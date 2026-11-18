// The loopback API token (ADR-10). The server writes a fresh random token next to its
// database at each start, together with the port it listens on; the CLI and the MCP
// adapter read it and send it as a bearer token, but only to that port; the browser
// signs in with a one-time code and then holds a session cookie. The server keeps
// only SHA-256 digests; the bearer check compares digests in constant time, and codes
// and sessions are looked up by their digests.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
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

/** A fresh random token of 32 bytes, base64url. */
export const newToken = newSecret;

const validPort = port => Number.isInteger(port) && port >= 1 && port <= 65535;

/**
 * Writes a token file for a server listening on this port. An existing file (or link)
 * at the path is removed first and the new one is created exclusively, so a file or
 * link put there in between makes this fail instead of writing through it. Mode 0600
 * applies on POSIX; on Windows the file takes its folder's ACL. The folder is trusted:
 * a folder other users can write to, or a link in the folder path, is not checked.
 */
export function writeTokenFile(path, token, port) {
  if (!secretPattern.test(token) || !validPort(port)) throw new Error('Invalid token record.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeSync(descriptor, JSON.stringify({ port, token }) + '\n');
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Reads a token file: { port, token }, or undefined when the file is missing, is not a
 * regular file (a FIFO cannot block the read), belongs to another user on POSIX, or is
 * malformed.
 */
export async function readTokenFile(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = await file.stat();
    if (!info.isFile() || info.size > maxTokenFileBytes) return undefined;
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return undefined;
    const buffer = Buffer.alloc(maxTokenFileBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxTokenFileBytes) return undefined;
    const record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (typeof record?.token !== 'string' || !secretPattern.test(record.token) || !validPort(record.port)) return undefined;
    return { port: record.port, token: record.token };
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => {});
  }
}

/**
 * What a client sends to the ledger on this port: { token } when the file names that
 * port, { otherPort } when it names another (the token is then not sent, so a wrong
 * PORT never hands it to another listener), or {} when there is no readable file.
 */
export async function clientToken(port, env = process.env) {
  const record = await readTokenFile(clientTokenFile(env));
  if (!record) return {};
  return record.port === port ? { token: record.token } : { otherPort: record.port };
}

/**
 * The token for a ledger URL, for scripts that take one (LEDGER): only for plain http
 * to 127.0.0.1 or localhost on the port the token file names, else undefined.
 */
export async function tokenForUrl(url, env = process.env) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) return undefined;
  return (await clientToken(Number(parsed.port || 80), env)).token;
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
