import { createHash } from 'node:crypto';
import { constants, mkdirSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, dirname, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { graphContext } from './context.mjs';
import { InputError } from './errors.mjs';
import { canonicalPacket, validateGraph } from './graph.mjs';
import { migrate } from './migrate.mjs';
import { mountRooms } from './rooms.mjs';

export { InputError };

const summaryColumns = 'id, provider, source, title, message_count AS messageCount';
const codexContextKinds = new Set([
  'agents_md.instructions',
  'environments.environment_context',
  'additional_content.codex_apps_open_page',
  'skills.selected_skill_instructions',
]);


export function isProvider(value) {
  return value === 'claude' || value === 'codex';
}

function isCodexContext(text, kind) {
  if (codexContextKinds.has(kind)) return true;
  if (typeof kind === 'string' && kind.startsWith('user.')) return false;

  // Older rollouts omit per-block metadata, so check complete reserved envelopes.
  const value = text.trim();
  return /^<(environment_context|user_instructions|turn_aborted)>[\s\S]*<\/\1>$/u.test(value)
    || /^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\r?\n<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>$/u.test(value);
}

function messageAt(record, provider, line) {
  const message = provider === 'claude' ? record?.message : record?.payload;
  const role = message?.role;
  if (role !== 'user' && role !== 'assistant') return;

  if (provider === 'claude' && (record.type !== role || record.isMeta === true)) return;
  if (provider === 'codex' && (record.type !== 'response_item' || message.type !== 'message')) return;

  const content = message.content;
  const blockType = provider === 'claude' ? 'text' : role === 'user' ? 'input_text' : 'output_text';
  let text;
  if (provider === 'claude' && typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const codexUser = provider === 'codex' && role === 'user';
    const contentKinds = message.internal_chat_message_metadata_passthrough?.content_item_kinds;
    const kinds = Array.isArray(contentKinds) && contentKinds.length === content.length ? contentKinds : [];
    text = content
      .filter((block, index) => block?.type === blockType && typeof block.text === 'string'
        && (!codexUser || !isCodexContext(block.text, kinds[index])))
      .map(block => block.text)
      .join('\n');
  }

  if (text?.trim()) return { role, text, line };
}

// How many skipped line numbers an import reports; the count covers all of them.
const skippedLinesShown = 10;

/**
 * Card I2: a line that is not JSON (often a last line cut off while the agent was still
 * writing) is skipped and counted instead of rejecting the whole file. Messages keep their
 * line numbers in the file, so citations stay true. A file with no readable line at all is
 * still refused, since it is not JSONL.
 */
// Card I1: what one session may hold until P1 stores one row per message, in UTF-8 bytes.
// The message budget counts each message as stored (text, role, line and JSON syntax), so
// it bounds many small messages as well as a few large ones. A line longer than the line
// limit is skipped like an unreadable one, before it is ever joined.
export const maxMessageBytes = 64 * 1024 * 1024;
export const maxLineBytes = 64 * 1024 * 1024;

function transcriptParser(provider) {
  const messages = [];
  // The count covers every skipped line; only the first few line numbers are kept.
  const skipped = { count: 0, lines: [] };
  const skip = line => {
    skipped.count += 1;
    if (skipped.lines.length < skippedLinesShown) skipped.lines.push(line);
  };
  let readable = 0;
  let line = 0;
  let bytes = 0;
  return {
    /** One line of the file, in order, without its line break. */
    add(rawLine) {
      line += 1;
      const value = rawLine.trim();
      if (!value) return;

      let record;
      try {
        record = JSON.parse(value);
      } catch {
        skip(line);
        return;
      }
      readable += 1;
      const message = messageAt(record, provider, line);
      if (!message) return;
      bytes += Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
      if (bytes > maxMessageBytes) {
        throw new InputError('This transcript has more than 64 MiB of messages, more than one session can hold.');
      }
      messages.push(message);
    },
    /** A line too long to read; it counts as unreadable. */
    skipLine() {
      line += 1;
      skip(line);
    },
    finish() {
      if (readable === 0 && skipped.count) throw new InputError(`Invalid JSONL at line ${skipped.lines[0]}.`);
      if (messages.length === 0) throw new InputError('No supported conversation messages found.');
      return { messages, skipped };
    },
  };
}

function parseTranscript(transcript, provider) {
  const parser = transcriptParser(provider);
  for (const rawLine of transcript.split('\n')) parser.add(rawLine);
  return parser.finish();
}

/**
 * Card I1: parse a transcript file as a stream, so a file far larger than the 8 MiB HTTP
 * limit never sits in memory whole. The text is decoded the way a browser File.text()
 * decodes it (UTF-8, a leading byte-order mark dropped, bad bytes replaced), so the
 * session ID matches a browser import of the same file.
 */
async function parseTranscriptFile(path, provider, { lineLimit = maxLineBytes } = {}) {
  const unreadable = () => new InputError('Cannot read the transcript file.');
  const notAFile = () => new InputError('The transcript must be a regular file.');
  // The path is checked before it is opened, so a FIFO or device is never opened; the
  // descriptor is checked again in case the path was swapped in between.
  let info;
  try {
    info = await stat(path);
  } catch {
    throw unreadable();
  }
  if (!info.isFile()) throw notAFile();

  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    throw unreadable();
  }
  const closeQuietly = () => file.close().catch(() => {});

  const hash = createHash('sha256').update(`${provider}\0`);
  const parser = transcriptParser(provider);
  const decoder = new TextDecoder('utf-8');
  // The current line, as fragments joined once it ends; dropped if it passes the limit.
  let fragments = [];
  let length = 0;
  let tooLong = false;
  const append = piece => {
    if (tooLong || !piece) return;
    length += Buffer.byteLength(piece, 'utf8');
    if (length > lineLimit) {
      tooLong = true;
      fragments = [];
    } else {
      fragments.push(piece);
    }
  };
  const endLine = () => {
    if (tooLong) parser.skipLine();
    else parser.add(fragments.join(''));
    fragments = [];
    length = 0;
    tooLong = false;
  };
  const take = text => {
    hash.update(text);
    let start = 0;
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
      append(text.slice(start, end));
      endLine();
      start = end + 1;
    }
    append(text.slice(start));
  };
  try {
    if (!(await file.stat()).isFile()) throw notAFile();
    try {
      for await (const chunk of file.createReadStream({ autoClose: false })) take(decoder.decode(chunk, { stream: true }));
    } catch (error) {
      throw error instanceof InputError ? error : unreadable();
    }
  } catch (error) {
    throw error instanceof InputError ? error : unreadable();
  } finally {
    await closeQuietly();
  }
  take(decoder.decode());
  endLine();
  return { id: hash.digest('hex'), ...parser.finish() };
}

