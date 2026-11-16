# Competitive research: T3 Code and Capy

*Researched 2026-11-16. Sources: about 40, mostly primary (repo docs, GitHub API, vendor docs and changelogs). Confidence: high for T3 Code. Medium for Capy, because almost every source is Capy's own and no independent review exists.*

## Summary

T3 Code and Capy both run coding agents, and neither one remembers what the agents learned.

- **T3 Code** is a free, MIT-licensed control panel over your own agent CLIs. It has 62.6k stars and shipped 10 stable releases in 4 weeks. Switching model mid-thread passes a slice of the transcript capped at 16k tokens. Nothing is extracted, deduplicated or cited.
- **Capy** is a paid cloud platform (YC F24) that runs many agents at once. Its agents share knowledge through Drive: markdown files plus a `DIGEST.md` that an LLM rewrites. Drive has no search and no citations, and its only provenance is a 24-hour version history.

Context Ledger's opening is the **evidence layer under both**: a local, vendor-neutral, cited graph of what agents decided, which any agent can read over MCP. Both tools accept MCP servers, so we can plug into them rather than compete with them.

## 1. T3 Code (pingdotgg/t3code)

**What it is.** Desktop, web, iOS and Android clients plus a `t3` CLI, all fed by one local server. The server drives the harnesses you already have:

- Claude through the Agent SDK
- Codex through its App Server
- Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, and any ACP agent

