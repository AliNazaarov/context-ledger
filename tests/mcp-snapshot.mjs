// Print the adapter's answers that need no ledger, one JSON-RPC line each, sorted by id:
// initialize for each protocol version, tools/list, ping and fixed error replies.
// Compare two checkouts byte for byte, for example before and after moving code:
//   node tests/mcp-snapshot.mjs <old checkout> > before.jsonl
//   node tests/mcp-snapshot.mjs <new checkout> > after.jsonl
//   cmp before.jsonl after.jsonl
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
// Port 1 is never a ledger; none of these requests reaches one.
const child = spawn(process.execPath, ['src/mcp.mjs'], { cwd: root, env: { ...process.env, PORT: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
const requests = [
  { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
  { id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
  { id: 3, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {} } },
  { id: 4, method: 'tools/list' },
  { id: 5, method: 'ping' },
  { id: 6, method: 'nope' },
  { id: 7, method: 'tools/call', params: { name: 'nope' } },
  { id: 8, method: 'tools/call', params: { name: 'graph_read', arguments: { graphId: 'x' } } },
  { id: 9, method: 'tools/call', params: { name: 'graph_read', arguments: { bogus: 1 } } },
  { id: 10, method: 'tools/call', params: { name: 'graph_list', arguments: { party: '--' } } },
  { id: 11, method: 'tools/call', params: { name: 'graph_schema', arguments: { version: 1 } } },
];
let output = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => { output += chunk; });
child.stdin.end(requests.map(request => JSON.stringify({ jsonrpc: '2.0', ...request })).join('\n') + '\nnot json\n');
child.on('exit', code => {
  const lines = output.split('\n').filter(Boolean);
  lines.sort((a, b) => (JSON.parse(a).id ?? 0) - (JSON.parse(b).id ?? 0));
  process.stdout.write(lines.join('\n') + '\n');
  if (code !== 0 || lines.length !== requests.length + 1) process.exitCode = 1;
});
