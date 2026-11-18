import { createHash } from 'node:crypto';
import { constants, open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { handoffMarkdown } from './handoff.mjs';
import { terminalJson } from './text.mjs';

const usage = 'Usage: npm run ledger -- search [--provider claude|codex] [query]\n' +
  '       npm run ledger -- handoff <session-id>\n' +
  '       npm run ledger -- graph publish <packet.json>\n' +
  '       npm run ledger -- graph read <graph-id>\n' +
  '       npm run ledger -- import-t3 <copy-of-statev2.sqlite> [--thread <id>] [--list]';
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

function ledgerPort() {
  const port = Number(process.env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  return port;
}

// A server message is shown only when it is short, fixed-looking text.
function serverProblem(problem) {
  if (typeof problem?.error === 'string' && problem.error.length <= 160 && !/\p{C}/u.test(problem.error)) return problem.error;
}

// Messages the store can give for an import (src/store.mjs). Any other text from the
// server is replaced by a fixed sentence, so the CLI never prints what it did not write.
const knownImportProblems = new Set([
  'No supported conversation messages found.',
  'Invalid transcript file name.',
  'Transcript must be JSONL text.',
]);

/** One import request. Returns { session }, { refused }, or { lost, reached } when the outcome is unknown. */
async function postImport(port, request, maxBytes) {
  const origin = `http://127.0.0.1:${port}`;
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > maxBytes) return { refused: 'This T3 thread is larger than the 8 MiB import limit.' };
  let response;
  let text;
  try {
    response = await fetch(origin + '/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    // Reading the body is part of the exchange: a drop here leaves the outcome unknown.
    text = await response.text();
  } catch {
    return { lost: true, reached: response !== undefined };
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Handled below as an unexpected response.
  }
  if (response.status === 413) return { refused: 'This T3 thread is larger than the 8 MiB import limit.' };
  if (response.status === 400) {
    const problem = data?.error;
    return { refused: knownImportProblems.has(problem) ? problem : 'Context Ledger refused this T3 thread.' };
  }
  if (!response.ok) return { refused: `Context Ledger returned HTTP ${response.status}.` };
  // The store names a session by this hash (src/store.mjs). It keeps the source of the first
  // import of the same transcript, so the source is not compared.
  const expectedId = createHash('sha256').update(`${request.provider}\0`).update(request.transcript).digest('hex');
  const session = data?.session;
  if (session?.id !== expectedId || session.provider !== request.provider || typeof session.source !== 'string') {
    return { refused: 'Context Ledger returned an unexpected response.' };
  }
  return { session };
}

// Imports T3 Code threads from a copy of T3's database that the person names. Read-only;
// the copy is never looked for (src/t3code.mjs, docs/evals.md D3).
async function importT3(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { thread: { type: 'string' }, list: { type: 'boolean' } },
      allowPositionals: true,
    });
  } catch {
    throw new Error(usage);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw new Error(usage);
  // Loaded here so the other commands do not load node:sqlite and print its warning.
  const { maxImportBytes, openT3Copy, threadIdPattern } = await import('./t3code.mjs');
  if (values.thread !== undefined && !threadIdPattern.test(values.thread)) {
    throw new Error('A T3 thread ID is 1 to 128 letters, digits, hyphens or underscores.');
  }
  const port = values.list ? undefined : ledgerPort();
  const unreachable = `Cannot reach Context Ledger on port ${port}. Start it with npm start.`;

  const copy = openT3Copy(positionals[0]);
  try {
    const threads = copy.threads(values.thread);
    if (values.list) {
      console.log(terminalJson(threads.map(thread => copy.summary(thread))));
      return;
    }
    const imported = [];
    const refused = [];
    const unknown = [];
    let answered = false;
    for (const [index, thread] of threads.entries()) {
      const request = copy.importRequest(thread);
      const result = request.refusal ? { refused: request.refusal } : await postImport(port, request, maxImportBytes);
      if (result.lost) {
        if (!answered && !result.reached) throw new Error(unreachable);
        // The server may have stored it before the connection dropped. Importing again is
        // safe: the same thread gives the same session.
        unknown.push({ thread: thread.id, unknown: 'The connection to Context Ledger was lost; this thread may not be imported.' });
        for (const rest of threads.slice(index + 1)) unknown.push({ thread: rest.id, unknown: 'Not tried after the connection was lost.' });
        break;
      }
      if (!request.refusal) answered = true;
      if (result.session) imported.push({ thread: thread.id, agent: request.provider, session: result.session });
      else refused.push({ thread: thread.id, refused: result.refused });
    }
    if (values.thread !== undefined && refused.length > 0) throw new Error(refused[0].refused);
    console.log(terminalJson({ imported, refused, ...(unknown.length ? { unknown } : {}) }));
    if (unknown.length > 0) console.error(unreachable + ' Run the same import again to finish; it does not import a thread twice.');
    if (refused.length > 0 || unknown.length > 0) process.exitCode = 1;
  } finally {
    copy.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'import-t3') return importT3(argv.slice(1));
  const { action, path, packetPath } = command(argv);
  const port = ledgerPort();
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
      const message = serverProblem(await response.json().catch(() => null));
      if (message) throw new Error(message);
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
  console.error(error.message);
  process.exitCode = 1;
});
