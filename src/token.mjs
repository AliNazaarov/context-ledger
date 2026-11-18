// The loopback API token (ADR-10). The server writes a fresh random token next to its
// database at each start, together with the port it listens on; the CLI and the MCP
// adapter read it and send it as a bearer token, but only to that port; the browser
// signs in with a one-time code and then holds a session cookie. The server keeps
// only SHA-256 digests; the bearer check compares digests in constant time, and codes
// and sessions are looked up by their digests. Each port has its own file, so servers
// on different ports and one database do not replace each other's token.
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const secretBytes = 32;
const secretPattern = /^[A-Za-z0-9_-]{43}$/u;
export const codeLifetimeMs = 60 * 1000;
export const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const maxCodes = 32;
const maxSessions = 64;
const maxTokenFileBytes = 256;

const defaultDatabase = fileURLToPath(new URL('../.context-ledger/ledger.sqlite', import.meta.url));

const validPort = port => Number.isInteger(port) && port >= 1 && port <= 65535;

/** The token file of the ledger on this port: the database path with `.<port>.token` added. */
export function tokenFileFor(database, port) {
  if (!validPort(port)) throw new Error('Invalid port.');
  return `${resolve(database)}.${port}.token`;
}

/** Where a client looks: CONTEXT_LEDGER_DB as given, else the repository's default database. */
export function clientTokenFile(port, env = process.env) {
  return tokenFileFor(env.CONTEXT_LEDGER_DB ?? defaultDatabase, port);
}

const newSecret = () => randomBytes(secretBytes).toString('base64url');
const digest = text => createHash('sha256').update(text, 'utf8').digest();
const digestKey = text => digest(text).toString('hex');

/** A fresh random token of 32 bytes, base64url. */
export const newToken = newSecret;

// Windows ignores file modes: a new file takes its folder's inherited ACL, which outside
// the user profile often lets other users read it. The writer replaces that ACL with one
// entry for the current user's SID, and readers refuse a file whose ACL allows anyone
// else. Both read the ACL as SDDL (icacls /save), which does not depend on the display
// language, and run the System32 tools directly, without a shell.
const windows = process.platform === 'win32';
const system32 = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const toolOptions = { windowsHide: true, timeout: 10_000 };
const runTool = promisify(execFile);
// libuv's UV_FS_O_EXLOCK: open with share mode 0, so no other process can open the new
// file (and keep a handle that outlives the ACL change) before it is restricted.
const exclusiveLock = constants.UV_FS_O_EXLOCK ?? 0x10000000;
const byteOrderMark = String.fromCodePoint(0xfeff);
const sidPattern = /^S-1-[0-9]+(?:-[0-9]+)+$/u;

/** The SID in `whoami /user /fo csv /nh` output (its last quoted field), or undefined. */
function parseSid(output) {
  const sid = /"([^"]*)"\s*$/u.exec(String(output))?.[1];
  return sid !== undefined && sidPattern.test(sid) ? sid : undefined;
}

/**
 * True when `icacls /save` output gives a DACL whose every allow entry is for this SID.
 * Deny entries are harmless. A NULL DACL (anyone), a conditional or object entry, or
 * output in any other shape is false.
 */
export function onlyOwnerAllowed(saved, sid) {
  const text = String(saved).startsWith(byteOrderMark) ? String(saved).slice(1) : String(saved);
  const line = text.split(/\r?\n/u)[1] ?? '';
  const dacl = /^D:[A-Z]*((?:\([^()]*\))*)(?:S:.*)?$/u.exec(line);
  if (!dacl || !sidPattern.test(sid)) return false;
  const entries = [...dacl[1].matchAll(/\(([^()]*)\)/gu)].map(entry => entry[1].split(';'));
  return entries.every(fields => fields[0] === 'D' || (fields[0] === 'A' && fields.length === 6 && fields[5] === sid));
}

