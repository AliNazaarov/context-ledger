import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { schemaVersion } from '../src/migrate.mjs';
import { openStore } from '../src/store.mjs';
import { startMcp } from './mcp-client.mjs';

// Card P1c: one messages row per turn with stable keys, schema version 3
// (docs/evals.md, "P1c — One row per message, stable keys"). Synthetic data only.

const nul = String.fromCodePoint(0);
const bell = String.fromCodePoint(7);

// The DDL of 19f6522, the last build without schema versions (as in tests/projects.test.mjs).
const versionZeroDdl = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    messages TEXT NOT NULL,
    search_text TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS graphs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    payload TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    graph_a TEXT NOT NULL REFERENCES graphs(id),
    graph_b TEXT NOT NULL REFERENCES graphs(id),
    CHECK (graph_a < graph_b)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS room_choices (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    proposal_id TEXT NOT NULL,
    party TEXT NOT NULL,
    choice TEXT NOT NULL CHECK (choice IN ('confirm', 'reject')),
    PRIMARY KEY (room_id, proposal_id, party)
  ) STRICT;
`;
// What version 1 (main 3a17536) adds. Triggers come after the rows are copied, so the
// copied created_at and party values stay as they were.
const versionOneColumns = `
  ALTER TABLE graphs ADD COLUMN created_at TEXT;
  ALTER TABLE graphs ADD COLUMN party TEXT;
  ALTER TABLE rooms ADD COLUMN created_at TEXT;
  CREATE INDEX graphs_session_id ON graphs(session_id);
  CREATE INDEX graphs_party ON graphs(party);
  CREATE INDEX rooms_graph_a ON rooms(graph_a);
  CREATE INDEX rooms_graph_b ON rooms(graph_b);
`;
const party = payload => `CASE WHEN json_valid(${payload}) THEN
    CASE WHEN json_type(${payload}, '$.packet.party') = 'text' THEN json_extract(${payload}, '$.packet.party') END END`;
const stamp = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const versionOneTriggers = `
  CREATE TRIGGER graphs_stamp AFTER INSERT ON graphs BEGIN
    UPDATE graphs SET created_at = ${stamp}, party = ${party('NEW.payload')} WHERE rowid = NEW.rowid;
  END;
  CREATE TRIGGER rooms_stamp AFTER INSERT ON rooms BEGIN
    UPDATE rooms SET created_at = ${stamp} WHERE rowid = NEW.rowid;
  END;
`;
// What version 2 (P1b, PR #42 3491cc4) adds: projects and sessions.project_id.
const versionTwoTable = `
  CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
  ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id);
  CREATE INDEX sessions_project_id ON sessions(project_id);
`;
const versionTwoTrigger = `
  CREATE TRIGGER sessions_project AFTER INSERT ON sessions WHEN NEW.project_id IS NULL BEGIN
    UPDATE sessions SET project_id = (SELECT id FROM projects WHERE slug = 'default') WHERE rowid = NEW.rowid;
  END;
