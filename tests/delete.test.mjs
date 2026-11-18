import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ConflictError, openStore } from '../src/store.mjs';

// P1d, first part: delete one imported session. Synthetic transcripts only, and only
// temporary or :memory: databases: never .context-ledger/ledger.sqlite.
const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

const transcript = (...texts) => texts.map((text, index) => JSON.stringify(index % 2
  ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
  : { type: 'user', message: { role: 'user', content: text } })).join('\n');
const importOne = (store, source, ...texts) => store.importTranscript({ provider: 'claude', source, transcript: transcript(...texts) });
const v1 = (session, label) => ({ version: 1, sessionId: session.id, nodes: [{ id: 'goal', kind: 'goal', label, evidenceLines: [1] }], edges: [] });
const v2 = (session, party, label, extra = {}) => ({ version: 2, sessionId: session.id, party,
  nodes: [{ id: 'goal', kind: 'goal', label, evidenceLines: [1] }], edges: [], ...extra });
const schemaOf = path => {
  const database = new DatabaseSync(path);
  try {
    return {
      version: database.prepare('PRAGMA user_version').get().user_version,
      tables: database.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all().map(row => ({ ...row })),
    };
  } finally {
    database.close();
  }
};

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('deleteSession removes one session and nothing else, and leaves the schema as it was', async t => {
  const path = join(await temporaryDirectory(t, 'ledger-delete-'), 'ledger.sqlite');
  openStore(path).close();
  const before = schemaOf(path);

  const store = openStore(path);
  const keep = importOne(store, 'keep.jsonl', 'Orla keeps the synthetic Pavo plan.');
  const gone = importOne(store, 'gone.jsonl', 'Bram drafts the synthetic Quill budget.', 'The Quill budget is 40 units.');
  const keptDetail = store.get(keep.id);
  assert.deepEqual(store.list('', '').map(row => row.id), [gone.id, keep.id]);

  assert.equal(store.deleteSession(gone.id), true);
  assert.equal(store.get(gone.id), undefined);
  assert.deepEqual(store.list('', '').map(row => row.id), [keep.id]);
  assert.deepEqual(store.listSessionsPage({ query: '', provider: '', limit: 10 }), { sessions: [keep], next: null });
  assert.deepEqual(store.get(keep.id), keptDetail);

  // Unknown IDs, including one just deleted, change nothing.
  assert.equal(store.deleteSession(gone.id), false);
  assert.equal(store.deleteSession('e'.repeat(64)), false);
  assert.deepEqual(store.list('', '').map(row => row.id), [keep.id]);

  // A re-import of the same bytes is a new import with the same ID.
  assert.equal(importOne(store, 'gone.jsonl', 'Bram drafts the synthetic Quill budget.', 'The Quill budget is 40 units.').id, gone.id);
  store.close();
  assert.deepEqual(schemaOf(path), before);
  assert.equal(before.version, 1);
});

test('deleteSession is refused while any graph cites the session, and says how many', () => {
  const store = openStore(':memory:');
  {
    const leo = importOne(store, 'leo.jsonl', 'Leo plans the synthetic Lyra demo.');
    const ali = importOne(store, 'ali.jsonl', 'Ali reviews the synthetic Lyra demo.');
    const solo = importOne(store, 'solo.jsonl', 'Solo notes for the synthetic Ursa demo.');

    store.publishGraph(v1(solo, 'Ursa goal'));
    const refusal = error => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.message, 'This session is cited by 1 graph, so it cannot be deleted.');
      assert.deepEqual(error.details, { graphs: 1 });
      return true;
    };
    assert.throws(() => store.deleteSession(solo.id), refusal);
    store.publishGraph(v1(solo, 'Ursa goal, second take'));
    assert.throws(() => store.deleteSession(solo.id), error => {
      assert.equal(error.message, 'This session is cited by 2 graphs, so it cannot be deleted.');
      assert.deepEqual(error.details, { graphs: 2 });
      return true;
    });
    assert.equal(store.get(solo.id).id, solo.id);
    assert.equal(store.listGraphs({ sessionId: solo.id, limit: 10 }).graphs.length, 2);

    // A session in a room is refused through its graph; the room stays readable.
    const leoGraph = store.publishGraph(v2(leo, 'leo', 'Lyra goal'));
    const aliGraph = store.publishGraph(v2(ali, 'ali', 'Lyra review', { links: [{ from: 'goal', graph: leoGraph.id, to: 'goal', type: 'matches' }] }));
    const room = store.openRoom({ graphIds: [leoGraph.id, aliGraph.id] });
    for (const session of [leo, ali]) assert.throws(() => store.deleteSession(session.id), refusal);
    assert.deepEqual(store.getRoom(room.id), room);
    assert.ok(store.getGraphContext(leoGraph.id));
    assert.equal(store.list('', '').length, 3);

    // A refusal leaves no transaction open: the next write works.
    const other = importOne(store, 'other.jsonl', 'Other synthetic note.');
    assert.equal(store.deleteSession(other.id), true);
  }
  store.close();
});