State lives in SQLite (`~/.t3/userdata/statev2.sqlite`) and is event-sourced. Remote access works over LAN, Tailscale, or the hosted T3 Connect relay. ([README](https://github.com/pingdotgg/t3code), [internals/overview](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md), [providers-acp](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-acp.md))

**How context moves between agents:**

- **Handing a thread to another model.** T3 sends a budgeted selection of the transcript, not an LLM-written summary. It keeps the original request, the recent turns and the command outcomes, and marks what it left out. The cap defaults to 16k tokens (`T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`). Reasoning, tool state and attachments are dropped. The receiving agent can pull omitted history through T3's thread-reading MCP tool. ([portable-handoffs](https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md))
  - The two docs disagree: the internals doc says text items are compacted to 240 characters ([context-handoffs](https://github.com/pingdotgg/t3code/blob/main/docs/internals/context-handoffs.md)).
  - T3's own docs tell users to restate important constraints themselves after a handoff.
- **Delegation.** The tools `delegate_task` and `create_threads` spawn subagent threads; typing `@model` names a model, and typing `@thread` attaches a reference to another thread.
- **Outside agents.** Each environment serves `https://<env>/mcp` behind OAuth, with tools to launch, read, search, wait on and stop threads. Access levels are Read only, Supervised, and Full. ([outside-agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md))
- **Persistence.** Threads are stored and searchable by title, branch, PR and message words (Cmd/Ctrl+K). There is no memory layer, no extracted facts or decisions, and no whole-thread export. *Inference from the user docs.*

**Traction.** 62,594 stars, 11,139 forks, about 478 contributors with accounts, and 1,221 open issues ([GitHub API](https://api.github.com/repos/pingdotgg/t3code)). Nightly builds ship 3–4 times a day. A third-party add-on, [t3-fleet-gateway](https://github.com/boundsj/t3-fleet-gateway), adds multi-machine OAuth, job IDs and webhooks.

**Weaknesses.**

- Permission modes are not respected ([#11458](https://github.com/pingdotgg/t3code/issues/11458), [#15353](https://github.com/pingdotgg/t3code/issues/15353)).
- `delegate_task` doesn't work across projects ([#30329](https://github.com/pingdotgg/t3code/issues/30329)).
- Pairing expires after a hard-coded 30 days ([#33183](https://github.com/pingdotgg/t3code/issues/33183)).
- Users report heavy resource use ([HN](https://news.ycombinator.com/item?id=50367589)).
- Handoffs lose context and are capped.

**Business model.** Free; the FAQ says "There's no way to pay us to use T3 Code." The money comes indirectly, through T3 Chat accounts that raise the Connect machine limits ([faq](https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md)).

## 2. Capy (capy.ai)

**Company.** The legal entity is Scrapybara, Inc., founded by Nalin Semwal and Justin Sun (both ex-MultiOn). YC Fall 2024, team of about 6 in San Francisco ([YC](https://www.ycombinator.com/companies/capy)). Funding is unverified: aggregators disagree.

The product has shifted a lot:

- Scrapybara, a VM product for computer-use agents
- Captain (planner) plus Build agent, Feb 2026
- Captain only, Apr 2026
- Desktop app, Oct 2026
- Captains as long-lived orchestrators, generally available, Oct 31, 2026 ([changelog](https://capy.ai/changelog))

**How context moves between agents:**

- **Drive** is a hosted file store outside git ([docs/drive](https://docs.capy.ai/drive.md)).
  - Scopes: organization, personal, project, automation, and one drive per Captain.
  - A root `AGENTS.md` holds the instructions for its scope, and skills live at `skills/<name>/SKILL.md`.
  - **It has no full-text or semantic search and no citations.**
  - History keeps saved versions and "the threads that made them" for 24 hours only.
- **Captain and crew** ([docs/captains](https://docs.capy.ai/captains)).
  - Crew threads read `CREW.md` and write their output into the Captain's Drive under `reports/` and `handoffs/`.
  - The Captain keeps its plan in `NOTES.md`, rewrites `DIGEST.md`, and posts a "Needs you" section to chat.
  - Captains can read and message each other.
- **Memory** is an undocumented experiment: "keeps what you teach Capy across threads".
- **Review agent.** It reads the diff, a checkout of the PR head, and the `AGENTS.md` files, then sends its findings to the thread that owns the PR, which fixes them (autofix).

**Architecture.** The agent loop runs in Capy's cloud. Each thread gets a Firecracker microVM with sealed secrets and a git proxy. With the Dock CLI, a thread can run on your own Linux, Mac or Windows machine instead. Models are bring-your-own with 0% markup. There is a full REST API ([llms.txt](https://docs.capy.ai/llms.txt)), and MCP servers can be added for one member or the whole organization ([security](https://capy.ai/security)).

**Pricing.** Lite $20, Pro $100, Max $200 and up. Unlimited members. Machine time is billed even when you bring your own model subscription. SSO is a $100/mo add-on below Enterprise ([pricing](https://capy.ai/pricing)).

**Traction.** Vendor claims only:

- A row of logos (Supermemory, Exa, Warp, Firecrawl…) with no testimonials.
- "Hundreds of thousands of PRs", with no method behind the number.
- A Terminal-Bench chart whose model pairings are unclear.

No independent review was found on Reddit, HN or the press. *That low visibility is itself a finding.*

**Weaknesses.**

- Cloud lock-in: thread history, Captain state and memory have no documented export.
- Credits don't roll over, and running tasks pause when credits run out.
- The review agent supports GitHub only.
- The digest is an LLM rewrite with no provenance back to the source.

## 3. What sets Context Ledger apart

| | T3 Code | Capy | Context Ledger |
|---|---|---|---|
| What moves between agents | Transcript slice capped at 16k tokens | Markdown files plus an LLM-rewritten digest | Cited semantic graph: every node points to transcript lines |
| Can you check a claim? | Only by re-reading the thread | No (24h version history) | Yes, through the citation to the original turn |
| Across vendors and tools | Only agents T3 runs | Only inside Capy | Any MCP client; Claude Code and Codex imports |
| Across people | One user's threads | One organization | Two parties in a room, confirmed by people in the browser |
| Where data lives | Local SQLite | Capy cloud | Local, loopback only |
| Measured benefit | None published | Vendor benchmark only | Cycle 7: about 3× faster and 5× fewer input tokens than the raw transcript on a long session, same accuracy |
| Prompt-injection stance | Permission modes (with open bugs) | Sealed secrets, VM isolation | Transcript text treated as data; control and bidi characters escaped |

Our strongest pitch line: **they move conversations, we move evidence.** Both competitors stop at "here is some text"; we add "here is what was decided, and the line that proves it."

## 4. What we can take from them

**From T3 Code:**

1. **An explicit handoff budget plus on-demand paging.** We already have `session_read` paging. We can add a token cap to `context_for` (an environment variable or argument) and list what was left out, so the agent knows exactly what to page in. This matches T3's model, with citations added.
2. **Access levels for MCP clients.** Read only, Supervised and Full fits our tools: read tools, then `graph_publish`, then room actions. This also addresses our known limit that party names are self-asserted.
3. **Search by branch and PR.** Add git branch and PR metadata to imported sessions so `session_search` can filter on them.
4. **Become T3's memory layer.** T3 has 62k stars and no memory. Two ways to get there:
   - An explicit importer for T3's `statev2.sqlite` threads, which follows our rule that imports are chosen by the user. It covers every agent T3 runs, ACP included.
   - Publishing Context Ledger as an outside MCP server T3 users can add.

   This is the highest-leverage move we found.
5. **Restating constraints.** T3 tells users to restate important constraints after a handoff because the handoff loses them. A "constraints" node type, cited and always included in `context_for`, solves that problem.

**From Capy:**

1. **Scoped knowledge.** Their scopes (organization, personal, project, per-orchestrator) map onto our graphs and rooms. A "project" scope across sessions would let a graph build up over time instead of covering one session.
2. **A cited digest.** Capy's `DIGEST.md` plus "Needs you" is a good format, but it has no provenance. We can generate the same digest from the graph, with every line cited, and show it in the browser.
3. **Respect the `AGENTS.md` and skills conventions.** When importing or briefing, surface the repository's `AGENTS.md`/`CLAUDE.md` rules as context nodes, so our handoffs carry the rules the next agent should follow.
4. **Make the API easy for agents to find.** Publish an `llms.txt` and an OpenAPI spec for the loopback API.
5. **Handle concurrent writes.** Capy keeps conflict copies when edits collide. Our `graph_publish` should do something explicit when two agents publish over the same snapshot.

## 5. Risks to watch

- **T3 moves very fast**: about 3 builds a day, and it already has thread search plus an MCP read surface. If it adds an extraction layer, our "memory" claim weakens. Citations and the two-party rooms are the parts that are hardest to copy.
- **Capy Memory** could leave the experiments page. Watch its changelog.
- Neither publishes a measured benefit for context handoff. Our cycle 7 numbers are an asset, but they come from synthetic demo sessions. Rerun them with more samples before using them publicly.

## Gaps and caveats

- Most Capy content was read through WebFetch summaries (the scrape timed out). Benchmark details still need a manual check.
- I couldn't find the Reddit post about a T3 "MCP Gateway" fork; the closest match is `boundsj/t3-fleet-gateway`, which is a separate add-on, not a fork.
- I haven't installed or run either product. Everything above comes from documentation and the API.