let sidLookup;
/** The current user's SID, looked up once per process (a failed lookup is retried). */
function currentSid() {
  sidLookup ??= runTool(join(system32(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], toolOptions).then(({ stdout }) => {
    const sid = parseSid(stdout);
    if (!sid) throw new Error('No user SID.');
    return sid;
  });
  return sidLookup.catch(error => {
    sidLookup = undefined;
    throw error;
  });
}

function currentSidSync() {
  const sid = parseSid(execFileSync(join(system32(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { ...toolOptions, stdio: ['ignore', 'pipe', 'ignore'] }));
  if (!sid) throw new Error('No user SID.');
  return sid;
}

/** A file's DACL as `icacls /save` writes it (UTF-16), saved to a private temporary folder. */
async function savedAcl(path) {
  const folder = await mkdtemp(join(tmpdir(), 'ledger-acl-'));
  try {
    const saved = join(folder, 'acl');
    await runTool(join(system32(), 'icacls.exe'), [path, '/save', saved], toolOptions);
    return (await readFile(saved)).toString('utf16le');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function savedAclSync(path) {
  const folder = mkdtempSync(join(tmpdir(), 'ledger-acl-'));
  try {
    const saved = join(folder, 'acl');
    execFileSync(join(system32(), 'icacls.exe'), [path, '/save', saved], { ...toolOptions, stdio: 'ignore' });
    return readFileSync(saved).toString('utf16le');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * On Windows, replaces a file's ACL with full control for the current user only (no
 * inherited entries) and checks the result; throws if either step fails. Elsewhere it
 * does nothing: the file's mode is what counts there.
 */
export function restrictToOwner(path) {
  if (!windows) return;
  const sid = currentSidSync();
  execFileSync(join(system32(), 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:F`], { ...toolOptions, stdio: 'ignore' });
  if (!onlyOwnerAllowed(savedAclSync(path), sid)) throw new Error('The token file is not private.');
}

/**
 * Writes a token file for a server listening on this port. An existing file (or link)
 * at the path is removed first and the new one is created exclusively, so a file or
 * link put there in between makes this fail instead of writing through it. Mode 0600
 * applies on POSIX. On Windows the empty file is opened with an exclusive lock, its ACL
 * is replaced with one for the current user only and checked, and only then is the
 * token written; if that fails, the file is removed and this throws. The folder is
 * trusted: a folder other users can write to, or a link in the folder path, is not
 * checked. Returns the file's identity ({ dev, ino } as bigints, from the open
 * descriptor: on Windows only a descriptor's stat names the volume) so readers can
 * refuse the file.
 */
export function writeTokenFile(path, token, port) {
  if (!secretPattern.test(token) || !validPort(port)) throw new Error('Invalid token record.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const flags = windows ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | exclusiveLock : 'wx';
  const descriptor = openSync(path, flags, 0o600);
  let identity;
  try {
    restrictToOwner(path);
    writeSync(descriptor, JSON.stringify({ port, token }) + '\n');
    const { dev, ino } = fstatSync(descriptor, { bigint: true });
    identity = { dev, ino };
  } finally {
    closeSync(descriptor);
    // A file that could not be made private, or not written whole, is not left behind.
    if (identity === undefined) rmSync(path, { force: true });
  }
  return identity;
}

/**
 * Removes the token file if it still holds this server's token (another start may have
 * replaced it). The read is bounded, non-blocking and refuses links and non-regular
 * files, so a FIFO put there cannot hang the stop. A start that replaces the file
 * between this read and the removal loses its file; run one server per database and port.
 */
export function removeTokenFile(path, isOwnToken) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > maxTokenFileBytes) return;
    const buffer = Buffer.alloc(maxTokenFileBytes + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (typeof record?.token === 'string' && secretPattern.test(record.token) && isOwnToken(record.token)) {
      closeSync(descriptor);
      descriptor = undefined;
      rmSync(path, { force: true });
    }
  } catch {
    // Already gone, replaced or unreadable: nothing to remove.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Reads a token file: { port, token }, or undefined when the file is missing, is not a
 * regular file (a FIFO cannot block the read), is malformed, or on POSIX is a link,
 * belongs to another user or can be read or written by group or others. On Windows a
 * file whose ACL allows anyone but the current user gives { exposed: true } and is not
 * read; a file whose ACL cannot be read gives undefined.
 */
export async function readTokenFile(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const info = await file.stat();
    if (!info.isFile() || info.size > maxTokenFileBytes) return undefined;
    if (typeof process.getuid === 'function' && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) return undefined;
    if (windows && !onlyOwnerAllowed(await savedAcl(path), await currentSid())) return { exposed: true };
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
 * What a client sends to the ledger on this port, from that port's token file: { token }
 * when the file names that port, { otherPort } when it names another (a file copied or
 * renamed; the token is then not sent, so it never goes to another listener),
 * { exposed: true } when the file is readable by other users (Windows ACL), or {} when
 * there is no readable file.
 */
export async function clientToken(port, env = process.env) {
  if (!validPort(port)) return {};
  const record = await readTokenFile(clientTokenFile(port, env));
  if (!record) return {};
  if (record.exposed) return { exposed: true };
  return record.port === port ? { token: record.token } : { otherPort: record.port };
}

/**
 * The token for a ledger URL, for scripts that take one (LEDGER): only for plain http
 * to the IPv4 loopback 127.0.0.1 (where the ledger listens; localhost may reach ::1;
 * URL parsing also accepts spellings such as 127.1, which are the same address) on the
 * port the token file names, else undefined. This guards against a wrong setting, not
 * against another program that takes the port after the ledger stops.
 */
export async function tokenForUrl(url, env = process.env) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') return undefined;
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
    /** True for this server's token (compared as digests, in constant time). */
    isOwnToken: text => timingSafeEqual(digest(text), tokenDigest),
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