test('a deleted session is really gone: search, raw file bytes, journal, and secure_delete restored', async t => {
  const directory = await temporaryDirectory(t, 'ledger-delete-bytes-');
  const path = join(directory, 'ledger.sqlite');
  const marker = 'Zephyrine';
  const title = `${marker} titles the synthetic Corvid file`;
  const bulk = `${marker} bulk evidence line. `.repeat(400);

  // Spy on exec to see the pragma and transaction statements the delete runs.
  const statements = [];
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    statements.push(sql.trim());
    return exec.call(this, sql);
  };
  t.after(() => { DatabaseSync.prototype.exec = exec; });

  const store = openStore(path);
  const keep = importOne(store, 'keep-corvid.jsonl', 'A kept synthetic Corvid note.');
  const gone = importOne(store, 'Xanthorrhoea-source.jsonl', title, bulk, `${marker} closing line.`);
  const cited = importOne(store, 'cited-corvid.jsonl', 'A cited synthetic Corvid note.');
  store.publishGraph(v1(cited, 'Corvid goal'));
  assert.deepEqual(store.list(marker, '').map(row => row.id), [gone.id]);

  statements.length = 0;
  assert.equal(store.deleteSession(gone.id), true);
  assert.deepEqual(statements, ['PRAGMA secure_delete = ON', 'BEGIN IMMEDIATE', 'COMMIT', 'PRAGMA secure_delete = OFF']);
  statements.length = 0;
  assert.throws(() => store.deleteSession(cited.id), ConflictError);
  assert.deepEqual(statements, ['PRAGMA secure_delete = ON', 'BEGIN IMMEDIATE', 'ROLLBACK', 'PRAGMA secure_delete = OFF']);

  assert.deepEqual(store.list(marker, '').map(row => row.id), []);
  assert.deepEqual(store.list('zephyrine bulk', '').map(row => row.id), []);
  assert.deepEqual(store.list('corvid', '').map(row => row.id).sort(), [keep.id, cited.id].sort());
  store.close();

  const bytes = (await readFile(path)).toString('latin1');
  for (const text of [marker, 'Xanthorrhoea', 'titles the synthetic', 'bulk evidence line', 'closing line']) {
    assert.equal(bytes.includes(text), false, `${text} is still in the file`);
  }
  assert.ok(bytes.includes('A kept synthetic Corvid note.'));
  assert.deepEqual((await readdir(directory)).sort(), ['ledger.sqlite']);
});

test('without secure_delete SQLite keeps deleted text in the file, which is why the delete turns it on', async t => {
  const path = join(await temporaryDirectory(t, 'ledger-delete-premise-'), 'plain.sqlite');
  const database = new DatabaseSync(path);
  assert.equal(database.prepare('PRAGMA secure_delete').get().secure_delete, 0);
  database.exec('CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT) STRICT');
  database.prepare('INSERT INTO t VALUES (?, ?)').run('a', 'Zephyrine plain delete. '.repeat(400));
  database.prepare('DELETE FROM t WHERE id = ?').run('a');
  database.close();
  assert.ok((await readFile(path)).toString('latin1').includes('Zephyrine plain delete.'));
});

