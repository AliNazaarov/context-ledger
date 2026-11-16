// The HTTP client to the running ledger on loopback. Errors are fixed texts or the
// ledger's own short, single-line messages.
import { ToolError } from './common.mjs';

export function ledgerPort() {
  const port = Number(process.env.PORT ?? 4317);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

export const port = ledgerPort();
if (port === undefined) {
  console.error('Invalid PORT.');
  process.exit(1);
}
export const origin = `http://127.0.0.1:${port}`;

export function validLedgerMessage(message) {
  // Zl/Zp are line breaks to many readers; a message with one is not passed through.
  return typeof message === 'string' && message.length > 0 && message.length <= 200 && !/[\p{C}\p{Zl}\p{Zp}]/u.test(message);
}

export async function ledger(path, { body, notFound, timeoutMs = 5000 } = {}) {
  const init = { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.method = 'POST';
    init.headers = { 'Content-Type': 'application/json', Origin: origin };
    init.body = body;
  }
  let response;
  try {
    response = await fetch(origin + path, init);
  } catch (error) {
    // A timed-out publish may still have been stored; an exact retry returns the same ID.
    if (error?.name === 'TimeoutError') {
      throw new ToolError(`Context Ledger did not answer within ${timeoutMs / 1000} seconds. Retrying a publish is safe: an identical publish returns the same ID.`);
    }
    if (error?.cause?.code === 'ECONNREFUSED') {
      throw new ToolError(`Cannot reach Context Ledger on port ${port}. Start it with npm start.`);
    }
    throw new ToolError(`Context Ledger request to port ${port} failed (for example, a redirect, which is refused).`);
  }
  if (response.status === 404 && notFound) {
    await response.body?.cancel().catch(() => {});
    throw new ToolError(notFound);
  }
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      const problem = await response.json().catch(() => null);
      if (validLedgerMessage(problem?.error)) throw new ToolError(problem.error);
    } else {
      await response.body?.cancel().catch(() => {});
    }
    throw new ToolError(`Context Ledger returned HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new ToolError('Context Ledger returned an unreadable response.');
  }
}

/** GET a list page. The ledger's cursor error becomes a fixed one that names no value. */
export async function listPage(path, notFound) {
  try {
    return await ledger(path, { notFound });
  } catch (error) {
    if (error instanceof ToolError && error.message === 'Unknown cursor.') {
      throw new ToolError('after does not name a listed item; call again without after.');
    }
    throw error;
  }
}

export const olderLedger = 'Context Ledger is running an older version without paging. Restart it with npm start.';
