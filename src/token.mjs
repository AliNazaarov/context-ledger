// The loopback API token (ADR-10). The server writes a fresh random token next to its
// database at each start, together with the port it listens on; the CLI and the MCP
// adapter read it and send it as a bearer token, but only to that port; the browser
// signs in with a one-time code and then holds a session cookie. The server keeps
// only SHA-256 digests; the bearer check compares digests in constant time, and codes
// and sessions are looked up by their digests. Each port has its own file, so servers
// on different ports and one database do not replace each other's token.
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
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

// Windows ignores file modes: a file created the usual way takes its folder's inherited
// ACL, which outside the user profile often lets other users read it, and an account
// with WRITE_DAC on it could keep that right through a handle opened before any later
// change. So the writer has Windows PowerShell create the file (CreateNew, share mode
// None) with a protected security descriptor from the start: owner and only entry are
// the current user. Owner and DACL are then read back as SDDL, which does not depend on
// the display language; readers do the same and refuse a file that another account owns
// or may open. PowerShell runs from System32 with execFile and no shell, takes its
// script as -EncodedCommand and the path in an environment variable, and never sees the
// token.
const windows = process.platform === 'win32';
const powershell = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const runTool = promisify(execFile);
// libuv's UV_FS_O_EXLOCK: open with share mode 0. While the writer holds such a handle no
// other process can open the file for reading, writing or deletion, so the path cannot
// be renamed or replaced between its security check and the write.
const exclusiveLock = constants.UV_FS_O_EXLOCK ?? 0x10000000;
const sidPattern = /^S-1-[0-9]+(?:-[0-9]+)+$/u;
const pathVariable = 'CONTEXT_LEDGER_PRIVATE_FILE';
const powershellPreamble = "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n";
// Prints the current user's SID, then the file's owner, group and DACL as SDDL.
const describeScript = powershellPreamble +
  '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value\n' +
  `(Get-Acl -LiteralPath $env:${pathVariable}).Sddl\n`;
// Creates the file, which must not exist, with the current user as owner and only entry.
const createScript = powershellPreamble +
  '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User\n' +
  '$security = New-Object System.Security.AccessControl.FileSecurity\n' +
  '$security.SetOwner($sid)\n' +
  '$security.SetAccessRuleProtection($true, $false)\n' +
  "$security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule $sid, 'FullControl', 'Allow'))\n" +
  `$stream = New-Object System.IO.FileStream $env:${pathVariable}, ([System.IO.FileMode]::CreateNew), ` +
  '([System.Security.AccessControl.FileSystemRights]::FullControl), ([System.IO.FileShare]::None), 4096, ([System.IO.FileOptions]::None), $security\n' +
  '$stream.Dispose()\n';
const powershellArguments = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
const powershellOptions = path => ({ env: { ...process.env, [pathVariable]: path }, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 });

/**
 * True when an SDDL security descriptor (owner, optional group, DACL) has this SID as
 * owner and a DACL whose every allow entry is for this SID. Deny entries are harmless.
 * Another owner (who may always change the DACL), a NULL DACL (anyone), a conditional
 * or object entry, or text in any other shape is false.
 */
export function privateToOwner(sddl, sid) {
  if (typeof sddl !== 'string' || typeof sid !== 'string' || !sidPattern.test(sid)) return false;
  const parts = /^O:([A-Z]{2}|S-1-[0-9-]+)(?:G:(?:[A-Z]{2}|S-1-[0-9-]+))?D:[A-Z]*((?:\([^()]*\))*)(?:S:.*)?$/u.exec(sddl.trim());
  if (!parts || parts[1] !== sid) return false;
  const entries = [...parts[2].matchAll(/\(([^()]*)\)/gu)].map(entry => entry[1].split(';'));
  return entries.every(fields => fields[0] === 'D' || (fields[0] === 'A' && fields.length === 6 && fields[5] === sid));
}

/** The two lines of the describe script: { sid, sddl }, or undefined. */
function described(output) {
  const [sid, sddl] = String(output).split(/\r?\n/u);
  return sid && sddl && sidPattern.test(sid) ? { sid, sddl } : undefined;
}

/** True when the file at this path is private to the current user (Windows). */
async function isPrivate(path) {
  const { stdout } = await runTool(powershell(), powershellArguments(describeScript), powershellOptions(path));
  const found = described(stdout);
  if (!found) throw new Error('No security descriptor.');
  return privateToOwner(found.sddl, found.sid);
}

function isPrivateSync(path) {
  const found = described(execFileSync(powershell(), powershellArguments(describeScript), { ...powershellOptions(path), stdio: ['ignore', 'pipe', 'ignore'] }));
  return found !== undefined && privateToOwner(found.sddl, found.sid);
}

/** Creates an empty file, which must not exist, private to the current user from the start (Windows). */
function createPrivateFileSync(path) {
  execFileSync(powershell(), powershellArguments(createScript), { ...powershellOptions(path), stdio: 'ignore' });
}

/**
 * Writes a token file for a server listening on this port. An existing file (or link)
 * at the path is removed first and the new one is created exclusively, so a file or
 * link put there in between makes this fail instead of writing through it. Mode 0600
 * applies on POSIX. On Windows the empty file is created private to the current user
 * (see above), opened with share mode 0, checked for that owner and ACL, and only then
 * written. Any failure removes the file and throws. A link in the folder path is not
 * checked. Returns the file's identity ({ dev, ino } as bigints, from the open
 * descriptor: on Windows only a descriptor's stat names the volume) so readers can
 * refuse the file.
 */
export function writeTokenFile(path, token, port) {
  if (!secretPattern.test(token) || !validPort(port)) throw new Error('Invalid token record.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  let descriptor;
  try {
    if (windows) {
      createPrivateFileSync(path);
      descriptor = openSync(path, constants.O_WRONLY | exclusiveLock);
    } else {
      descriptor = openSync(path, 'wx', 0o600);
    }
  } catch (error) {
    if (windows) rmSync(path, { force: true });
    throw error;
  }
  const record = Buffer.from(JSON.stringify({ port, token }) + '\n', 'utf8');
  let identity;
  try {
    if (windows) {
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.size !== 0 || !isPrivateSync(path)) throw new Error('The token file is not private.');
    }
    if (writeSync(descriptor, record, 0, record.length, 0) !== record.length) throw new Error('The token file was not written whole.');
    const { dev, ino } = fstatSync(descriptor, { bigint: true });
    identity = { dev, ino };
  } finally {
    let closed = false;
    try {
      closeSync(descriptor);
      closed = true;
    } finally {
      // A file that is not private, not written whole or not closed is not left behind.
      if (identity === undefined || !closed) rmSync(path, { force: true });
    }
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
 * file that another account owns, or whose ACL allows anyone but the current user, gives
 * { exposed: true } and is not read; a file whose security cannot be read gives undefined.
 */
export async function readTokenFile(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const info = await file.stat();
    if (!info.isFile() || info.size > maxTokenFileBytes) return undefined;
    if (typeof process.getuid === 'function' && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) return undefined;
    if (windows) {
      // Owner and ACL are read by path, so the path must still name the open file
      // afterwards. Swapping it away and back in between needs another account to hold
      // full control of the folder, which the folder rule excludes. (Holding the file
      // with share mode 0 for the check would close that too, but made concurrent
      // clients fail with EBUSY.)
      if (!(await isPrivate(path))) return { exposed: true };
      const [opened, named] = await Promise.all([file.stat({ bigint: true }), stat(path, { bigint: true })]);
      if (opened.ino !== named.ino) return undefined;
    }
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
