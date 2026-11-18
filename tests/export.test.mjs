import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportNodeId } from '../src/export.mjs';
import { openStore } from '../src/store.mjs';

// Card G12: a decision graph as node-link JSON for code-graph tools. Synthetic data only.
const say = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const idPattern = /^[a-z0-9_]+$/u;

function twoParties(store, { leoParty = 'leo' } = {}) {
  const aliSession = store.importTranscript({ provider: 'codex', source: 'ali.jsonl', transcript: JSON.stringify({
    type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'GPU time. Which port?' }] },
  }) });
  const ali = store.publishGraph({ version: 2, sessionId: aliSession.id, party: 'ali', edges: [], nodes: [
    { id: 'gpu-time', kind: 'offer', label: 'GPU time', evidenceLines: [1] },
    { id: 'which-port', kind: 'question', to: leoParty, status: 'open', label: 'Which port?', evidenceLines: [1] },
  ] });
  const leoSession = store.importTranscript({ provider: 'claude', source: 'leo-orbit.jsonl', transcript: [
    say('First plan: port 4400.'), say('Port 4317 now. Pair on the adapter. Record the demo.'),
  ].join('\n') });
  const leo = store.publishGraph({ version: 2, sessionId: leoSession.id, party: leoParty,
    nodes: [
      { id: 'port', kind: 'decision', label: 'Use port 4317', evidenceLines: [2] },
      { id: 'old-port', kind: 'decision', label: 'Use port 4400', evidenceLines: [1] },
      { id: 'pairing', kind: 'offer', label: 'Pair on the adapter', evidenceLines: [2] },
      { id: 'record', kind: 'action', status: 'pending', label: 'Record the demo', evidenceLines: [1, 2] },
      { id: 'demo', kind: 'goal', label: 'Demo live', evidenceLines: [2] },
    ],
    edges: [{ from: 'port', to: 'old-port', type: 'supersedes' }, { from: 'record', to: 'demo', type: 'advances' }],
    links: [{ from: 'port', graph: ali.id, to: 'which-port', type: 'answers' }, { from: 'pairing', graph: ali.id, to: 'gpu-time', type: 'matches' }],
  });
  return { ali, leo };
}

test('the export is undirected node-link JSON with one node per graph node and one link per edge and cross-graph link', () => {
  const store = openStore(':memory:');
  const { ali, leo } = twoParties(store);
  const out = store.exportGraph(leo.id);
  assert.equal(out.directed, false, 'Graphify merges into an undirected graph');
  assert.equal(out.multigraph, false);
  assert.deepEqual(out.graph, { source: 'context-ledger', ledger_graph: leo.id, party: 'leo', session: leo.packet.sessionId, source_file: 'leo-orbit.jsonl' });
  assert.equal(out.nodes.length, 5);
  assert.deepEqual(out.nodes.find(node => node.ledger_node === 'record'), {
    id: 'ctm_leo__record', label: 'Record the demo', file_type: 'concept', source_file: 'leo-orbit.jsonl', source_location: 'L1, L2',
    kind: 'action', status: 'pending', ledger_graph: leo.id, ledger_node: 'record',
  });
  assert.equal(out.nodes.find(node => node.ledger_node === 'old-port').id, 'ctm_leo__old_port');
  assert.equal(out.nodes.find(node => node.ledger_node === 'port').file_type, 'rationale');
  const relations = out.links.map(link => [link.ledger_from, link.ledger_to, link.relation]);
  assert.deepEqual(relations.sort(), [
    ['ctm_leo__pairing', 'ctm_ali__gpu_time', 'matches'],
    ['ctm_leo__port', 'ctm_ali__which_port', 'answers'],
    ['ctm_leo__port', 'ctm_leo__old_port', 'supersedes'],
    ['ctm_leo__record', 'ctm_leo__demo', 'advances'],
  ]);
  for (const link of out.links) {
    assert.deepEqual([link.source, link.target], [link.ledger_from, link.ledger_to]);
    assert.equal(link.confidence, 'EXTRACTED');
    assert.equal(link.weight, 1);
  }
  // Every end is a node of this export or of the other party's.
  const aliOut = store.exportGraph(ali.id);
  const known = new Set([...out.nodes, ...aliOut.nodes].map(node => node.id));
  for (const link of out.links) assert.ok(known.has(link.source) && known.has(link.target), JSON.stringify(link));
  assert.equal(out.links.find(link => link.relation === 'answers').ledger_graph, ali.id);
  assert.deepEqual(store.exportGraph(leo.id), out, 'the same IDs every time');
  for (const node of [...out.nodes, ...aliOut.nodes]) assert.match(node.id, idPattern);
  assert.equal(store.exportGraph('e'.repeat(64)), undefined);
  store.close();
});

