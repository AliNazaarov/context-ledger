// MCP over stdio: newline-delimited JSON-RPC 2.0 in, one message per line out.
// stdout carries protocol messages only; diagnostics go to stderr.
import { RpcError, isObject } from './common.mjs';

const maxLineBytes = 16 * 1024 * 1024;

// The JSON-RPC methods, set once by serve().
let methods = {};
let outputClosed = false;

function send(message) {
  if (outputClosed) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

const sendError = (id, code, message) => send({ id, error: { code, message } });

async function dispatch(message) {
  if (Array.isArray(message)) return sendError(null, -32600, 'Batch requests are not supported.');
  if (!isObject(message)) return sendError(null, -32600, 'A message must be a JSON object.');

  const hasId = Object.hasOwn(message, 'id');
  const { id, method, params } = message;
  const validId = typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
  // A message without a method is a response; this server sends no requests, so ignore it.
  if (method === undefined && hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) return;
  // Without an id nothing can correlate a reply, so even a malformed notification is dropped.
  if (!hasId && typeof method === 'string') return;
  if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
    return sendError(validId ? id : null, -32600, 'Invalid JSON-RPC 2.0 request.');
  }
  if (!hasId) return; // Notification: never answered.
  if (!validId) return sendError(null, -32600, 'Request id must be a string or a number.');

  if (!Object.hasOwn(methods, method)) return sendError(id, -32601, 'Method not found.');
  if (params !== undefined && !isObject(params)) return sendError(id, -32602, 'params must be an object.');
  try {
    send({ id, result: await methods[method](params ?? {}) });
  } catch (error) {
    if (error instanceof RpcError) return sendError(id, error.code, error.message);
    console.error(`context-ledger mcp: ${method} failed:`, error);
    sendError(id, -32603, 'Internal error.');
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function handleLine(bytes) {
  let line;
  try {
    line = decoder.decode(bytes);
  } catch {
    return sendError(null, -32700, 'Message is not valid UTF-8.');
  }
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return sendError(null, -32700, 'Parse error.');
  }
  dispatch(message).catch(error => console.error('context-ledger mcp: dispatch failed:', error));
}

// Split stdin on LF without buffering more than one bounded line.
let chunks = [];
let lineBytes = 0;
let oversized = false;

/** Answer the given JSON-RPC methods on stdin and stdout until stdin ends. */
export function serve(table) {
  methods = table;
  process.stdout.on('error', () => {
    // The client stopped reading; there is no one left to answer.
    outputClosed = true;
    process.exit(0);
  });

  process.stdin.on('data', chunk => {
    let start = 0;
    while (start <= chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!oversized) {
        if (lineBytes + end - start > maxLineBytes) {
          oversized = true;
          chunks = [];
          lineBytes = 0;
          sendError(null, -32700, 'Message exceeds the 16 MiB line limit.');
        } else if (end > start) {
          chunks.push(chunk.subarray(start, end));
          lineBytes += end - start;
        }
      }
      if (newline === -1) break;
      if (!oversized) handleLine(Buffer.concat(chunks, lineBytes));
      oversized = false;
      chunks = [];
      lineBytes = 0;
      start = newline + 1;
    }
  });

  process.stdin.on('end', () => {
    // A final message without a trailing newline is still a message. Requests already in
    // flight finish and answer before the process exits on its own.
    if (!oversized && lineBytes > 0) handleLine(Buffer.concat(chunks, lineBytes));
    chunks = [];
    lineBytes = 0;
  });
}
