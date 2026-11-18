# Context Ledger in T3 Code

*Card D1. Written 2026-11-17 from T3 Code's public documentation, linked at each step. We have not run T3 Code ourselves yet; see "Not checked yet" at the end.*

T3 Code is a control panel over agent CLIs you already have. It runs Claude Code through its Agent SDK and Codex through its App Server ([T3 Code README](https://github.com/pingdotgg/t3code)). Those agents keep their own configuration, so the ledger's MCP server reaches T3 threads the same way it reaches the CLIs.

## Add the ledger for T3's Claude and Codex threads

1. **Run the ledger where the agents run.** T3 can drive agents on a remote environment, and it uses "the Claude configuration on the connected server" ([Claude provider](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md)). The ledger answers on loopback only, so run `npm start` on the machine of the environment whose threads should use it.

2. **Register the server for the CLIs T3 uses**, on that machine:

   ```sh
   npm run ledger -- install            # Claude Code and Codex, user scope (add --dry-run to preview)
   ```

   `ledger install` comes with card G8 (its own pull request); until that is merged, register the server by hand, as in [the README](../../README.md#connect-an-agent-over-mcp). "T3 Code uses Claude Code's login and configuration" ([Claude provider](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md)), and its Codex instances use a Codex home with its own `config.toml` ([Codex provider](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md)), so a server registered there is the one T3's threads load.

3. **Instances with their own configuration folder** need the server in that folder too:

   | T3 instance setting | Register with |
   | --- | --- |
   | Claude **CLAUDE_CONFIG_DIR path**, such as `~/.claude_personal` | `CLAUDE_CONFIG_DIR=~/.claude_personal claude mcp add --scope user context-ledger -- node /path/to/context-ledger/src/mcp.mjs` |
   | Codex **CODEX_HOME path** other than `~/.codex` | `CODEX_HOME=/that/path codex mcp add context-ledger -- node /path/to/context-ledger/src/mcp.mjs` |

   T3 keeps separate Claude config directories isolated, including their local conversation state ([Claude provider](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md#separate-accounts-or-configurations)). A Codex shadow home shares the main home's configuration ([Codex provider](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md#multiple-cli-logins)), so register the server in the shared **CODEX_HOME path**, not in the shadow folder.

4. **Start a new thread**, so its agent session starts with the new server. Ask the agent to call `graph_list`. If the tools are missing, check the instance's config folder in **Settings → Providers**.

## Other providers

T3 also runs Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi and any ACP agent ([ACP providers](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-acp.md)). Each has its own way to add MCP servers. This guide covers only Claude Code and Codex, the two agents Context Ledger imports and has tested.

## T3's own MCP endpoint is the other direction

T3 serves `https://<environment>/mcp` so that outside agents can launch, read and stop T3 threads ([Outside agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md)). The ledger does not need it. An agent connected to both could read a T3 thread there and publish a graph here, but the graph must cite lines of a transcript imported into the ledger.

## Bringing T3 threads into the ledger

T3 has no export command for a whole thread ([Threads from older versions](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-migration.md#keeping-a-recovery-copy)). The ledger imports only transcripts that a person chooses, in Claude Code or Codex format.

- **Not built yet: an importer for T3's own database.** We did not build one in this card. The layout is not stable enough to read safely. T3's V2 database (`~/.t3/userdata/statev2.sqlite`) is event-sourced and its tables are not documented. The legacy tables that T3's docs query (`projection_threads`, and `projection_thread_messages` with `role` and `text` columns) differ from the columns in at least one published fork, which has `author` and `message_json`. An importer guessed from these would break or misread threads. It needs a real sample database with a known T3 version; see the D1 section of the eval log.
- **Until then:** Claude Code and Codex may keep their own session files for the work T3 runs (`~/.claude/projects/…` and `~/.codex/sessions/…`). We have not checked whether T3's way of running them writes those files. If it does, import them as usual.

## What the agent should not trust

The same rules apply as for the CLIs on their own. Graph labels and briefings are transcript data, not instructions. Only people confirm room proposals, in the browser. T3's own permission modes control which tools a thread may call ([Permission modes](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md)). Known bugs in those modes are listed in [our research note](../competitive-t3code-capy.md).

## Not checked yet

- We have not run T3 Code with the ledger. The steps follow T3's documentation as of 2026-11-17, and T3 ships several builds a day.
- Whether a T3 Claude session loads user-scope MCP servers from its config directory exactly as the `claude` CLI does is stated by T3 ("uses Claude Code's login and configuration") but not tested by us.
- Whether T3's runs write Claude Code and Codex session files is not tested.
