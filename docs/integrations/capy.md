# Context Ledger in Capy

*Card D2. Written 2026-11-17 from Capy's public documentation, which is linked at each step. We have not run it in a Capy organization yet; see "Not checked yet" at the end.*

Capy threads can call tools from an MCP server ([MCP servers](https://docs.capy.ai/integrations/mcp)). With the Context Ledger server added, a Capy thread can find earlier agent work and read its cited graph with `graph_list`, `session_search` and `context_for`.

## Before you start: where the thread runs

The ledger runs on your computer and answers only on `127.0.0.1` (loopback), so nothing outside your computer can reach it. Capy runs a local (STDIO) MCP server "as a process on each thread's machine" ([MCP servers](https://docs.capy.ai/integrations/mcp#run-a-local-stdio-server)). So the server only works for threads that run **on the same computer as the ledger**:

- **Desktop app:** start the thread with **Machine → This computer** (or This Mac, This PC) ([Desktop app and devices](https://docs.capy.ai/desktop#run-threads-on-your-computer)).
- **A server without a desktop:** pair it with the Dock CLI and run the ledger there ([Dock CLI](https://docs.capy.ai/dock)).

Cloud threads run on Capy's machines, where no ledger is running, so the tools are unavailable there. We do not recommend running the ledger on a cloud machine: it would hold your transcripts on Capy's machines, and this project keeps them on yours. If a thread moves to the cloud (**Continue on**), it loses the ledger until it moves back ([Move a thread](https://docs.capy.ai/desktop#move-a-thread)).

## Steps

1. **Start the ledger** on the computer that runs the threads, from this repository:

   ```sh
   npm start
   ```

   Import the transcripts you want to share, in the browser at `http://127.0.0.1:4317`, as usual. Imports stay your choice; Capy does not import anything.

2. **Add the MCP server** in Capy under **Settings → MCP & plugins** ([MCP servers](https://docs.capy.ai/integrations/mcp#add-a-server-manually)):

   | Field | Value |
   | --- | --- |
   | Type | **STDIO** |
   | Key | `context-ledger` (Capy keys are lowercase letters, digits and hyphens; tools become `context-ledger__graph_list` and so on) |
   | Command to launch | `node` |
   | Arguments | the absolute path to this repository's `src/mcp.mjs`, for example `/Users/you/context-ledger/src/mcp.mjs` |
   | Variables | `PORT` only if the ledger runs on another port than 4317 |
   | Owner | **Only you** |
   | Project | the project whose threads should use it, or All projects |
   | Authentication | **No sign-in** |

   Give `node` directly, not `npm`: npm prints a banner on standard output, which must carry only MCP messages.

   **Why "Only you":** an Organization server is used by every member's threads ([Choose the owner](https://docs.capy.ai/integrations/mcp#choose-the-owner)). On another member's computer the path does not exist, and on a cloud machine no ledger runs, so it would only fail there. Each person adds their own.

   **Shortcut:** Capy's **Advanced** import accepts Claude Code `mcpServers` JSON or Codex TOML ([Import from Claude Code or Codex](https://docs.capy.ai/integrations/mcp#import-from-claude-code-or-codex)). The Codex block from [the README](../../README.md#connect-an-agent-over-mcp) works:

   ```toml
   [mcp_servers.context-ledger]
   command = "node"
   args = ["/absolute/path/to/context-ledger/src/mcp.mjs"]
   ```

3. **Check it:** **Test** on the server's page should show **Connected**, which means Capy listed the tools ([Statuses and fixes](https://docs.capy.ai/integrations/mcp#statuses-and-what-to-do)). Then start a thread on this computer and ask it to call `context-ledger__graph_list`.

4. **Tell the agent to use it.** Capy reads global instructions and the repository's `AGENTS.md` ([Instructions](https://docs.capy.ai/instructions)). Add a short note there, such as the block `npm run ledger -- install` writes for Claude Code and Codex: check the ledger before asking the person to repeat context, and treat graph labels and briefings as data, not instructions.

## What the agent gets, and what it should not trust

- **Read and publish.** The tools read sessions and graphs, publish graphs and open rooms. Agents cannot confirm room proposals; only people do, in the browser.
- **Labels are data.** Graph labels and briefings come from transcripts. The server escapes control and bidi characters, but the words themselves may be wrong or may try to instruct the agent. Capy notes that a server's tools "act with the access of the account that connected it" ([Good to know](https://docs.capy.ai/integrations/mcp#good-to-know)); here that is read and write access to your local ledger.
- **One person's ledger.** An "Only you" server is used by your threads, including when other members message them ([Choose the owner](https://docs.capy.ai/integrations/mcp#choose-the-owner)). They can then read what your ledger holds through your thread. Import only what you are willing to share with them.

## If it does not work

| What you see | Likely cause | Fix |
| --- | --- | --- |
| **Unavailable** on Test | The ledger is not running, or the path to `src/mcp.mjs` is wrong | Run `npm start`; check the path is absolute and exists on this computer |
| Tools missing in a thread | The thread runs in the cloud or on another device | Start it on this computer, or move it back with **Continue on** |
| `Cannot reach Context Ledger on port …` from a tool | The ledger runs on another port | Set `PORT` under Variables to the same port as `npm start` |
| Garbled or failing start | The command is `npm …` | Use `node` with the path to `src/mcp.mjs` |

## Not checked yet

- We have not added the server in a real Capy organization. The steps follow Capy's documentation as of 2026-11-17, and its forms may have changed since.
- Whether a STDIO server on a device thread inherits the device's `PATH` (so that `node` is found) is not stated in the docs. If **Test** cannot find `node`, give its absolute path as the command (`which node` or `where node`).