`;
// The 19f6522 session insert, which names no project and writes no message rows.
const oldInsertSession = `INSERT INTO sessions (id, provider, source, title, message_count, messages, search_text)
  VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`;
const sessionColumns = 'id, provider, source, title, message_count, messages, search_text';
const migrationFailed = 'A stored session has messages that cannot be moved to schema version 3. The file was not changed.';

const uuids = ['0b6e7d1a-1111-4222-8333-444455556666', '0b6e7d1a-1111-4222-8333-777788889999', '0b6e7d1a-1111-4222-8333-aaaabbbbcccc'];
const claudeRecord = (role, text, extra = {}) => JSON.stringify({ type: role, ...extra, message: { role, content: text } });
const codexRecord = (role, text) => JSON.stringify({ type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
// Three Claude turns with UUIDs and a record that is not a turn (line 2).
const leoTranscript = [
  claudeRecord('user', 'Plan the synthetic Orion demo.', { uuid: uuids[0] }),
  JSON.stringify({ type: 'summary', summary: 'Not a turn' }),
  claudeRecord('assistant', 'Draft the Orion outline first.', { uuid: uuids[1] }),
  claudeRecord('user', 'Then rehearse it twice.', { uuid: uuids[2] }),
].join('\n');
const aliTranscript = [codexRecord('user', 'Ali reviews the Orion outline.'), codexRecord('assistant', 'Outline approved.')].join('\n');

const userVersion = database => database.prepare('PRAGMA user_version').get().user_version;
const plain = rows => rows.map(row => ({ ...row }));
const rows = (database, sql, ...values) => plain(database.prepare(sql).all(...values));
const schema = database => rows(database, 'SELECT type, name, sql FROM sqlite_master ORDER BY type, name');
const messageRows = (database, sessionId) =>
  rows(database, 'SELECT seq, line, role, text, key FROM messages WHERE session_id = ? ORDER BY seq', sessionId);
const sessionId = (provider, transcript) => createHash('sha256').update(`${provider}${nul}`).update(transcript).digest('hex');
// Recomputed here rather than imported, so the test checks the rule, not the code.
const hashKey = (id, line, rawLine) =>
  'h:' + createHash('sha256').update(`${id}${nul}${line}${nul}${rawLine}`).digest('hex').slice(0, 32);

async function scratchDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const handles = [];
  t.after(async () => {
    try {
      for (const close of handles.reverse()) await close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { directory, keep: close => handles.push(close) };
}

/**
 * A ledger file at version 0, 1 or 2 with a Claude session in `acme` (version 2 only) and
 * a Codex session in `default`, three graphs and a decided room. Rows are copied from a
 * scratch store, whose sessions.messages column holds the JSON the older builds wrote.
 */
async function oldLedger(directory, version) {
  const scratchPath = join(directory, `scratch-${version}.sqlite`);
  const scratch = openStore(scratchPath);
  const leo = scratch.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript: leoTranscript, project: 'acme' });
  const ali = scratch.importTranscript({ provider: 'codex', source: 'ali.jsonl', transcript: aliTranscript });
  const v1 = scratch.publishGraph({ version: 1, sessionId: leo.id, nodes: [{ id: 'ship', kind: 'goal', label: 'Ship Orion', evidenceLines: [1] }], edges: [] });
  const leoGraph = scratch.publishGraph({ version: 2, sessionId: leo.id, party: 'leo',
    nodes: [{ id: 'demo', kind: 'goal', label: 'Synthetic demo', evidenceLines: [1, 3] }], edges: [] });
  const aliGraph = scratch.publishGraph({ version: 2, sessionId: ali.id, party: 'ali',
    nodes: [{ id: 'review', kind: 'offer', label: 'Review the outline', evidenceLines: [2] }], edges: [],
    links: [{ from: 'review', graph: leoGraph.id, to: 'demo', type: 'matches' }] });
  const opened = scratch.openRoom({ graphIds: [leoGraph.id, aliGraph.id] });
  const room = scratch.decide(opened.id, { proposalId: opened.proposals[0].id, party: 'leo', choice: 'confirm' });
  const context = scratch.getGraphContext(leoGraph.id);
  scratch.close();

  const source = new DatabaseSync(scratchPath);
  const path = join(directory, `v${version}.sqlite`);
  const old = new DatabaseSync(path);
  old.exec(versionZeroDdl);
  if (version >= 1) old.exec(versionOneColumns);
  if (version >= 2) old.exec(versionTwoTable);
  const copy = (table, names, from = table) => {
    const insert = old.prepare(`INSERT INTO ${table} (${names}) VALUES (${names.split(', ').map(() => '?').join(', ')})`);
    for (const row of source.prepare(`SELECT ${names} FROM ${from} ORDER BY rowid`).all()) insert.run(...Object.values(row));
  };
  if (version >= 2) copy('projects', 'id, slug, name, created_at');
  copy('sessions', version >= 2 ? `${sessionColumns}, project_id` : sessionColumns);
  copy('graphs', version >= 1 ? 'id, session_id, payload, created_at, party' : 'id, session_id, payload');
  copy('rooms', version >= 1 ? 'id, graph_a, graph_b, created_at' : 'id, graph_a, graph_b');
  copy('room_choices', 'room_id, proposal_id, party, choice');
  source.close();
  if (version >= 1) old.exec(versionOneTriggers);
  if (version >= 2) old.exec(versionTwoTrigger);
  old.exec(`PRAGMA user_version = ${version}`);
  assert.deepEqual(rows(old, "SELECT name FROM sqlite_master WHERE name = 'messages'"), []);
  old.close();
  return { path, leo, ali, v1, leoGraph, aliGraph, room, context };
}

/** The rows a migrated session must get: its JSON messages in order, keyed by line. */
const legacyRowsOf = json => JSON.parse(json).map(({ role, text, line }, seq) => ({ seq, line, role, text, key: `l:${line}` }));

test('a new file is at schema version 3 with the messages table, its keys and the older-build trigger', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-new-');
  const path = join(directory, 'ledger.sqlite');
  openStore(path).close();
  const check = new DatabaseSync(path);
  keep(() => check.close());
  assert.equal(schemaVersion, 3);
  assert.equal(userVersion(check), 3);
  assert.deepEqual(rows(check, 'PRAGMA table_info(messages)').map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })), [
    { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'session_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'seq', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'line', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'role', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'text', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'key', type: 'TEXT', notnull: 1, pk: 0 },
  ]);
  const unique = rows(check, 'PRAGMA index_list(messages)').filter(index => index.unique === 1 && index.origin === 'u')
    .map(index => rows(check, `PRAGMA index_info(${JSON.stringify(index.name)})`).map(column => column.name).join(', ')).sort();
  assert.deepEqual(unique, ['session_id, key', 'session_id, seq']);
  assert.deepEqual(rows(check, 'PRAGMA foreign_key_list(messages)').map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete })),
    [{ table: 'sessions', from: 'session_id', to: 'id', on_delete: 'CASCADE' }]);
  const table = check.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages'").get().sql;
  assert.match(table, /DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(table, /STRICT$/u);
  assert.ok(schema(check).some(row => row.type === 'trigger' && row.name === 'sessions_messages'));
  // No FTS5 or any other virtual table: the engine decision (P1a) is still open.
  assert.deepEqual(rows(check, "SELECT name FROM sqlite_master WHERE sql LIKE 'CREATE VIRTUAL TABLE%'"), []);
});

test('a version 2 file upgrades in place: rows match the stored JSON with line keys and citations still hold', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-v2-');
  const fixture = await oldLedger(directory, 2);
  const raw = new DatabaseSync(fixture.path);
  const before = {
    sessions: rows(raw, 'SELECT * FROM sessions ORDER BY rowid'),
    projects: rows(raw, 'SELECT * FROM projects ORDER BY rowid'),
    graphs: rows(raw, 'SELECT * FROM graphs ORDER BY rowid'),
    rooms: rows(raw, 'SELECT * FROM rooms ORDER BY rowid'),
    choices: rows(raw, 'SELECT * FROM room_choices ORDER BY rowid'),
  };
  raw.close();
  assert.deepEqual(before.projects.map(project => project.slug), ['default', 'acme']);

  const store = openStore(fixture.path);
  let closed = false;
  keep(() => closed || store.close());
  const check = new DatabaseSync(fixture.path);
  keep(() => check.close());
  assert.equal(userVersion(check), 3);

  // Every session has its JSON messages as rows, in order, keyed l:<line>.
  for (const session of before.sessions) {
    assert.deepEqual(messageRows(check, session.id), legacyRowsOf(session.messages), session.source);
  }
  assert.deepEqual(messageRows(check, fixture.leo.id).map(row => [row.line, row.key]), [[1, 'l:1'], [3, 'l:3'], [4, 'l:4']]);
  // Every older row keeps its values.
  assert.deepEqual(rows(check, 'SELECT * FROM sessions ORDER BY rowid'), before.sessions);
  assert.deepEqual(rows(check, 'SELECT * FROM projects ORDER BY rowid'), before.projects);
  assert.deepEqual(rows(check, 'SELECT * FROM graphs ORDER BY rowid'), before.graphs);
  assert.deepEqual(rows(check, 'SELECT * FROM rooms ORDER BY rowid'), before.rooms);
  assert.deepEqual(rows(check, 'SELECT * FROM room_choices ORDER BY rowid'), before.choices);

  // Readers: the API shape is the JSON messages plus a key, and graphs, rooms and context read back.
  const leo = store.get(fixture.leo.id);
  assert.deepEqual(leo.messages, JSON.parse(before.sessions[0].messages).map(message => ({ ...message, key: `l:${message.line}` })));
  assert.equal(leo.project, 'acme');
  for (const graph of [fixture.v1, fixture.leoGraph, fixture.aliGraph]) assert.deepEqual(store.getGraph(graph.id), graph);
  assert.deepEqual(store.getRoom(fixture.room.id), fixture.room);
  assert.deepEqual(store.getGraphContext(fixture.leoGraph.id), fixture.context);

  // Line citations still validate against the migrated rows.
  const cited = store.publishGraph({ version: 2, sessionId: fixture.leo.id, party: 'leo',
    nodes: [{ id: 'rehearse', kind: 'goal', label: 'Rehearse twice', evidenceLines: [4] }], edges: [] });
  assert.deepEqual(cited.packet.nodes[0].evidenceLines, [4]);
  for (const line of [2, 5]) {
    assert.throws(() => store.publishGraph({ version: 2, sessionId: fixture.leo.id, party: 'leo',
      nodes: [{ id: 'other', kind: 'goal', label: 'Not a turn', evidenceLines: [line] }], edges: [] }),
    { message: 'Evidence must refer to stored lines in the source session.' }, `line ${line}`);
  }

  // Reopening changes neither schema nor rows.
  const shape = schema(check);
  const contents = rows(check, 'SELECT * FROM messages ORDER BY id');
  store.close();
  closed = true;
  openStore(fixture.path).close();
  assert.deepEqual(schema(check), shape);
  assert.deepEqual(rows(check, 'SELECT * FROM messages ORDER BY id'), contents);
  assert.equal(userVersion(check), 3);
});

test('version 1 and unversioned files go straight to version 3 with the same rows', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-old-');
  for (const version of [0, 1]) {
    const fixture = await oldLedger(directory, version);
    const store = openStore(fixture.path);
    keep(() => store.close());
    const check = new DatabaseSync(fixture.path);
    keep(() => check.close());
    assert.equal(userVersion(check), 3, `version ${version}`);
    const sessions = rows(check, 'SELECT id, messages, project_id FROM sessions ORDER BY rowid');
    assert.equal(sessions.length, 2);
    for (const session of sessions) assert.deepEqual(messageRows(check, session.id), legacyRowsOf(session.messages));
    assert.equal(check.prepare('SELECT count(*) AS n FROM sessions WHERE project_id IS NULL').get().n, 0);
    assert.deepEqual(rows(check, 'PRAGMA table_info(graphs)').map(column => column.name), ['id', 'session_id', 'payload', 'created_at', 'party']);
    assert.deepEqual(store.get(fixture.ali.id).messages.map(message => message.key), ['l:1', 'l:2']);
    assert.equal(store.getGraphContext(fixture.leoGraph.id).text, fixture.context.text);
  }
});

test('the version 3 step is safe to repeat: sessions that already have rows keep them', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-repeat-');
  const fixture = await oldLedger(directory, 2);
  const partial = new DatabaseSync(fixture.path);
  partial.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      seq INTEGER NOT NULL, line INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), text TEXT NOT NULL, key TEXT NOT NULL,
      UNIQUE (session_id, key), UNIQUE (session_id, seq)
    ) STRICT;`);
  // Rows a step run before wrote for the Codex session, with keys of their own.
  const insert = partial.prepare('INSERT INTO messages (session_id, seq, line, role, text, key) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(fixture.ali.id, 0, 1, 'user', 'Ali reviews the Orion outline.', 'h:kept-one');
  insert.run(fixture.ali.id, 1, 2, 'assistant', 'Outline approved.', 'h:kept-two');
  const json = rows(partial, 'SELECT id, messages FROM sessions ORDER BY rowid');
  partial.close();
  // A session with fewer rows than stored messages is not trusted: the step fails.
  const short = join(directory, 'short.sqlite');
  await copyFile(fixture.path, short);
  const cut = new DatabaseSync(short);
  cut.prepare('DELETE FROM messages WHERE key = ?').run('h:kept-two');
  cut.close();
  const shortBytes = await readFile(short);
  assert.throws(() => openStore(short), { message: migrationFailed });
  assert.ok((await readFile(short)).equals(shortBytes), 'the short file is unchanged');

  const store = openStore(fixture.path);
  keep(() => store.close());
  const check = new DatabaseSync(fixture.path);
  keep(() => check.close());
  assert.equal(userVersion(check), 3);
  assert.deepEqual(messageRows(check, fixture.ali.id).map(row => row.key), ['h:kept-one', 'h:kept-two']);
  assert.deepEqual(messageRows(check, fixture.leo.id), legacyRowsOf(json.find(row => row.id === fixture.leo.id).messages));
  assert.equal(check.prepare('SELECT count(*) AS n FROM messages').get().n, 5);
});