async function startServer(t) {
  // One after hook, so the server stops before its database file is removed.
  const directory = await mkdtemp(join(tmpdir(), 'ledger-delete-server-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root, env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(directory, 'ledger.sqlite') }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(async () => {
    try {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return Number(match[1]);
  }
  throw new Error('The server did not start.');
}

const cli = (port, ...args) => execute(process.execPath, ['src/cli.mjs', ...args], { cwd: root, env: { ...process.env, PORT: String(port) } });
const cliFails = async (port, args, stderr) => {
  await assert.rejects(cli(port, ...args), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.equal(error.stderr.trim(), stderr);
    return true;
  });
};

test('ledger delete deletes through the server, and refuses cited and unknown sessions', async t => {
  const port = await startServer(t);
  const origin = `http://127.0.0.1:${port}`;
  const post = async (path, body) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const { session: gone } = await post('/api/import', { provider: 'claude', source: 'gone.jsonl', transcript: transcript('Nimbus is a synthetic word to delete.') });
  const { session: cited } = await post('/api/import', { provider: 'codex', source: 'cited.jsonl',
    transcript: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A cited synthetic Nimbus note.' }] } }) });
  await post('/api/graphs', v1(cited, 'Nimbus goal'));

  const deleted = await cli(port, 'delete', gone.id);
  assert.equal(deleted.stdout, `Deleted session ${gone.id}.\n`);
  assert.equal(deleted.stderr, '');
  assert.equal((await fetch(`${origin}/api/sessions/${gone.id}`)).status, 404);
  assert.deepEqual((await (await fetch(`${origin}/api/sessions?q=nimbus`)).json()).sessions.map(row => row.id), [cited.id]);

  await cliFails(port, ['delete', gone.id], 'Session not found.');
  await cliFails(port, ['delete', cited.id], 'Session is cited by 1 graph, so it was not deleted.');
  assert.equal((await fetch(`${origin}/api/sessions/${cited.id}`)).status, 200);

  // A DELETE without the Origin, as a page on another site or a plain client sends it, is refused.
  const bare = await fetch(`${origin}/api/sessions/${cited.id}`, { method: 'DELETE' });
  assert.deepEqual([bare.status, await bare.json()], [403, { error: 'Deleting a session requires the same origin.' }]);
});

test('ledger delete sends one DELETE with the local Origin, and prints only fixed text', async t => {
  const id = 'c'.repeat(64);
  const requests = [];
  let reply = { status: 200, body: { deleted: id } };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, origin: request.headers.origin, body: Buffer.concat(chunks).length });
    response.writeHead(reply.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  assert.equal((await cli(port, 'delete', id)).stdout, `Deleted session ${id}.\n`);
  assert.deepEqual(requests, [{ method: 'DELETE', url: `/api/sessions/${id}`, origin: `http://127.0.0.1:${port}`, body: 0 }]);

  // Bad IDs print the usage and send nothing.
  for (const args of [['delete'], ['delete', 'C'.repeat(64)], ['delete', 'c'.repeat(63)], ['delete', id, id]]) {
    await assert.rejects(cli(port, ...args), error => error.code === 1 && error.stderr.startsWith('Usage:') && error.stderr.includes('delete <session-id>'));
  }
  assert.equal(requests.length, 1);

  // The server's own words never reach the terminal: a 409 is built from its count.
  const hostile = `Gone ${String.fromCodePoint(0x1b)}[2J ${String.fromCodePoint(0x202e)}reversed`;
  reply = { status: 409, body: { error: hostile, graphs: 3 } };
  await cliFails(port, ['delete', id], 'Session is cited by 3 graphs, so it was not deleted.');
  for (const graphs of [0, -1, 1.5, '2', null]) {
    reply = { status: 409, body: { error: hostile, graphs } };
    await cliFails(port, ['delete', id], 'Context Ledger returned HTTP 409.');
  }
  reply = { status: 403, body: { error: hostile } };
  await cliFails(port, ['delete', id], 'Context Ledger returned HTTP 403.');
  reply = { status: 404, body: { error: hostile } };
  await cliFails(port, ['delete', id], 'Session not found.');
  reply = { status: 200, body: { deleted: 'd'.repeat(64) } };
  await cliFails(port, ['delete', id], 'Context Ledger returned an unexpected response.');
});

test('the MCP adapter has no way to delete', async () => {
  const { toolList } = await import('../src/mcp/tools.mjs');
  assert.equal(toolList.length, 13);
  for (const tool of toolList) {
    assert.doesNotMatch(JSON.stringify(tool), /delet|remov|purg|eras/iu, tool.name);
  }
  const directory = new URL('../src/mcp/', import.meta.url);
  for (const name of await readdir(directory)) {
    const source = await readFile(new URL(name, directory), 'utf8');
    assert.doesNotMatch(source, /DELETE|deleteSession/u, name);
  }
  assert.doesNotMatch(await readFile(new URL('../src/mcp.mjs', import.meta.url), 'utf8'), /DELETE|deleteSession/u);
});

test('the files this card changes hold no raw control or format characters', async () => {
  const files = ['src/errors.mjs', 'src/store.mjs', 'src/server.mjs', 'src/cli.mjs', 'tests/delete.test.mjs', 'tests/routes.test.mjs'];
  for (const file of files) {
    assert.ok(existsSync(join(root, file)), file);
    const text = await readFile(join(root, file), 'utf8');
    const found = [...text].filter(character => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character) && !['\t', '\n', '\r'].includes(character));
    assert.deepEqual(found, [], file);
  }
});
