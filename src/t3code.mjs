import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Reads T3 Code threads from a copy of T3's database (statev2.sqlite) that the person
// made. The layout is pinned to one release, learned from its public source:
// pingdotgg/t3code v0.1.10, commit 7d32075e3757ded707914e2450c3e392a9665765, whose
// schema head is migration 96. Any other layout is refused (docs/evals.md, D3).

/** A refusal the person can act on. Its message is a fixed sentence with no input in it. */
export class T3ImportError extends Error {}

export const t3Release = Object.freeze({
  version: 'v0.1.10',
  commit: '7d32075e3757ded707914e2450c3e392a9665765',
  schemaHead: 96,
});

const unsupportedLayout = 'This T3 Code database layout is not supported. The importer reads copies made by T3 Code v0.1.10 (schema 96) only.';
const unreadable = 'Cannot read the T3 Code database copy.';

// Migration rows that must be present with these names (apps/server/src/persistence/Migrations.ts).
const requiredMigrations = new Map([[55, 'OrchestrationV2'], [96, 'RepairStaleTitleRegeneration']]);

// Every column read below, as created by migrations 055, OrchestrationV2/Foundation and 081.
const requiredColumns = {
  effect_sql_migrations: ['migration_id', 'name'],
  orchestration_v2_projection_threads: ['thread_id', 'title', 'created_at', 'deleted_at'],
  orchestration_v2_projection_runs: ['run_id', 'thread_id', 'provider_thread_id', 'payload_json'],
  orchestration_v2_projection_run_attempts: ['thread_id', 'provider_thread_id'],
  orchestration_v2_projection_provider_threads: ['provider_thread_id', 'driver'],
  orchestration_v2_projection_messages: ['message_id', 'thread_id', 'role', 'streaming', 'created_at', 'payload_json'],
};

// T3 driver kinds (packages/contracts/src/model.ts) for the two agents the ledger stores.
const providerForDriver = new Map([['claudeAgent', 'claude'], ['codex', 'codex']]);

export const threadIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;

const refusals = {
  noRun: 'This T3 thread has no recorded agent run, so its agent is unknown.',
  unknownAgent: 'This T3 thread has a run whose agent is not recorded.',
  manyAgents: 'This T3 thread was run by more than one agent. Only threads run by one agent are imported.',
  otherAgent: 'This T3 thread was run by an agent other than Claude Code or Codex.',
  badMessage: 'A message in this T3 thread could not be read.',
  noMessages: 'This T3 thread has no finished user or assistant messages.',
};

function isLiveStore(path) {
  // T3 keeps its database at <base-dir>/userdata/statev2.sqlite (apps/server/src/config.ts).
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // Checked again by the open below.
  }
  return [path, real].some(candidate => basename(candidate).toLowerCase() === 'statev2.sqlite'
    && basename(dirname(candidate)).toLowerCase() === 'userdata');
}

function hasSqliteHeader(path) {
  const header = Buffer.alloc(16);
  const descriptor = openSync(path, 'r');
  try {
    return readSync(descriptor, header, 0, 16, 0) === 16 && header.toString('latin1') === 'SQLite format 3\0';
  } finally {
    closeSync(descriptor);
  }
}

function checkLayout(database) {
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const present = new Set(database.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(row => row.name));
    if (!columns.every(column => present.has(column))) throw new T3ImportError(unsupportedLayout);
  }
  const head = database.prepare('SELECT MAX(migration_id) AS head FROM effect_sql_migrations').get().head;
  if (head !== t3Release.schemaHead) throw new T3ImportError(unsupportedLayout);
  const nameAt = database.prepare('SELECT name FROM effect_sql_migrations WHERE migration_id = ?');
  for (const [id, name] of requiredMigrations) {
    const rows = nameAt.all(id);
    if (rows.length !== 1 || rows[0].name !== name) throw new T3ImportError(unsupportedLayout);
  }
}

/** Opens a copy of T3's database read-only and checks its layout. Throws T3ImportError. */
export function openT3Copy(path) {
  if (typeof path !== 'string' || path.length === 0) throw new T3ImportError('Choose a copy of the T3 Code database.');
  const absolute = resolve(path);
  if (isLiveStore(absolute)) {
    throw new T3ImportError('This looks like T3 Code\'s own database. Quit T3 Code, copy statev2.sqlite to another folder, and import the copy.');
  }
  let database;
  try {
    if (!statSync(absolute).isFile()) throw new T3ImportError(unreadable);
    if (!hasSqliteHeader(absolute)) throw new T3ImportError('This file is not a SQLite database.');
    database = new DatabaseSync(absolute, { readOnly: true });
    database.exec('PRAGMA query_only = ON');
    checkLayout(database);
  } catch (error) {
    database?.close();
    if (error instanceof T3ImportError) throw error;
    throw new T3ImportError(unreadable);
  }
  return reader(database);
}

function agentOf(drivers, unresolved) {
  if (unresolved > 0 || drivers.some(driver => typeof driver !== 'string')) return { refusal: refusals.unknownAgent };
  if (drivers.length === 0) return { refusal: refusals.noRun };
  if (drivers.length > 1) return { refusal: refusals.manyAgents };
  const provider = providerForDriver.get(drivers[0]);
  return provider ? { provider } : { refusal: refusals.otherAgent };
}