function withSkipped(summary, skipped) {
  if (!skipped.count) return summary;
  return { ...summary, skipped: { count: skipped.count, lines: skipped.lines } };
}

function sourceName(source) {
  if (typeof source !== 'string') throw new InputError('Choose a transcript file.');
  const name = basename(win32.basename(source)).trim();
  if (!name || name === '.' || name === '..' || name.length > 255 || /\p{Cc}/u.test(name)) {
    throw new InputError('Invalid transcript file name.');
  }
  return name;
}

function sessionFilter(query, provider) {
  const tokens = [...new Set(query.toLowerCase().split(/\s+/u).filter(Boolean))];
  const conditions = tokens.map(() => 'instr(search_text, ?) > 0');
  const values = [...tokens];
  if (provider) {
    conditions.push('provider = ?');
    values.push(provider);
  }
  return { conditions, values };
}

const whereClause = conditions => (conditions.length ? `WHERE ${conditions.join(' AND ')}` : '');

function titleFor(messages) {
  const first = messages.find(message => message.role === 'user') ?? messages[0];
  // The first 120 code points with runs of white space as one space, read only as far as
  // needed, so a title never ends in half of a surrogate pair and a huge message is not copied.
  const title = [];
  let space = false;
  for (const character of first.text.trim()) {
    if (/\s/u.test(character)) {
      space = true;
      continue;
    }
    if (space) title.push(' ');
    space = false;
    if (title.length >= 120) break;
    title.push(character);
    if (title.length >= 120) break;
  }
  return title.join('');
}

