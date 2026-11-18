import { constants, open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { handoffMarkdown } from './handoff.mjs';
import { terminalJson } from './text.mjs';
import { clientTokenFile, readTokenFile } from './token.mjs';

const usage = 'Usage: npm run ledger -- search [--provider claude|codex] [query]\n' +
  '       npm run ledger -- handoff <session-id>\n' +
  '       npm run ledger -- graph publish <packet.json>\n' +
  '       npm run ledger -- graph read <graph-id>\n' +
  '       npm run ledger -- login';
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
  if (action === 'login' && args.length === 0) return { action, path: '/api/login', login: true };
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

// Fixed sentences: they never name the token or the file's path.
const noToken = 'Cannot read the Context Ledger access token. Start the ledger with npm start, and run this with the same CONTEXT_LEDGER_DB as the ledger.';
const refusedToken = 'Context Ledger refused the access token. Check that PORT and CONTEXT_LEDGER_DB match the running ledger.';

async function main() {
  const { action, path, packetPath, login } = command(process.argv.slice(2));
  const port = Number(process.env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const origin = `http://127.0.0.1:${port}`;
  const token = await readTokenFile(clientTokenFile());
  // Without a readable token the request still goes out, so a ledger that is not
  // running gives the "Cannot reach" message and a running one gives noToken.
  const headers = token === undefined ? {} : { Authorization: `Bearer ${token}` };
  const write = packetPath === undefined ? (login ? { method: 'POST' } : {}) : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: await readGraphPacket(packetPath),
  };
  let response;
  try {
    response = await fetch(origin + path, {
      ...write,
      headers: { ...write.headers, ...headers },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error(`Cannot reach Context Ledger on port ${port}. Start it with npm start.`);
  }
  if (response.status === 401) throw new Error(token === undefined ? noToken : refusedToken);
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
