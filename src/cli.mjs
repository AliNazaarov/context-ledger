import { constants, open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { handoffMarkdown } from './handoff.mjs';
import { inlineText, terminalJson } from './text.mjs';

const usage = 'Usage: npm run ledger -- search [--provider claude|codex] [query]\n' +
  '       npm run ledger -- import --provider claude|codex <file.jsonl>\n' +
  '       npm run ledger -- handoff <session-id>\n' +
  '       npm run ledger -- graph publish <packet.json>\n' +
  '       npm run ledger -- graph read <graph-id>';
const maxGraphPacketBytes = 8 * 1024 * 1024;

function command(argv) {
  const [action, ...args] = argv;
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
  if (action === 'import') {
    let parsed;
    try {
      parsed = parseArgs({ args, options: { provider: { type: 'string' } }, allowPositionals: true });
    } catch {
      // parseArgs quotes the bad option in its message, so print the usage instead.
      throw new Error(usage);
    }
    const { values, positionals } = parsed;
    if (!['claude', 'codex'].includes(values.provider)) throw new Error('Provider must be claude or codex.');
    if (positionals.length !== 1) throw new Error(usage);
    return { action, provider: values.provider, filePath: positionals[0] };
  }
  if (action === 'handoff' && args.length === 1 && /^[a-f0-9]{64}$/.test(args[0])) {
    return { action, path: '/api/sessions/' + args[0] };
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

/**
 * Card I1: import a transcript file straight into the ledger database, read as a stream,
 * so files over the 8 MiB HTTP limit can be imported. The server need not be running.
 */
async function importFile(provider, filePath) {
  const { openStore, InputError } = await import('./store.mjs');
  let store;
  try {
    store = openStore(process.env.CONTEXT_LEDGER_DB ?? '.context-ledger/ledger.sqlite');
  } catch {
    // The underlying error names the database path, so it is not shown.
    throw new Error('Cannot open the ledger database.');
  }
  try {
    const { skipped, ...session } = await store.importTranscriptFile({ provider, path: filePath });
    console.log(terminalJson(skipped ? { session, skipped } : { session }));
  } catch (error) {
    // Store messages are fixed sentences; anything else may carry a path, so it is not shown.
    throw error instanceof InputError ? error : new Error('Import failed.');
  } finally {
    try { store.close(); } catch { /* the import result or error above is what matters */ }
  }
}

async function main() {
  const { action, path, packetPath, provider, filePath } = command(process.argv.slice(2));
  if (action === 'import') return importFile(provider, filePath);
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
  console.log(action === 'search' ? terminalJson(data.sessions) : handoffMarkdown(data.session));
}

main().catch(error => {
  // Escaped, in case a message ever carries text from the command line or a file.
  console.error(error.message.split('\n').map(inlineText).join('\n'));
  process.exitCode = 1;
});
