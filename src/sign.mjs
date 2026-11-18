// Signed hand-off bundles (card P4a, design ADR-9): raw Ed25519 over an RFC 8785
// (JCS) manifest of file names, sizes and SHA-256 hashes. The key fingerprint is
// SHA-256 of the public key's SubjectPublicKeyInfo DER bytes, checked out of band.
import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify,
} from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { terminalLabel } from './text.mjs';

export const bundleFormat = 'context-ledger-signed-handoff';
export const handoffFile = 'handoff.md';
export const manifestFile = 'manifest.json';
export const signatureFile = 'manifest.sig';
export const publicKeyFile = 'public-key.pem';
const envelopeFiles = [manifestFile, signatureFile, publicKeyFile];
const manifestKeys = ['algorithm', 'created_at', 'files', 'format', 'public_key', 'session', 'version'];
const fileNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const createdAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const maxManifestBytes = 64 * 1024;
const maxPemBytes = 16 * 1024;
const signatureBytes = 64;

// --- RFC 8785 (JCS), the subset JSON.parse can produce -------------------------

// With the u flag, a surrogate pair is one code point and only a lone surrogate is Cs.
const loneSurrogate = /\p{Cs}/u;

function canonicalString(value) {
  if (loneSurrogate.test(value)) throw new TypeError('JCS refuses a lone surrogate.');
  // JSON.stringify escapes exactly what RFC 8785 section 3.2.2.2 requires.
  return JSON.stringify(value);
}

function canonicalValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return canonicalString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS refuses NaN and Infinity.');
    // ECMAScript Number serialization, as RFC 8785 section 3.2.2.3 specifies (-0 is 0).
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) items.push(canonicalValue(value[index]));
    return '[' + items.join(',') + ']';
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('JCS takes plain objects only.');
    // The default sort compares UTF-16 code units, as RFC 8785 section 3.2.3 requires.
    const keys = Object.keys(value).sort();
    return '{' + keys.map(key => canonicalString(key) + ':' + canonicalValue(value[key])).join(',') + '}';
  }
  throw new TypeError('JCS refuses a value that is not JSON.');
}

/** Serialize a JSON value as RFC 8785 canonical JSON text. */
export function canonicalJson(value) {
  return canonicalValue(value);
}

// --- Keys -----------------------------------------------------------------------

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** SHA-256 of the SPKI DER bytes, as 16 groups of 4 lowercase hex digits. */
export function keyFingerprint(publicKey) {
  const hex = sha256Hex(publicKey.export({ type: 'spki', format: 'der' }));
  return hex.match(/.{4}/g).join(' ');
}

/** Accept a fingerprint with spaces, colons or no separators, in any case. */
export function normalizeFingerprint(text) {
  const hex = String(text).replace(/[\s:]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('A fingerprint is 64 hex digits.');
  return hex;
}

/** The signing key lives beside the ledger database. */
export function signingKeyPath(env = process.env) {
  const database = env.CONTEXT_LEDGER_DB ?? '.context-ledger/ledger.sqlite';
  if (database === '' || database === ':memory:') {
    throw new Error('Set CONTEXT_LEDGER_DB to a file path to keep a signing key beside it.');
  }
  return join(dirname(database), 'signing-key.pem');
}

/** Create an Ed25519 key pair; never replace an existing key. Returns the fingerprint. */
export async function generateSigningKey(path) {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    throw new Error('Cannot create the ledger data folder.');
  }
  if (await exists(path)) throw new Error('A signing key already exists. It was not replaced.');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  // Write a temporary file in the same folder, then hard-link it into place: link()
  // never replaces an existing file, and an interrupted run leaves only the temporary
  // file, never a partial key under the real name. 0600 where the OS has POSIX modes;
  // on Windows the file takes the folder's access list instead.
  const staging = join(dirname(path), basename(path) + '.' + randomBytes(8).toString('hex') + '.tmp');
  let file;
  try {
    file = await open(staging, 'wx', 0o600);
  } catch {
    throw new Error('Cannot write the signing key file.');
  }
  // Only a staging file this call created is ever removed.
  try {
    await file.writeFile(privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await file.sync();
    await file.close();
    file = undefined;
    await link(staging, path);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('A signing key already exists. It was not replaced.');
    if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'].includes(error.code)) {
      throw new Error('Cannot save the signing key: the file system refused a hard link, which keygen ' +
        'needs to save a key without replacing one (FAT and exFAT have none). Put CONTEXT_LEDGER_DB ' +
        'on an NTFS, APFS or ext4 volume.');
    }
    throw new Error('Cannot write the signing key file.');
  } finally {
    await file?.close().catch(() => {});
    await unlink(staging).catch(() => {});
  }
  return keyFingerprint(publicKey);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error('Cannot check the signing key file.');
  }
}

