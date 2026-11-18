import { constants, open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { handoffMarkdown } from './handoff.mjs';
import {
  buildBundle, generateSigningKey, loadSigningKey, normalizeFingerprint, signingKeyPath, verifyBundle, writeBundle,
} from './sign.mjs';
import { inlineText, terminalJson } from './text.mjs';

const usage = 'Usage: npm run ledger -- search [--provider claude|codex] [query]\n' +
  '       npm run ledger -- handoff <session-id> [--sign <new-folder>]\n' +
  '       npm run ledger -- keygen\n' +
  '       npm run ledger -- verify <folder> [--fingerprint <fingerprint>]\n' +
  '       npm run ledger -- graph publish <packet.json>\n' +
  '       npm run ledger -- graph read <graph-id>';
const maxGraphPacketBytes = 8 * 1024 * 1024;

// parseArgs errors quote the user's argument, so they are replaced by the usage text.
function options(args, spec) {
  try {
    return parseArgs({ args, options: spec, allowPositionals: true, strict: true });
  } catch {
    throw new Error(usage);
  }
}

function command(argv) {
  const [action, ...args] = argv;
  if (action === 'keygen' && args.length === 0) return { action };
  if (action === 'verify') {
    const { values, positionals } = options(args, { fingerprint: { type: 'string' } });
    if (positionals.length === 1) {
      const fingerprint = values.fingerprint === undefined ? undefined : normalizeFingerprint(values.fingerprint);
      return { action, dir: positionals[0], fingerprint };
    }
  }
  if (action === 'search') {
    const { values, positionals } = parseArgs({
      args,
      options: { provider: { type: 'string' } },
      allowPositionals: true,
    });
    if (values.provider && !['claude', 'codex'].includes(values.provider)) {
      throw new Error('Provider must be claude or codex.');
    }
    const query = new URLSearchParams({ q: positionals.join(' ') });
    if (values.provider) query.set('provider', values.provider);
    return { action, path: '/api/sessions?' + query };
  }
  if (action === 'handoff') {
    const { values, positionals } = options(args, { sign: { type: 'string' } });
    if (positionals.length === 1 && /^[a-f0-9]{64}$/.test(positionals[0]) && values.sign !== '') {
      return { action, path: '/api/sessions/' + positionals[0], sessionId: positionals[0], signDir: values.sign };
    }
  }
  if (action === 'graph' && args.length === 2) {
    const [operation, value] = args;
    if (operation === 'publish') return { action, path: '/api/graphs', packetPath: value };
    if (operation === 'read' && /^[a-f0-9]{64}$/.test(value)) {
      return { action, path: '/api/graphs/' + value };
    }
  }
  throw new Error(usage);
}

async function readGraphPacket(packetPath) {
  let file;
  try {
    file = await open(packetPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Graph packet must be a regular file.');
    if (stat.size > maxGraphPacketBytes) throw new Error('Graph packet exceeds 8 MiB.');

    // Keep the limit if the file grows between stat and read.
    const buffer = Buffer.allocUnsafe(maxGraphPacketBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxGraphPacketBytes) throw new Error('Graph packet exceeds 8 MiB.');
    return buffer.subarray(0, size);
  } catch (error) {
    if (error.code) throw new Error('Cannot read graph packet file.');
    throw error;
  } finally {
    await file?.close();
  }
}

async function verifyCommand(dir, fingerprint) {
  const { problems, files, createdAt, session, fingerprint: signer } = await verifyBundle(dir, { fingerprint });
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    throw new Error('Verification failed.');
  }
  const listed = files.map(({ name, bytes }) => name + ' (' + bytes + ' bytes)').join(', ');
  console.log('Verified: ' + listed + '.\nSession: ' + session + '\nSigned: ' + createdAt +
    '\nKey fingerprint: ' + signer);
  if (fingerprint === undefined) {
    console.error('Warning: the key was not checked. Ask the sender for the key fingerprint ' +
      'and run verify again with --fingerprint.');
  }
}

async function main() {
  const { action, path, packetPath, sessionId, signDir, dir, fingerprint } = command(process.argv.slice(2));
  if (action === 'keygen') {
    console.log(await generateSigningKey(signingKeyPath()));
    return;
  }
  if (action === 'verify') {
    await verifyCommand(dir, fingerprint);
    return;
  }
  // Load the key first, so a missing key fails before anything is fetched or written.
  const privateKey = signDir === undefined ? undefined : await loadSigningKey(signingKeyPath());
  const port = Number(process.env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const origin = `http://127.0.0.1:${port}`;
  const publish = packetPath === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: await readGraphPacket(packetPath),
  };
  let response;
  try {
    response = await fetch(origin + path, {
      ...publish,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error(`Cannot reach Context Ledger on port ${port}. Start it with npm start.`);
  }
  if (response.status === 404) throw new Error(action === 'graph' ? 'Graph not found.' : 'Session not found.');
  if (!response.ok) {
    if (action === 'graph' && (response.status === 400 || response.status === 413)) {
      const problem = await response.json().catch(() => null);
      if (typeof problem?.error === 'string' && problem.error.length <= 160 && !/\p{C}/u.test(problem.error)) {
        throw new Error(problem.error);
      }
    }
    throw new Error(`Context Ledger returned HTTP ${response.status}.`);
  }
  const data = await response.json();
  if (action === 'graph') {
    console.log(terminalJson(data));
    return;
  }
  if (privateKey) {
    if (data.session?.id !== sessionId) throw new Error('Context Ledger returned a different session.');
    const bundle = buildBundle({ sessionId, markdown: handoffMarkdown(data.session) + '\n', privateKey });
    await writeBundle(signDir, bundle);
    console.log('Signed hand-off written to ' + inlineText(signDir) + '\nKey fingerprint: ' + bundle.fingerprint);
    return;
  }
  console.log(action === 'search' ? terminalJson(data.sessions) : handoffMarkdown(data.session));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