test('a session whose stored messages cannot be copied fails the step and leaves the file at version 2', async t => {
  const { directory } = await scratchDirectory(t, 'ledger-p1c-atomic-');
  const fixture = await oldLedger(directory, 2);
  const turn = { role: 'user', text: 'Synthetic turn', line: 1 };
  const variants = [
    ['malformed JSON', '[{"role": "user"'],
    ['an object', JSON.stringify({ messages: [turn] })],
    ['a number in the array', JSON.stringify([turn, 7])],
    ['a system role', JSON.stringify([{ ...turn, role: 'system' }])],
    ['a missing text', JSON.stringify([{ role: 'user', line: 1 }])],
    ['a numeric text', JSON.stringify([{ ...turn, text: 5 }])],
    ['line 0', JSON.stringify([{ ...turn, line: 0 }])],
    ['a string line', JSON.stringify([{ ...turn, line: '1' }])],
    ['a fractional line', JSON.stringify([{ ...turn, line: 1.5 }])],
  ];
  for (const [name, messages] of variants) {
    const path = join(directory, `atomic-${variants.findIndex(variant => variant[0] === name)}.sqlite`);
    await copyFile(fixture.path, path);
    const setup = new DatabaseSync(path);
    setup.prepare('UPDATE sessions SET messages = ? WHERE id = ?').run(messages, fixture.ali.id);
    const shape = schema(setup);
    const sessions = rows(setup, 'SELECT * FROM sessions ORDER BY rowid');
    setup.close();
    const bytes = await readFile(path);
    assert.throws(() => openStore(path), { message: migrationFailed }, name);
    assert.ok((await readFile(path)).equals(bytes), `${name}: the file is unchanged`);
    const after = new DatabaseSync(path);
    assert.equal(userVersion(after), 2, name);
    assert.deepEqual(schema(after), shape, name);
    assert.deepEqual(rows(after, 'SELECT * FROM sessions ORDER BY rowid'), sessions, name);
    after.close();
  }

  // Two stored messages on one line would share a key: SQLite refuses it, and the step rolls back.
  const path = join(directory, 'atomic-duplicate.sqlite');
  await copyFile(fixture.path, path);
  const setup = new DatabaseSync(path);
  setup.prepare('UPDATE sessions SET messages = ? WHERE id = ?').run(JSON.stringify([turn, turn]), fixture.ali.id);
  setup.close();
  assert.throws(() => openStore(path), /UNIQUE constraint failed: messages\.session_id, messages\.key/u);
  const after = new DatabaseSync(path);
  assert.equal(userVersion(after), 2);
  assert.deepEqual(rows(after, "SELECT name FROM sqlite_master WHERE name IN ('messages', 'sessions_messages')"), []);
  after.close();
});