// O_NOFOLLOW refuses a symlink swapped in after the folder was listed (POSIX only), and
// O_NONBLOCK keeps a FIFO swapped in from blocking the open.
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

async function readCapped(path, limit, opened) {
  const file = await open(path, readFlags);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' });
    opened?.set(basename(path), stat);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    return { bytes: buffer.subarray(0, size), tooLarge: size > limit, mode: Number(stat.mode) };
  } finally {
    await file.close();
  }
}

/** Load the Ed25519 private key; refuse a key file other users can read. */
export async function loadSigningKey(path) {
  let read;
  try {
    read = await readCapped(path, maxPemBytes);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('No signing key. Run npm run ledger -- keygen first.');
    throw new Error('Cannot read the signing key file.');
  }
  if (process.platform !== 'win32' && (read.mode & 0o077) !== 0) {
    throw new Error('Other users can read the signing key file. Restrict it with chmod 600.');
  }
  let key;
  try {
    if (read.tooLarge) throw new Error('too large');
    key = createPrivateKey(read.bytes);
  } catch {
    throw new Error('The signing key file does not hold a valid key.');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key is not an Ed25519 key.');
  return key;
}

// --- Signing --------------------------------------------------------------------

/** Build the bundle in memory: file bytes by name, manifest bytes and signature. */
export function buildBundle({ sessionId, markdown, privateKey, now = new Date() }) {
  if (!/^[a-f0-9]{64}$/.test(sessionId)) throw new Error('Invalid session ID.');
  const publicKey = createPublicKey(privateKey);
  const content = [{ name: handoffFile, data: Buffer.from(markdown, 'utf8') }];
  const manifest = {
    format: bundleFormat,
    version: 1,
    algorithm: 'Ed25519',
    created_at: now.toISOString(),
    session: sessionId,
    public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    files: content.map(({ name, data }) => ({ name, bytes: data.length, sha256: sha256Hex(data) })),
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
  const signature = sign(null, manifestBytes, privateKey);
  if (!verify(null, manifestBytes, publicKey, signature)) throw new Error('The new signature did not verify.');
  return {
    files: [
      ...content,
      { name: publicKeyFile, data: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }), 'utf8') },
      { name: manifestFile, data: manifestBytes },
      { name: signatureFile, data: signature },
    ],
    fingerprint: keyFingerprint(publicKey),
  };
}

