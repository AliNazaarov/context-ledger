import { constants, open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { handoffMarkdown } from './handoff.mjs';
import { redactSession } from './secrets.mjs';
import { inlineText, terminalJson } from './text.mjs';

const usage = 'Usage: npm run ledger -- search [--provider claude|codex] [query]\n' +
  '       npm run ledger -- handoff <session-id>\n' +
  '       npm run ledger -- redact <session-id> [--json | --text]\n' +
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
  // Card P4b: report what in a session looks like a secret, without showing any value.
  if (action === 'redact' && args.length >= 1 && args.length <= 2 && /^[a-f0-9]{64}$/.test(args[0])) {
    const format = args[1] === undefined ? 'report' : { '--json': 'json', '--text': 'text' }[args[1]];
    if (format) return { action, format, path: '/api/sessions/' + args[0] };
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

/** Card P4b: the redaction report, the findings as JSON, or the redacted hand-off. */
function redactionOutput(session, format) {
  const { session: redacted, findings } = redactSession(session);
  if (format === 'text') return handoffMarkdown(redacted);
  const lines = new Set(findings.map(finding => finding.line)).size;
  if (format === 'json') return terminalJson({ sessionId: session.id, count: findings.length, lines, findings });
  const rows = findings.map(finding => `line ${finding.line}  ${finding.kind}  ${finding.length} characters  ${inlineText(finding.preview)}`);
  const total = findings.length
    ? `${findings.length} possible ${findings.length === 1 ? 'secret' : 'secrets'} in ${lines} ${lines === 1 ? 'line' : 'lines'}. Values are not shown; use --text for the redacted hand-off.`
    : 'No secrets found.';
  return [...rows, total].join('\n');
}

async function main() {
  const { action, path, packetPath, format } = command(process.argv.slice(2));
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
  if (action === 'redact') {
    console.log(redactionOutput(data.session, format));
    return;
  }
  console.log(action === 'search' ? terminalJson(data.sessions) : handoffMarkdown(data.session));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