test('a newer file is refused untouched', async t => {
  const { directory } = await scratchDirectory(t, 'ledger-p1c-newer-');
  const path = join(directory, 'newer.sqlite');
  openStore(path).close();
  const bump = new DatabaseSync(path);
  bump.exec(`PRAGMA user_version = ${schemaVersion + 1}`);
  bump.close();
  const bytes = await readFile(path);
  assert.throws(() => openStore(path), { message: 'This ledger database was written by a newer Context Ledger (schema 4). ' +
    'Use that version or another CONTEXT_LEDGER_DB.' });
  assert.ok((await readFile(path)).equals(bytes));
});

test('a session inserted by a build from before versions gets line-keyed rows from its JSON', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-older-build-');
  const path = join(directory, 'ledger.sqlite');
  openStore(path).close();
  const older = new DatabaseSync(path);
  keep(() => older.close());
  older.exec(versionZeroDdl);
  const id = '6'.repeat(64);
  const messages = [{ role: 'user', text: 'Old build turn', line: 1 }, { role: 'assistant', text: 'Old build reply', line: 3 }];
  older.prepare(oldInsertSession).run(id, 'claude', 'old.jsonl', 'Old build turn', 2, JSON.stringify(messages), 'old build turn\nold build reply');
  assert.deepEqual(messageRows(older, id), [
    { seq: 0, line: 1, role: 'user', text: 'Old build turn', key: 'l:1' },
    { seq: 1, line: 3, role: 'assistant', text: 'Old build reply', key: 'l:3' },
  ]);
  // A repeated insert of the same ID is ignored and adds no rows.
  older.prepare(oldInsertSession).run(id, 'claude', 'old.jsonl', 'Old build turn', 2, JSON.stringify(messages), 'old build turn');
  assert.equal(older.prepare('SELECT count(*) AS n FROM messages').get().n, 2);

  const store = openStore(path);
  keep(() => store.close());
  const session = store.get(id);
  assert.equal(session.project, 'default');
  assert.deepEqual(session.messages, messages.map(message => ({ ...message, key: `l:${message.line}` })));
  assert.equal(store.publishGraph({ version: 1, sessionId: id, nodes: [{ id: 'g', kind: 'goal', label: 'Old', evidenceLines: [3] }], edges: [] })
    .packet.nodes[0].evidenceLines[0], 3);
});