/** Write a built bundle into a new folder; never overwrite a folder or a file. */
export async function writeBundle(outDir, bundle) {
  // Resolve the existing parent once, so a symlink and '..' in the path cannot make the
  // folder that is created and the folder that is written to differ.
  let target;
  try {
    target = join(await realpath(dirname(outDir)), basename(outDir));
  } catch {
    throw new Error('The parent of the output folder does not exist.');
  }
  let folder;
  try {
    await mkdir(target, { mode: 0o700 });
    folder = await lstat(target, { bigint: true });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('The output folder already exists. Choose a new folder.');
    if (error.code === 'ENOENT') throw new Error('The parent of the output folder does not exist.');
    throw new Error('Cannot create the output folder.');
  }
  const written = [];
  try {
    for (const { name, data } of bundle.files) {
      const path = join(target, name);
      const file = await open(path, 'wx', 0o644);
      try {
        written.push({ path, ino: (await file.stat({ bigint: true })).ino });
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
    }
  } catch {
    // Best effort: remove only the files and the folder this call created, and only while
    // they are still the same files. A run killed midway can still leave a partial folder;
    // verify refuses it, and the sender deletes it and signs again.
    for (const { path, ino } of written) {
      if (await sameFile(path, ino)) await unlink(path).catch(() => {});
    }
    if (await sameFile(target, folder.ino)) await rmdir(target).catch(() => {});
    throw new Error('Cannot write the bundle files.');
  }
}

async function sameFile(path, ino) {
  try {
    return (await lstat(path, { bigint: true })).ino === ino;
  } catch {
    return false;
  }
}

// --- Verification ---------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

// Returns the manifest's public key, or undefined when the manifest is malformed.
function checkManifest(manifest) {
  if (!isPlainObject(manifest) || !sameKeys(manifest, manifestKeys)) return;
  if (manifest.format !== bundleFormat || manifest.version !== 1 || manifest.algorithm !== 'Ed25519') return;
  if (typeof manifest.session !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.session)) return;
  if (typeof manifest.created_at !== 'string' || !createdAtPattern.test(manifest.created_at)) return;
  const created = new Date(manifest.created_at);
  if (Number.isNaN(created.getTime()) || created.toISOString() !== manifest.created_at) return;
  // Version 1 has exactly one content file, handoff.md. A later version that adds files
  // (P4b's redaction report, say) changes the version number.
  if (!Array.isArray(manifest.files) || manifest.files.length !== 1) return;
  for (const entry of manifest.files) {
    if (!isPlainObject(entry) || !sameKeys(entry, ['bytes', 'name', 'sha256'])) return;
    if (entry.name !== handoffFile || !fileNamePattern.test(entry.name)) return;
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return;
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) return;
  }
  if (typeof manifest.public_key !== 'string') return;
  const der = Buffer.from(manifest.public_key, 'base64');
  if (der.toString('base64') !== manifest.public_key) return;
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return;
    if (!key.export({ type: 'spki', format: 'der' }).equals(der)) return;
    return key;
  } catch {
    return;
  }
}

// Reads at most one byte past the signed size, so an inflated file is refused quickly.
async function hashFile(path, opened, signedBytes) {
  const file = await open(path, readFlags);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile()) return;
    opened.set(basename(path), stat);
    if (stat.size !== BigInt(signedBytes)) return { bytes: -1 };
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: signedBytes })) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}

/**
 * Check a bundle folder. Returns { problems, files, fingerprint, createdAt, session };
 * the bundle is good only when problems is empty. Every problem is a fixed message,
 * plus an escaped file name where one is named. `hooks` (afterList, afterRead) exist
 * only so tests can change the folder at fixed points.
 */
