// Schema versions of ledger.sqlite, kept in PRAGMA user_version. A file written before
// versions existed is version 0 and is upgraded in place when a store opens it.
export const schemaVersion = 2;

const userVersion = database => database.prepare('PRAGMA user_version').get().user_version;
const columns = (database, table) => new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));

// The packet's own party, or null for v1 packets and payloads that are not JSON.
const packetParty = payload => `CASE WHEN json_valid(${payload}) THEN
    CASE WHEN json_type(${payload}, '$.packet.party') = 'text' THEN json_extract(${payload}, '$.packet.party') END END`;
const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** The slug of the project that sessions without one belong to. */
export const defaultProject = 'default';

const refuseNewer = version => {
  if (version > schemaVersion) {
    throw new Error(`This ledger database was written by a newer Context Ledger (schema ${version}). ` +
      'Use that version or another CONTEXT_LEDGER_DB.');
  }
};

/**
 * Version 1 adds created_at and party to graphs and created_at to rooms, with indexes
 * for listing. Version 2 adds projects and puts every session in one: existing
 * sessions go to the default project, which the step creates. Every step checks the
 * schema itself, so it is safe to repeat and does not depend on the order in which
 * other branches add their own steps.
 *
 * The triggers stamp new rows from any insert path, including an older build that
 * opens a migrated file: graphs and rooms get created_at, and a session inserted
 * without a project joins the default one. SQLite cannot add a NOT NULL column with a
 * foreign key, so sessions.project_id stays nullable and the trigger fills it.
 * Recreate the triggers if graphs, rooms or sessions is ever rebuilt.
 *
 * bootstrap creates the tables of the oldest schema (CREATE TABLE IF NOT EXISTS). It
 * runs under the same write lock, after the version is read again, so a file that a
 * newer build upgrades while this one opens it is refused before any DDL touches it.
 * The lock is taken on every open; a file already at this version only rereads it.
 */
export function migrate(database, bootstrap = () => {}) {
  // Refuse a newer file without waiting for the lock; checked again under it.
  refuseNewer(userVersion(database));

  database.exec('BEGIN IMMEDIATE');
  try {
    // Another process may have migrated while this one waited for the lock.
    const version = userVersion(database);
    refuseNewer(version);
    bootstrap();
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
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
