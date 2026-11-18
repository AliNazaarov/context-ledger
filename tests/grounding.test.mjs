import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { groundNodes, nodeGrounding } from '../src/grounding.mjs';
import { openStore } from '../src/store.mjs';

// Card G7: quoted or inferred nodes. Synthetic transcripts only.
const say = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const transcript = [
  say('Change of plan: the ledger stays on port 4317.'),
  say('If the upload fails, retry a few times.'),
  say('The retry limit is 5 attempts.'),
].join('\n');

function publish(store, version = 2) {
  const session = store.importTranscript({ provider: 'claude', source: 'orbit.jsonl', transcript });
  const nodes = [
    { id: 'port', kind: 'decision', label: 'Use port 4317', evidenceLines: [1] },
    // The 5 is on line 3, but the node cites line 2: only cited lines count.
    { id: 'retry', kind: 'decision', label: 'Retry 5 times', evidenceLines: [2] },
    { id: 'limit', kind: 'constraint', label: 'Retry limit is 5', evidenceLines: [3] },
  ];
  const packet = version === 2
    ? { version: 2, sessionId: session.id, party: 'leo', nodes, edges: [] }
    : { version: 1, sessionId: session.id, nodes, edges: [] };
  return { session, graph: store.publishGraph(packet) };
}

test('publishing marks each node quoted or inferred from its cited lines only', () => {
  const store = openStore(':memory:');
  const { graph } = publish(store);
  // Canonical v2 order: constraints before decisions, then by ID.
  assert.deepEqual(graph.quotedNodeIds, ['limit', 'port']);
  assert.deepEqual(graph.inferredNodeIds, ['retry']);
  assert.deepEqual(store.getGraph(graph.id).inferredNodeIds, ['retry']);
  assert.equal(nodeGrounding(graph, 'port'), 'quoted');
  assert.equal(nodeGrounding(graph, 'retry'), 'inferred');
  assert.equal(nodeGrounding(graph, 'missing'), null);
  assert.equal(nodeGrounding({ packet: graph.packet }, 'port'), null, 'an unmarked graph is unmarked, not inferred');
  store.close();
});

test('version 1 graphs are marked too, in their stored order', () => {
  const store = openStore(':memory:');
  const { graph } = publish(store, 1);
  assert.deepEqual(graph.quotedNodeIds, ['port', 'limit']);
  assert.deepEqual(graph.inferredNodeIds, ['retry']);
  store.close();
});

test('a node citing several lines is quoted when the facts are anywhere in them', () => {
  const messages = [{ line: 2, text: 'retry a few times' }, { line: 3, text: 'the limit is 5' }];
  const packet = { nodes: [{ id: 'a', label: 'Retry 5 times', evidenceLines: [2, 3] }, { id: 'b', label: 'Retry 7 times', evidenceLines: [2, 3] }] };
  assert.deepEqual(groundNodes(packet, messages), { quotedNodeIds: ['a'], inferredNodeIds: ['b'] });
});

test('context_for marks inferred nodes and explains the mark once', () => {
  const store = openStore(':memory:');
  const { graph } = publish(store);
  const { text } = store.getGraphContext(graph.id);
  assert.match(text, /^- retry: Retry 5 times \(L2, inferred\)$/mu);
  assert.match(text, /^- port: Use port 4317 \(L1\)$/mu);
  assert.equal(text.match(/"inferred" means/gu).length, 1);
  store.close();
});

test('a graph with only quoted nodes briefs exactly as before G7', () => {
  const store = openStore(':memory:');
  const session = store.importTranscript({ provider: 'claude', source: 'orbit.jsonl', transcript });
  const graph = store.publishGraph({
    version: 2, sessionId: session.id, party: 'leo',
    nodes: [{ id: 'port', kind: 'decision', label: 'Use port 4317', evidenceLines: [1] }], edges: [],
  });
  const marked = store.getGraphContext(graph.id).text;
  assert.doesNotMatch(marked, /inferred/u);
  store.close();
});

test('a graph stored before G7 gets its marks when the same packet is published again', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-g7-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.sqlite');
  let store = openStore(path);
  const { graph } = publish(store);
  store.close();

  // Make the row look like one written before G7: no marks.
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE graphs SET payload = json_remove(payload, '$.quotedNodeIds', '$.inferredNodeIds') WHERE id = ?").run(graph.id);
  const before = raw.prepare('SELECT rowid, created_at AS createdAt FROM graphs WHERE id = ?').get(graph.id);
  raw.close();

  store = openStore(path);
  const old = store.getGraph(graph.id);
  assert.equal(old.quotedNodeIds, undefined);
  assert.doesNotMatch(store.getGraphContext(graph.id).text, /inferred/u, 'unmarked is not shown as inferred');
  assert.equal(store.openRoom({ graphIds: [graph.id, otherGraph(store).id] }).parties
    .find(party => party.party === 'leo').nodes.every(node => node.grounding === null), true);

  const again = store.publishGraph(graph.packet);
  assert.equal(again.id, graph.id);
  assert.deepEqual(again.inferredNodeIds, ['retry']);
  assert.deepEqual(store.getGraph(graph.id).quotedNodeIds, ['limit', 'port']);
  store.close();

  const check = new DatabaseSync(path);
  assert.deepEqual({ ...check.prepare('SELECT rowid, created_at AS createdAt FROM graphs WHERE id = ?').get(graph.id) }, { ...before });
  assert.equal(check.prepare('SELECT count(*) AS n FROM graphs').get().n, 2);
  check.close();
});

test('republishing a marked graph leaves its row untouched', () => {
  const store = openStore(':memory:');
  const { graph } = publish(store);
  assert.deepEqual(store.publishGraph(graph.packet), graph);
  store.close();
});

function otherGraph(store) {
  const session = store.importTranscript({ provider: 'codex', source: 'ali.jsonl', transcript: JSON.stringify({
    type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ali needs GPU time.' }] },
  }) });
  return store.publishGraph({
    version: 2, sessionId: session.id, party: 'ali',
    nodes: [{ id: 'gpu', kind: 'goal', label: 'GPU time', evidenceLines: [1] }], edges: [],
  });
}

test('the room puts the mark on each node', () => {
  const store = openStore(':memory:');
  const { graph } = publish(store);
  const room = store.openRoom({ graphIds: [graph.id, otherGraph(store).id] });
  const leo = room.parties.find(party => party.party === 'leo');
  assert.deepEqual(Object.fromEntries(leo.nodes.map(node => [node.id, node.grounding])), { limit: 'quoted', port: 'quoted', retry: 'inferred' });
  assert.equal(room.parties.find(party => party.party === 'ali').nodes[0].grounding, 'quoted');
  store.close();
});