export async function verifyBundle(folder, { fingerprint } = {}, hooks = {}) {
  const problems = [];
  const result = { problems };
  const expected = fingerprint === undefined ? undefined : normalizeFingerprint(fingerprint);

  let dir;
  let entries;
  try {
    // Resolve the folder once: join() would otherwise fold 'link/..' differently from
    // the operating system, and the files read could come from another folder.
    dir = await realpath(folder);
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    problems.push('Cannot read the bundle folder.');
    return result;
  }
  const present = new Map(entries.map(entry => [entry.name, entry]));
  // Identity of every file as it was opened, to check the folder did not change meanwhile.
  const opened = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) problems.push('Not a regular file: ' + terminalLabel(entry.name));
  }
  for (const name of envelopeFiles) {
    if (!present.has(name)) problems.push('Missing file: ' + name);
  }
  if (envelopeFiles.some(name => !present.get(name)?.isFile())) return result;
  await hooks.afterList?.(dir);

  let manifestBytes;
  let signature;
  let pem;
  try {
    const manifestRead = await readCapped(join(dir, manifestFile), maxManifestBytes, opened);
    const signatureRead = await readCapped(join(dir, signatureFile), signatureBytes, opened);
    const pemRead = await readCapped(join(dir, publicKeyFile), maxPemBytes, opened);
    if (manifestRead.tooLarge) {
      problems.push('The manifest is too large.');
      return result;
    }
    manifestBytes = manifestRead.bytes;
    signature = signatureRead.tooLarge ? undefined : signatureRead.bytes;
    pem = pemRead.tooLarge ? undefined : pemRead.bytes;
  } catch {
    problems.push('Cannot read the bundle files.');
    return result;
  }

  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    problems.push('The manifest is not valid UTF-8 JSON.');
    return result;
  }
  let canonical;
  try {
    canonical = Buffer.from(canonicalJson(manifest), 'utf8');
  } catch {
    canonical = undefined;
  }
  // Byte equality also refuses a byte-order mark, whitespace, key order and duplicate keys.
  if (!canonical?.equals(manifestBytes)) {
    problems.push('The manifest is not canonical JSON (RFC 8785).');
    return result;
  }
  const publicKey = checkManifest(manifest);
  if (!publicKey) {
    problems.push('The manifest does not match the signed hand-off format.');
    return result;
  }
  if (signature?.length !== signatureBytes || !verify(null, manifestBytes, publicKey, signature)) {
    problems.push('The signature does not match the manifest.');
    return result;
  }

  result.fingerprint = keyFingerprint(publicKey);
  result.createdAt = manifest.created_at;
  result.session = manifest.session;
  result.files = manifest.files.map(({ name, bytes }) => ({ name, bytes }));
  if (expected !== undefined && result.fingerprint.replace(/ /g, '') !== expected) {
    problems.push('The bundle was signed by a different key than the fingerprint names.');
  }
  const expectedPem = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }), 'utf8');
  if (!pem?.equals(expectedPem)) problems.push(publicKeyFile + ' does not match the key in the manifest.');

  const listed = new Set(manifest.files.map(entry => entry.name));
  for (const entry of entries) {
    if (entry.isFile() && !listed.has(entry.name) && !envelopeFiles.includes(entry.name)) {
      problems.push('Unexpected file: ' + terminalLabel(entry.name));
    }
  }
  for (const entry of manifest.files) {
    if (!present.has(entry.name)) {
      problems.push('Missing file: ' + entry.name);
      continue;
    }
    if (!present.get(entry.name).isFile()) continue;
    let actual;
    try {
      actual = await hashFile(join(dir, entry.name), opened, entry.bytes);
    } catch {
      actual = undefined;
    }
    if (actual?.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      problems.push('File changed: ' + entry.name);
    }
  }
  await hooks.afterRead?.(dir);
  if (problems.length === 0 && !(await unchangedSince(dir, entries, opened))) {
    problems.push('The bundle folder changed while it was being verified.');
  }
  return result;
}

// List the folder again: the same names, each still the file that was opened. This
// narrows, but cannot close, the window for a concurrent writer; verify a copy that no
// one else can write for a strong guarantee.
async function unchangedSince(dir, entries, opened) {
  try {
    const again = await readdir(dir);
    if (again.length !== entries.length || again.some(name => !opened.has(name))) return false;
    for (const [name, before] of opened) {
      // Big integers keep 64-bit file IDs exact. On Windows lstat reports dev 0 while
      // fstat reports the volume serial, so dev is compared only elsewhere.
      const now = await lstat(join(dir, name), { bigint: true });
      if (!now.isFile() || now.ino !== before.ino || now.size !== before.size || now.mtimeNs !== before.mtimeNs) {
        return false;
      }
      if (process.platform !== 'win32' && now.dev !== before.dev) return false;
    }
    return true;
  } catch {
    return false;
  }
}