test('imports key each turn by record UUID or by a hash of its session, line and raw line', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-keys-');
  const store = openStore(join(directory, 'ledger.sqlite'));
  keep(() => store.close());

  const lines = [
    claudeRecord('user', 'First UUID turn.', { uuid: uuids[0] }),
    claudeRecord('assistant', 'ok', { uuid: uuids[1].toUpperCase() }),
    claudeRecord('user', 'Repeats the first UUID.', { uuid: uuids[0] }),
    claudeRecord('assistant', 'ok'),
    claudeRecord('user', 'ok'),
    claudeRecord('assistant', 'Not a UUID.', { uuid: 'not-a-uuid' }),
    claudeRecord('user', 'A control character.', { uuid: `${uuids[2]}${bell}` }),
    claudeRecord('assistant', 'A number.', { uuid: 42 }),
    JSON.stringify({ type: 'summary', uuid: uuids[2], summary: 'Not a turn' }),
    claudeRecord('user', 'Third UUID after a non-turn used it.', { uuid: uuids[2] }),
  ];
  const transcript = lines.join('\n');
  const summary = store.importTranscript({ provider: 'claude', source: 'keys.jsonl', transcript });
  const id = sessionId('claude', transcript);
  assert.equal(summary.id, id);
  const keys = store.get(id).messages.map(message => [message.line, message.key]);
  assert.deepEqual(keys, [
    [1, `u:${uuids[0]}`],
    [2, `u:${uuids[1].toUpperCase()}`],
    [3, hashKey(id, 3, lines[2])],
    [4, hashKey(id, 4, lines[3])],
    [5, hashKey(id, 5, lines[4])],
    [6, hashKey(id, 6, lines[5])],
    [7, hashKey(id, 7, lines[6])],
    [8, hashKey(id, 8, lines[7])],
    [10, `u:${uuids[2]}`],
  ]);
  assert.notEqual(keys[2][1], keys[3][1], 'identical turns on different lines get different keys');
  assert.match(keys[2][1], /^h:[a-f0-9]{32}$/u);

  // Codex has no record UUIDs. A CRLF file hashes each line with its carriage return.
  const codexLines = [codexRecord('user', 'Codex asks.'), codexRecord('assistant', 'Codex answers.'), codexRecord('user', 'Codex asks.')];
  const crlf = codexLines.join('\r\n') + '\r\n';
  const codexSession = store.importTranscript({ provider: 'codex', source: 'codex.jsonl', transcript: crlf });
  const codexId = sessionId('codex', crlf);
  assert.equal(codexSession.id, codexId);
  const codexKeys = store.get(codexId).messages.map(message => message.key);
  assert.deepEqual(codexKeys, codexLines.map((line, index) => hashKey(codexId, index + 1, line + '\r')));
  assert.notEqual(codexKeys[0], hashKey(codexId, 1, codexLines[0]));
  assert.equal(new Set(codexKeys).size, 3);

  // The rows hold exactly what get returns, and the JSON copy is what older builds wrote.
  const check = new DatabaseSync(join(directory, 'ledger.sqlite'));
  keep(() => check.close());
  const detail = store.get(id);
  assert.deepEqual(messageRows(check, id), detail.messages.map((message, seq) => ({ seq, line: message.line, role: message.role, text: message.text, key: message.key })));
  assert.deepEqual(JSON.parse(check.prepare('SELECT messages FROM sessions WHERE id = ?').get(id).messages),
    detail.messages.map(({ role, text, line }) => ({ role, text, line })));

  // The same bytes in another, empty store give the same session ID and the same keys.
  const other = openStore(join(directory, 'other.sqlite'));
  keep(() => other.close());
  assert.equal(other.importTranscript({ provider: 'claude', source: 'copy.jsonl', transcript }).id, id);
  assert.deepEqual(other.get(id).messages, detail.messages);
  // Importing the same bytes again returns the stored session and writes nothing.
  assert.deepEqual(store.importTranscript({ provider: 'claude', source: 'keys.jsonl', transcript }), summary);
  assert.equal(check.prepare('SELECT count(*) AS n FROM messages WHERE session_id = ?').get(id).n, 9);
});

