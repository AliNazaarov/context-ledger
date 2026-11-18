// Schema versions of ledger.sqlite, kept in PRAGMA user_version. A file written before
// versions existed is version 0 and is upgraded in place when a store opens it.
export const schemaVersion = 3;

const userVersion = database => database.prepare('PRAGMA user_version').get().user_version;
const columns = (database, table) => new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));

// The packet's own party, or null for v1 packets and payloads that are not JSON.
const packetParty = payload => `CASE WHEN json_valid(${payload}) THEN
    CASE WHEN json_type(${payload}, '$.packet.party') = 'text' THEN json_extract(${payload}, '$.packet.party') END END`;
const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** The slug of the project that sessions without one belong to. */
export const defaultProject = 'default';

// Rows for one session's stored JSON messages, keyed by line: the JSON keeps neither raw
// lines nor record UUIDs, so u: and h: keys cannot be derived from it (docs/evals.md, P1c).
// text_json is the turn's JSON string literal as stored (->, not ->>), because a round trip
// through SQLite text loses a NUL and everything after it, and lone surrogates.
const legacyRows = (sessionId, messages, from = '') => `
  SELECT ${sessionId}, m.key, m.value ->> '$.line', m.value ->> '$.role', m.value -> '$.text',
    'l:' || (m.value ->> '$.line')
  FROM ${from}json_each(${messages}) m`;
const insertRows = 'INSERT INTO messages (session_id, seq, line, role, text_json, key)';
// The stored messages of a session that version 3 cannot copy: not a JSON array of
// { role, text, line } objects with a user or assistant role and a line from 1 to the
// largest integer JavaScript reads exactly (Number.MAX_SAFE_INTEGER). json_type calls 2^63
// an integer, but SQLite reads it as REAL 9.2e18, which the bound refuses.
const unreadableMessages = `
  SELECT count(*) AS n FROM sessions s
  WHERE CASE WHEN json_valid(s.messages) THEN json_type(s.messages) <> 'array' OR EXISTS (
    SELECT 1 FROM json_each(s.messages) m
    WHERE m.type <> 'object'
      OR coalesce(json_type(m.value, '$.role'), '') <> 'text' OR (m.value ->> '$.role') NOT IN ('user', 'assistant')
      OR coalesce(json_type(m.value, '$.text'), '') <> 'text'
      OR coalesce(json_type(m.value, '$.line'), '') <> 'integer'
      OR (m.value ->> '$.line') NOT BETWEEN 1 AND 9007199254740991
  ) ELSE 1 END`;
// Sessions whose rows are not exactly their stored messages: a row missing, extra or
// different in position, line, role or text. Rows a step run before wrote are kept only
// when they match; their keys are kept as they are.
const unmatchedSessions = `
  SELECT count(*) AS n FROM sessions s
  WHERE json_array_length(s.messages) <> (SELECT count(*) FROM messages r WHERE r.session_id = s.id)
    OR EXISTS (SELECT 1 FROM json_each(s.messages) m WHERE NOT EXISTS (
      SELECT 1 FROM messages r WHERE r.session_id = s.id AND r.seq = m.key AND r.line = (m.value ->> '$.line')
        AND r.role = (m.value ->> '$.role') AND r.text_json = (m.value -> '$.text')))`;
const migrationFailed = 'A stored session has messages that cannot be moved to schema version 3. The file was not changed.';

const refuseNewer = version => {
  if (version > schemaVersion) {
    throw new Error(`This ledger database was written by a newer Context Ledger (schema ${version}). ` +
      'Use that version or another CONTEXT_LEDGER_DB.');
  }
};

/** Throws when the file now has a newer schema than this build; writes nothing. */
export function refuseNewerSchema(database) {
  refuseNewer(userVersion(database));
}

/**
 * Version 1 adds created_at and party to graphs and created_at to rooms, with indexes
 * for listing. Version 2 adds projects and puts every session in one: existing
 * sessions go to the default project, which the step creates. Version 3 adds one
 * messages row per turn: each session's JSON messages are copied in order with l:<line>
 * keys, and the step fails unless every session's rows are exactly its stored messages.
 * A turn's text is kept as a JSON string literal (text_json), which is lossless.
 * Every step checks the schema itself, so it is safe to repeat and does not depend on
 * the order in which other branches add their own steps.
 *
 * The triggers stamp new rows from any insert path, including an older build that
 * opens a migrated file: graphs and rooms get created_at, and a session inserted
 * without a project joins the default one. SQLite cannot add a NOT NULL column with a
 * foreign key, so sessions.project_id stays nullable and the trigger fills it.
 * sessions.messages stays as a copy that this build writes and never reads, so a build
 * from before versions (which never reads user_version) keeps working on the file; the
 * sessions_messages trigger gives a session it inserts its rows. The import writes its
 * rows before the session, which is why messages.session_id is a deferred foreign key.
 * Recreate the triggers if graphs, rooms or sessions is ever rebuilt.
 *
 * bootstrap creates the tables of the oldest schema (CREATE TABLE IF NOT EXISTS). It
 * runs only under the write lock, after the version is read again, so a file that a
 * newer build upgrades while this one opens it is refused before any DDL touches it.
 * A file already at this version is opened with no lock and no DDL.
 */