function serializeGraphPacket(packet) {
  // JSON object key order is insignificant. Array order remains part of the packet.
  return JSON.stringify(packet, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    }
    return value;
  });
}

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
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
  `);

  const insert = database.prepare(`
    INSERT INTO sessions (id, provider, source, title, message_count, messages, search_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `);
  const getSummary = database.prepare(`SELECT ${summaryColumns} FROM sessions WHERE id = ?`);
  const getDetail = database.prepare(`SELECT ${summaryColumns}, messages FROM sessions WHERE id = ?`);
  const insertGraph = database.prepare(`
    INSERT INTO graphs (id, session_id, payload)
    VALUES (?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `);
  const getGraph = database.prepare('SELECT payload FROM graphs WHERE id = ?');
  const readGraph = id => {
    const row = getGraph.get(id);
    if (row) return { id, ...JSON.parse(row.payload) };
  };
  // Schema version 1 adds the listing columns. Its triggers stamp created_at and party
  // on every new graph and room row, whichever build inserts it (src/migrate.mjs).
  const rooms = mountRooms(database, readGraph);
  try {
    migrate(database);
  } catch (error) {
    database.close();
    throw error;
  }

  // A list cursor is a row ID from an earlier page, resolved to its rowid at query time.
  const cursors = {
    sessions: database.prepare('SELECT rowid FROM sessions WHERE id = ?'),
    graphs: database.prepare('SELECT rowid FROM graphs WHERE id = ?'),
  };
  const before = (table, after) => {
    if (after === undefined || after === null) return null;
    const row = cursors[table].get(after);
    if (!row) throw new InputError('Unknown cursor.');
    return row.rowid;
  };
  const page = (rows, limit) => ({ rows: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].id : null });
  const selectGraphs = database.prepare(`
    SELECT g.id, g.session_id AS sessionId, s.title AS sessionTitle, g.party,
      CASE WHEN json_valid(g.payload) THEN json_extract(g.payload, '$.packet.version') END AS version,
      g.created_at AS createdAt,
      CASE WHEN json_valid(g.payload) THEN json_array_length(g.payload, '$.packet.nodes') END AS nodes,
      CASE WHEN json_valid(g.payload) THEN json_array_length(g.payload, '$.packet.edges') END AS edges,
      CASE WHEN json_valid(g.payload) THEN coalesce(json_array_length(g.payload, '$.packet.links'), 0) END AS links
    FROM graphs g LEFT JOIN sessions s ON s.id = g.session_id
    WHERE ($sessionId IS NULL OR g.session_id = $sessionId)
      AND ($party IS NULL OR g.party = $party)
      AND ($before IS NULL OR g.rowid < $before)
    ORDER BY g.rowid DESC LIMIT $n
  `);

  function save(id, provider, name, { messages, skipped }) {
    const existing = getSummary.get(id);
    if (existing) return withSkipped(existing, skipped);

    const title = titleFor(messages);
    const searchText = [title, ...messages.map(message => message.text)].join('\n').toLowerCase();
    insert.run(id, provider, name, title, messages.length, JSON.stringify(messages), searchText);
    return withSkipped(getSummary.get(id), skipped);
  }

  return {
    importTranscript(input) {
      const { provider, source, transcript } = input ?? {};
      if (!isProvider(provider)) throw new InputError('Choose Claude Code or Codex as the provider.');
      if (typeof transcript !== 'string') throw new InputError('Transcript must be JSONL text.');
      const name = sourceName(source);
      const id = createHash('sha256').update(`${provider}\0`).update(transcript).digest('hex');
      // Parsed before the duplicate check, so a repeated import reports the same skipped lines.
      return save(id, provider, name, parseTranscript(transcript, provider));
    },

    /** Card I1: import a transcript file by path, read as a stream; see parseTranscriptFile. */
    async importTranscriptFile(input, options) {
      const { provider, path } = input ?? {};
      if (!isProvider(provider)) throw new InputError('Choose Claude Code or Codex as the provider.');
      const name = sourceName(path);
      const { id, ...parsed } = await parseTranscriptFile(path, provider, options);
      return save(id, provider, name, parsed);
    },

    list(query, provider) {
      const { conditions, values } = sessionFilter(query, provider);
      return database.prepare(`SELECT ${summaryColumns} FROM sessions ${whereClause(conditions)} ORDER BY rowid DESC`).all(...values);
    },

    /** One page of list(), newest first; next is the last ID shown when more rows match. */
    listSessionsPage({ query, provider, limit, after }) {
      const { conditions, values } = sessionFilter(query, provider);
      const rowid = before('sessions', after);
      if (rowid !== null) {
        conditions.push('rowid < ?');
        values.push(rowid);
      }
      const rows = database.prepare(`SELECT ${summaryColumns} FROM sessions ${whereClause(conditions)} ORDER BY rowid DESC LIMIT ?`)
        .all(...values, limit + 1);
      const { rows: sessions, next } = page(rows, limit);
      return { sessions, next };
    },

    /** Published graphs, newest first, optionally for one session and/or one party. */
    listGraphs({ sessionId = null, party = null, limit, after }) {
      const rows = selectGraphs.all({ $sessionId: sessionId, $party: party, $before: before('graphs', after), $n: limit + 1 });
      const { rows: graphs, next } = page(rows, limit);
      return { graphs, next };
    },

    get(id) {
      const row = getDetail.get(id);
      if (row) return { ...row, messages: JSON.parse(row.messages) };
    },

    publishGraph(packet) {
      const sessionId = packet?.sessionId;
      if (typeof sessionId !== 'string' || !/^[a-f0-9]{64}$/u.test(sessionId)) {
        throw new InputError('Graph requires a valid transcript session ID.');
      }
      const session = getDetail.get(sessionId);
      if (!session) throw new InputError('Graph transcript session not found.');

      const sourceLines = JSON.parse(session.messages).map(message => message.line);
      const options = { lookupGraph: id => readGraph(id) };
      validateGraph(packet, sourceLines, options);
      // Derive from the canonical form so derived ID lists follow its order.
      const ordered = canonicalPacket(packet);
      const derived = validateGraph(ordered, sourceLines, options);
      const canonical = serializeGraphPacket(ordered);
      const id = createHash('sha256').update(canonical).digest('hex');
      const payload = { packet: JSON.parse(canonical), ...derived };
      insertGraph.run(id, sessionId, JSON.stringify(payload));
      return { id, ...JSON.parse(getGraph.get(id).payload) };
    },

    getGraph: readGraph,

    ...rooms,

    close() {
      database.close();
    },

    getGraphContext(id) {
      const graph = readGraph(id);
      if (!graph) return;
      const row = getDetail.get(graph.packet.sessionId);
      return graphContext(graph, { ...row, messages: JSON.parse(row.messages) }, { lookupGraph: readGraph });
    },
  };
}