// One JSONL line per message, in the mapped provider's format, so the existing parser imports it.
function messageLine(provider, role, text) {
  if (provider === 'claude') return JSON.stringify({ type: role, message: { role, content: text } });
  const blockType = role === 'user' ? 'input_text' : 'output_text';
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: blockType, text }],
      // A user.* kind tells the Codex parser this block is the person's text, not injected context.
      ...(role === 'user' ? { internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.t3_message'] } } : {}),
    },
  });
}

function isConversation(row, payload) {
  if (row.streaming !== 0) return false;
  if (typeof payload?.text !== 'string' || !payload.text.trim()) return false;
  if (row.role === 'assistant') return true;
  // T3 counts a user-role message as the person's only when createdBy is user or absent
  // (apps/server/src/orchestration-v2/messageSearchIndex.ts).
  return row.role === 'user' && (payload.createdBy === undefined || payload.createdBy === 'user');
}

function reader(database) {
  const listThreads = database.prepare(`
    SELECT thread_id AS id, title FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL ORDER BY created_at ASC, thread_id ASC
  `);
  const findThread = database.prepare(`
    SELECT thread_id AS id, title FROM orchestration_v2_projection_threads
    WHERE thread_id = ? AND deleted_at IS NULL
  `);
  const providerThreadIds = `
    SELECT provider_thread_id AS id FROM orchestration_v2_projection_runs
    WHERE thread_id = $thread AND provider_thread_id IS NOT NULL
    UNION
    SELECT provider_thread_id FROM orchestration_v2_projection_run_attempts
    WHERE thread_id = $thread AND provider_thread_id IS NOT NULL
  `;
  const drivers = database.prepare(`
    SELECT DISTINCT provider.driver AS driver
    FROM (${providerThreadIds}) AS ids
    JOIN orchestration_v2_projection_provider_threads AS provider ON provider.provider_thread_id = ids.id
  `);
  const unresolved = database.prepare(`
    SELECT COUNT(*) AS count FROM (${providerThreadIds}) AS ids
    WHERE NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_provider_threads AS provider
      WHERE provider.provider_thread_id = ids.id
    )
  `);
  const models = database.prepare(`
    SELECT DISTINCT json_extract(payload_json, '$.modelSelection.model') AS model
    FROM orchestration_v2_projection_runs
    WHERE thread_id = ? AND json_valid(payload_json)
      AND json_type(payload_json, '$.modelSelection.model') = 'text'
    ORDER BY model
  `);
  // T3 reads a thread's messages in this order (ProjectionStore.ts).
  const messages = database.prepare(`
    SELECT role, streaming, payload_json AS payload FROM orchestration_v2_projection_messages
    WHERE thread_id = ? ORDER BY created_at ASC, message_id ASC
  `);

  const describe = ({ id, title }) => {
    if (typeof id !== 'string' || !threadIdPattern.test(id)) {
      return { id: null, refusal: 'This T3 thread ID has an unsupported form.' };
    }
    const agent = agentOf(
      drivers.all({ $thread: id }).map(row => row.driver),
      unresolved.get({ $thread: id }).count,
    );
    return { id, title: typeof title === 'string' ? title : '', ...agent };
  };

  const transcript = thread => {
    const lines = [];
    let count = 0;
    for (const row of messages.all(thread.id)) {
      let payload;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        return { refusal: refusals.badMessage };
      }
      if (isConversation(row, payload)) {
        lines.push(messageLine(thread.provider, row.role, payload.text));
        count += 1;
      } else {
        // Keeps line n on the thread's message n.
        lines.push('{}');
      }
    }
    if (count === 0) return { refusal: refusals.noMessages };
    // The thread ID keeps two threads with the same text apart; the parser skips this line.
    lines.push(JSON.stringify({ t3: { threadId: thread.id } }));
    return { messageCount: count, transcript: lines.join('\n') + '\n' };
  };

  // A SQLite error mid-read (a damaged copy) becomes the fixed sentence, never its own text.
  const guarded = read => (...args) => {
    try {
      return read(...args);
    } catch (error) {
      if (error instanceof T3ImportError) throw error;
      throw new T3ImportError(unreadable);
    }
  };

  return {
    /** Threads in the copy, or the one named, with their agent or the reason they are refused. */
    threads: guarded(threadId => {
      if (threadId === undefined) return listThreads.all().map(describe);
      const row = findThread.get(threadId);
      if (!row) throw new T3ImportError('T3 thread not found in this copy.');
      return [describe(row)];
    }),

    /** What --list prints for one described thread. */
    summary: guarded(thread => {
      if (thread.refusal) return { thread: thread.id, refused: thread.refusal };
      const built = transcript(thread);
      return {
        thread: thread.id,
        agent: thread.provider,
        models: models.all(thread.id).map(row => row.model),
        ...(built.refusal ? { refused: built.refusal } : { messages: built.messageCount }),
        title: thread.title,
      };
    }),

    /** The import request for one described thread: { provider, source, transcript } or { refusal }. */
    importRequest: guarded(thread => {
      if (thread.refusal) return { refusal: thread.refusal };
      const built = transcript(thread);
      if (built.refusal) return built;
      return { provider: thread.provider, source: `t3-${thread.id}.jsonl`, transcript: built.transcript };
    }),

    close() {
      database.close();
    },
  };
}