export function migrate(database, bootstrap = () => {}) {
  const current = userVersion(database);
  refuseNewer(current);
  if (current === schemaVersion) return;

  database.exec('BEGIN IMMEDIATE');
  try {
    // Another process may have migrated while this one waited for the lock.
    const version = userVersion(database);
    refuseNewer(version);
    if (version < schemaVersion) bootstrap();
    if (version < 1) {
      const graphColumns = columns(database, 'graphs');
      if (!graphColumns.has('created_at')) database.exec('ALTER TABLE graphs ADD COLUMN created_at TEXT');
      if (!graphColumns.has('party')) database.exec('ALTER TABLE graphs ADD COLUMN party TEXT');
      database.exec(`UPDATE graphs SET party = ${packetParty('payload')} WHERE party IS NULL`);
      if (!columns(database, 'rooms').has('created_at')) database.exec('ALTER TABLE rooms ADD COLUMN created_at TEXT');
      database.exec(`
        CREATE INDEX IF NOT EXISTS graphs_session_id ON graphs(session_id);
        CREATE INDEX IF NOT EXISTS graphs_party ON graphs(party);
        CREATE INDEX IF NOT EXISTS rooms_graph_a ON rooms(graph_a);
        CREATE INDEX IF NOT EXISTS rooms_graph_b ON rooms(graph_b);
        CREATE TRIGGER IF NOT EXISTS graphs_stamp AFTER INSERT ON graphs BEGIN
          UPDATE graphs SET created_at = ${now}, party = ${packetParty('NEW.payload')} WHERE rowid = NEW.rowid;
        END;
        CREATE TRIGGER IF NOT EXISTS rooms_stamp AFTER INSERT ON rooms BEGIN
          UPDATE rooms SET created_at = ${now} WHERE rowid = NEW.rowid;
        END;
        PRAGMA user_version = 1;
      `);
    }
    if (version < 2) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO projects (id, slug, name, created_at)
          VALUES (lower(hex(randomblob(16))), '${defaultProject}', 'Default', ${now})
          ON CONFLICT (slug) DO NOTHING;
      `);
      if (!columns(database, 'sessions').has('project_id')) {
        database.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id)');
      }
      const defaultId = `(SELECT id FROM projects WHERE slug = '${defaultProject}')`;
      database.exec(`
        UPDATE sessions SET project_id = ${defaultId} WHERE project_id IS NULL;
        CREATE INDEX IF NOT EXISTS sessions_project_id ON sessions(project_id);
        CREATE TRIGGER IF NOT EXISTS sessions_project AFTER INSERT ON sessions WHEN NEW.project_id IS NULL BEGIN
          UPDATE sessions SET project_id = ${defaultId} WHERE rowid = NEW.rowid;
        END;
        PRAGMA user_version = 2;
      `);
    }
    if (version < 3) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
          seq INTEGER NOT NULL,
          line INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          text_json TEXT NOT NULL,
          key TEXT NOT NULL,
          UNIQUE (session_id, key),
          UNIQUE (session_id, seq)
        ) STRICT;
      `);
      if (database.prepare(unreadableMessages).get().n > 0) throw new Error(migrationFailed);
      // A session that already has rows (a step run before) keeps them.
      // No ORDER BY: seq carries the order, and a sort of every message would hold the
      // write lock longer on a large ledger (review round 2).
      database.exec(`${insertRows} ${legacyRows('s.id', 's.messages', 'sessions s, ')}
        WHERE NOT EXISTS (SELECT 1 FROM messages r WHERE r.session_id = s.id)`);
      if (database.prepare(unmatchedSessions).get().n > 0) throw new Error(migrationFailed);
      // Rows left by an earlier run with foreign keys off may name no session; a deferred
      // key only checks rows written in this transaction.
      if (database.prepare('PRAGMA foreign_key_check(messages)').all().length > 0) throw new Error(migrationFailed);
      // Replaced, not kept: a trigger of this name from elsewhere might not write the rows.
      database.exec(`
        DROP TRIGGER IF EXISTS sessions_messages;
        CREATE TRIGGER sessions_messages AFTER INSERT ON sessions
        WHEN NOT EXISTS (SELECT 1 FROM messages WHERE session_id = NEW.id) BEGIN
          ${insertRows} ${legacyRows('NEW.id', 'NEW.messages')} ORDER BY m.key;
        END;
        PRAGMA user_version = 3;
      `);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
