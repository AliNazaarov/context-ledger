// P1e: tests that start the real server read its access token from the file next to
// its temporary database, the way the CLI and the MCP adapter do. The file is per port.
import { readTokenFile, tokenFileFor } from '../src/token.mjs';

/** The token of a server started on this database and port. */
export async function ledgerToken(database, port) {
  const token = (await readTokenFile(tokenFileFor(database, port)))?.token;
  if (token === undefined) throw new Error('The test server wrote no readable token file.');
  return token;
}

/** The Authorization header for a token. */
export const bearer = token => ({ Authorization: `Bearer ${token}` });
