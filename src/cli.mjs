import { constants, open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { handoffMarkdown } from './handoff.mjs';
import { terminalJson, terminalLine } from './text.mjs';
import { clientToken } from './token.mjs';

const usage = 'Usage: npm run ledger -- search [--provider claude|codex] [--project <slug>] [query]\n' +
  '       npm run ledger -- import --provider claude|codex <file.jsonl>\n' +
  '       npm run ledger -- handoff <session-id>\n' +
  '       npm run ledger -- delete <session-id>\n' +
  '       npm run ledger -- graph publish <packet.json>\n' +
  '       npm run ledger -- graph read <graph-id>\n' +
  '       npm run ledger -- login';
const maxGraphPacketBytes = 8 * 1024 * 1024;

function command(argv) {
  const [action, ...args] = argv;
  if (action === 'search') {
    const { values, positionals } = parseArgs({
      args,
      options: { provider: { type: 'string' }, project: { type: 'string', multiple: true } },
      allowPositionals: true,
    });
    if (values.provider && !['claude', 'codex'].includes(values.provider)) {
      throw new Error('Provider must be claude or codex.');
    }
    // The same rule as the server's, checked here so a bad slug sends no request.
    if (values.project?.length > 1) throw new Error('Give --project once.');
    const [project] = values.project ?? [];
    if (project !== undefined && (project.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(project))) {
      throw new Error('Project must be a slug of at most 64 lowercase letters, digits and single hyphens.');
    }
    const query = new URLSearchParams({ q: positionals.join(' ') });
    if (values.provider) query.set('provider', values.provider);
    if (project) query.set('project', project);
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
  if (action === 'login' && args.length === 0) return { action, path: '/api/login', login: true };
  if (action === 'handoff' && args.length === 1 && /^[a-f0-9]{64}$/.test(args[0])) {
    return { action, path: '/api/sessions/' + args[0] };
  }
  if (action === 'delete' && args.length === 1 && /^[a-f0-9]{64}$/.test(args[0])) {
    return { action, path: '/api/sessions/' + args[0], sessionId: args[0] };
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

// Fixed sentences: they never name the token or the file's path.
const noToken = 'Cannot read the Context Ledger access token. Start the ledger with npm start, and run this with the same PORT and CONTEXT_LEDGER_DB as the ledger.';
const exposedToken = 'The Context Ledger access token file can be read by other users, so it was not used. Restart the ledger to write a private one.';
const refusedToken = 'Context Ledger refused the access token. Check that PORT and CONTEXT_LEDGER_DB match the running ledger.';
const tokenForOtherPort = other => `The Context Ledger access token is for the ledger on port ${other}, so it was not sent. Set PORT to ${other}, or use the CONTEXT_LEDGER_DB of the ledger on this port.`;

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
  const { action, path, packetPath, login, sessionId, provider, filePath } = command(process.argv.slice(2));
  // Card I1: a file import opens the database itself, so it needs no running server or token.
  if (action === 'import') return importFile(provider, filePath);
  const port = Number(process.env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const origin = `http://127.0.0.1:${port}`;
  // The token goes only to the port its file names. Without it the request still goes
  // out, so a ledger that is not running gives the "Cannot reach" message.
  const { token, otherPort, exposed } = await clientToken(port);
  const headers = token === undefined ? {} : { Authorization: `Bearer ${token}` };
  // A token file others can read is not used, and nothing is sent.
  if (exposed) throw new Error(exposedToken);
  const withoutToken = otherPort !== undefined ? tokenForOtherPort(otherPort) : noToken;
  // A graph packet or a delete is not sent where the token does not go: the listener on
  // this port is not known to be the ledger.
  if ((packetPath !== undefined || action === 'delete') && token === undefined) throw new Error(withoutToken);
  let write = login ? { method: 'POST' } : {};
  if (packetPath !== undefined) {
    write = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: await readGraphPacket(packetPath) };
  } else if (action === 'delete') {
    write = { method: 'DELETE', headers: { Origin: origin } };
  }
  let response;
  try {
    response = await fetch(origin + path, {
      ...write,
      headers: { ...write.headers, ...headers },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    if (action === 'delete' && error?.name === 'TimeoutError') {
      throw new Error('Context Ledger did not answer within 5 seconds. The session may or may not be deleted; search to check.');
    }
    throw new Error(`Cannot reach Context Ledger on port ${port}. Start it with npm start.`);
  }
  if (response.status === 401) throw new Error(token !== undefined ? refusedToken : withoutToken);
  if (login) {
    const data = response.ok ? await response.json().catch(() => null) : null;
    // Print only a link of the expected shape, so nothing else reaches the terminal.
    if (typeof data?.path !== 'string' || !/^\/login\?code=[A-Za-z0-9_-]{43}$/u.test(data.path)) {
      throw new Error(`Context Ledger returned HTTP ${response.status}.`);
    }
    console.log(`Open this link in your browser within a minute (it works once): ${origin}${data.path}`);
    return;
  }
  if (response.status === 404) throw new Error(action === 'graph' ? 'Graph not found.' : 'Session not found.');
  if (!response.ok) {
    if (action === 'graph' && (response.status === 400 || response.status === 413)) {
      const problem = await response.json().catch(() => null);
      if (typeof problem?.error === 'string' && problem.error.length <= 160 && !/\p{C}/u.test(problem.error)) {
        throw new Error(problem.error);
      }
    }
    if (action === 'delete' && response.status === 409) {
      // Built from the count alone, so no text from the server reaches the terminal.
      const problem = await response.json().catch(() => null);
      const graphs = problem?.graphs;
      if (Number.isSafeInteger(graphs) && graphs > 0) {
        throw new Error(`Session is cited by ${graphs} ${graphs === 1 ? 'graph' : 'graphs'}, so it was not deleted.`);
      }
      if (problem?.journalMode === 'wal' || problem?.journalMode === 'persist') {
        throw new Error('The ledger database does not use the default rollback journal, so the session was not deleted.');
      }
    }
    throw new Error(`Context Ledger returned HTTP ${response.status}.`);
  }
  // A JSON parse error quotes the body, which is the server's text: never print it.
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Context Ledger returned an unexpected response.');
  }
  if (action === 'delete') {
    if (data?.deleted !== sessionId) throw new Error('Context Ledger returned an unexpected response.');
    console.log(`Deleted session ${sessionId}.`);
    return;
  }
  if (action === 'graph') {
    console.log(terminalJson(data));
    return;
  }
  console.log(action === 'search' ? terminalJson(data.sessions) : handoffMarkdown(data.session));
}

main().catch(error => {
  // The usage text is ours and spans lines; any other message is escaped onto one line, in
  // case it ever carries text from the command line or a file.
  console.error(error.message === usage ? usage : terminalLine(error.message));
  process.exitCode = 1;
});