test('a session and its rows commit together or not at all', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-commit-');
  const path = join(directory, 'ledger.sqlite');
  const store = openStore(path);
  keep(() => store.close());
  const check = new DatabaseSync(path);
  keep(() => check.close());
  check.exec("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
  const transcript = claudeRecord('user', 'Never stored.', { uuid: uuids[0] });
  assert.throws(() => store.importTranscript({ provider: 'claude', source: 'never.jsonl', transcript }), /synthetic failure/u);
  assert.equal(check.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  assert.equal(check.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  check.exec('DROP TRIGGER fail_session');
  const stored = store.importTranscript({ provider: 'claude', source: 'never.jsonl', transcript });
  assert.deepEqual(messageRows(check, stored.id).map(row => row.key), [`u:${uuids[0]}`]);
  // A row without its session fails at commit: the foreign key is deferred, not dropped.
  assert.throws(() => check.exec(`BEGIN; INSERT INTO messages (session_id, seq, line, role, text, key)
    VALUES ('${'9'.repeat(64)}', 0, 1, 'user', 'Orphan', 'l:1'); COMMIT;`), /FOREIGN KEY constraint failed/u);
  check.exec('ROLLBACK');
  assert.equal(check.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
});

test('readers use the rows: the JSON column can hold anything without changing what they return', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-readers-');
  const path = join(directory, 'ledger.sqlite');
  const store = openStore(path);
  keep(() => store.close());
  const leo = store.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript: leoTranscript });
  const graph = store.publishGraph({ version: 2, sessionId: leo.id, party: 'leo',
    nodes: [{ id: 'demo', kind: 'goal', label: 'Synthetic demo', evidenceLines: [1, 3] }], edges: [] });
  const before = { session: store.get(leo.id), context: store.getGraphContext(graph.id), found: store.list('rehearse twice', '') };
  assert.deepEqual(before.found.map(session => session.id), [leo.id]);

  const check = new DatabaseSync(path);
  keep(() => check.close());
  check.prepare('UPDATE sessions SET messages = ? WHERE id = ?').run('not JSON at all', leo.id);
  assert.deepEqual(store.get(leo.id), before.session);
  assert.deepEqual(store.getGraphContext(graph.id), before.context);
  assert.deepEqual(store.list('rehearse twice', ''), before.found);
  assert.deepEqual(store.listSessionsPage({ query: 'orion', provider: '', limit: 5 }).sessions.map(session => session.id), [leo.id]);
  const cited = store.publishGraph({ version: 2, sessionId: leo.id, party: 'leo',
    nodes: [{ id: 'rehearse', kind: 'goal', label: 'Rehearse', evidenceLines: [4] }], edges: [] });
  assert.deepEqual(cited.packet.nodes[0].evidenceLines, [4]);
  assert.throws(() => store.publishGraph({ version: 2, sessionId: leo.id, party: 'leo',
    nodes: [{ id: 'summary', kind: 'goal', label: 'Not a turn', evidenceLines: [2] }], edges: [] }),
  { message: 'Evidence must refer to stored lines in the source session.' });
  assert.deepEqual(before.session.messages.map(message => message.key), uuids.map(uuid => `u:${uuid}`));
});