test('a hyphen in the party or the node never makes two names one', () => {
  const party = (name, sessionId = 'a'.repeat(64)) => ({ party: name, sessionId });
  assert.notEqual(exportNodeId(party('leo-x'), 'y'), exportNodeId(party('leo'), 'x-y'));
  assert.equal(exportNodeId(party('leo-x'), 'y'), 'ctm_leo_x__y');
  assert.equal(exportNodeId(party('leo'), 'x-y'), 'ctm_leo__x_y');
  assert.equal(exportNodeId({ sessionId: 'abcdef0123'.padEnd(64, '0') }, 'goal-1'), 'ctm_session_abcdef01__goal_1', 'version 1: the session namespace');
  const store = openStore(':memory:');
  const { leo } = twoParties(store, { leoParty: 'leo-x' });
  for (const node of store.exportGraph(leo.id).nodes) assert.match(node.id, /^ctm_leo_x__[a-z0-9_]+$/u);
  store.close();
});

test('a version 1 graph exports in its session namespace', () => {
  const store = openStore(':memory:');
  const session = store.importTranscript({ provider: 'claude', source: 'v1.jsonl', transcript: say('Ship it, then test.') });
  const graph = store.publishGraph({ version: 1, sessionId: session.id, edges: [],
    nodes: [{ id: 'ship', kind: 'goal', label: 'Ship it', evidenceLines: [1] }] });
  const out = store.exportGraph(graph.id);
  assert.deepEqual(out.nodes.map(node => node.id), [`ctm_session_${session.id.slice(0, 8)}__ship`]);
  assert.equal('party' in out.graph, false);
  store.close();
});

async function startServer(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-g12-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(dir, 'ledger.sqlite') }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at http:\/\/127\.0\.0\.1:(\d+)/u);
    if (match) return { origin: `http://127.0.0.1:${match[1]}`, port: match[1] };
  }
  throw new Error('server did not start');
}

test('the export route and the CLI: fixed refusals, escaped output that parses back', async t => {
  const { origin, port } = await startServer(t);
  const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })
    .then(response => response.json());
  const rlo = String.fromCodePoint(0x202e);
  const { session } = await post('/api/import', { provider: 'claude', source: `odd${rlo}name.jsonl`, transcript: say('Port 4317.') });
  const { graph } = await post('/api/graphs', { version: 2, sessionId: session.id, party: 'leo', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: 'Use port 4317', evidenceLines: [1] }] });
  const get = query => fetch(`${origin}/api/graphs/${graph.id}/export${query}`).then(async response => ({ status: response.status, body: await response.json() }));
  const plain = await get('');
  const named = await get('?format=node-link');
  assert.equal(plain.status, 200);
  assert.deepEqual(named.body, plain.body);
  for (const query of ['?format=graphml', '?format=node-link&format=node-link', '?format=node-link&x=1', '?x=1']) {
    assert.deepEqual(await get(query), { status: 400, body: { error: 'The export takes format=node-link or no parameter.' } }, query);
  }
  const missing = await fetch(`${origin}/api/graphs/${'e'.repeat(64)}/export`);
  assert.equal(missing.status, 404);

  const cli = spawnSync(process.execPath, ['src/cli.mjs', 'graph', 'export', graph.id], { env: { ...process.env, PORT: port }, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(!cli.stdout.includes(rlo), 'the bidi control in the file name is escaped');
  assert.ok(cli.stdout.includes(`odd${String.fromCodePoint(0x5c)}u202ename.jsonl`));
  assert.deepEqual(JSON.parse(cli.stdout), plain.body.export, 'escaped JSON parses back to the same export');
  const bad = spawnSync(process.execPath, ['src/cli.mjs', 'graph', 'export', 'nope'], { env: { ...process.env, PORT: port }, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage:/u);
});