async function startServer(database) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: database },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at (http:\/\/127\.0\.0\.1:(\d+))/u);
    if (match) return { origin: match[1], port: Number(match[2]), stop: async () => { child.kill(); await once(child, 'exit'); } };
  }
  throw new Error('Server exited before listening: ' + output);
}

test('the session route returns each message with its key, and MCP session_read shows turns as before', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-http-');
  const server = await startServer(join(directory, 'ledger.sqlite'));
  keep(() => server.stop());
  const imported = await fetch(server.origin + '/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: server.origin },
    body: JSON.stringify({ provider: 'claude', source: 'leo.jsonl', transcript: leoTranscript }),
  });
  assert.equal(imported.status, 200);
  const { session: summary } = await imported.json();
  const response = await fetch(`${server.origin}/api/sessions/${summary.id}`);
  assert.equal(response.status, 200);
  const { session } = await response.json();
  assert.deepEqual(session.messages, [
    { role: 'user', text: 'Plan the synthetic Orion demo.', line: 1, key: `u:${uuids[0]}` },
    { role: 'assistant', text: 'Draft the Orion outline first.', line: 3, key: `u:${uuids[1]}` },
    { role: 'user', text: 'Then rehearse it twice.', line: 4, key: `u:${uuids[2]}` },
  ]);

  const client = startMcp(server.port);
  keep(async () => {
    if (client.child.exitCode === null) await client.close();
  });
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const turns = await client.call(2, 'session_read', { sessionId: summary.id });
  assert.equal(turns.isError, undefined, turns.content[0].text);
  const [{ text }] = turns.content;
  assert.deepEqual([...text.matchAll(/^## (\w+) · line (\d+)$/gmu)].map(match => `${match[1]} ${match[2]}`),
    ['user 1', 'assistant 3', 'user 4']);
  for (const uuid of uuids) assert.ok(!text.includes(uuid), 'keys are not shown in session_read');
});
