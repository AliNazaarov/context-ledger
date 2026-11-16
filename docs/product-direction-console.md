# Product direction: from an MCP server to a product people can see

*Draft, 2026-11-16. Comes from a team chat (Muhammadali and Ruslan) after the [T3 Code and Capy research](competitive-t3code-capy.md). Cards U1 to U3, D1 and D2 are on [the delivery board](delivery-board.md) as Backlog.*

## What the chat said

| Idea | Who | Read |
|---|---|---|
| Get the MCP server working and solid first, then build an app on top as the end vision | Muhammadali | Right order for the core, but "perfect" has no finish line. Define "good enough" with the existing cards (below). |
| "Imagine advertising an MCP server" on video | Muhammadali | The real problem: an MCP server is invisible. Its value shows up inside someone else's agent, so a video has nothing to point at. |
| NVIDIA pays a lot for an MCP that only does search | Ruslan | Plausible (enterprises do pay for search and retrieval MCPs), but **unsourced**. Keep it out of any pitch until we can cite it. |
| "UI???" / we need a UI as a product to advertise | Both | Agreed by both. This is the decision the chat actually reached. |
| "Mini-factory", "automizer" | Ruslan | **Undefined.** It could mean an agent orchestrator (like Capy's Captains), a content pipeline for videos, or an automated import pipeline. These lead to very different plans, so pin it down before building. |
| UI inspired by Grafana and T3, cute like Capy's design | Muhammadali | Good references, used differently (see below). Capy's capybara mascot and manga art are theirs. Take the *warmth*, make our own character and look. |

**Where the chat is right:** the product needs a face. Both competitors have one, and the research shows neither has a memory layer you can see or check.

**Where to be careful:** "an app like T3" can drift into building a control plane that runs agents. That market is taken by a free, MIT-licensed project with 62k stars (T3) and a funded cloud platform (Capy). We would lose that race. Our app should *show and prove* what agents know, not *run* agents.

## The positioning that fits: Grafana, not T3

Grafana doesn't run your services. It reads data that Prometheus collects and makes it visible. The same split fits us:

- **The ledger + MCP** is the data source: it imports transcripts, builds the cited graph, and serves agents.
- **The console** is the Grafana: one screen where a person sees what their agents know, where each fact came from, and what it saved.

Tagline candidate: **"See what your agents know, and the line that proves it."**

This also answers distribution. The console works no matter which tool runs the agents (Claude Code, Codex, T3 Code, Capy), so those tools become channels instead of rivals.

## What the console shows (and what makes a good video)

1. **Live graph.** When an agent publishes, nodes appear. Clicking a node opens the cited transcript turn with the lines highlighted. This is the 10-second shot for a video: agent works, graph grows, click proves it.
2. **Quoted vs inferred.** Each node is marked as quoted (its evidence contains the fact) or inferred (card G7). Grafana-style status colours.
3. **Dashboard panels**, Grafana-style:
   - Handoffs today, and tokens saved (the meter exists; label it as an estimate).
   - Which agent read or published what, and when (Claude Code, Codex, any MCP client).
   - Stale or superseded decisions (card G11, graph diff).
   - Dogfooding panels show aggregate counts only, never transcript text (AGENTS.md section 5).
4. **Rooms.** The two-person flow already in the browser, given the same visual style.
5. **Review.** Approve, edit or reject a node next to its evidence. This is card P3, folded into the console instead of being a separate screen.

The app is the existing loopback browser app opened by one command (`npx context-ledger` → it opens in the browser). That keeps the "no build step, Node 22" invariant. A desktop wrapper (Electron or Tauri) would need an ADR and doesn't add much for a video.

## Improved plan

Today the board runs P1 → P2 → P3 strictly, so a UI comes after two infrastructure waves. The chat's need (something to show) comes sooner than that. Proposed order:

**1. "Good enough" MCP (about 1–2 weeks). This replaces "perfect".**
- Merge C10 (PR #8, needs the human schema review).
- G7 quoted or inferred nodes: the console's core visual depends on it.
- G8 one-command install (`ledger install` for Claude Code and Codex): the product's own "advert" is a 30-second setup.
- G10 published benchmark: turns "3× faster, 5× fewer tokens" into a claim we can put in a video.
- Done when: a fresh machine goes from zero to an agent citing the ledger in under 5 minutes, and the benchmark is in `BENCHMARKS.md`.

**2. Console v0 (about 2 weeks, can start alongside step 1).**
- Built read-only on today's API (graphs, rooms, sessions, meter). It doesn't wait for P1/P2. Review actions (P3's write half) come after P2 as planned.
- Live graph, evidence pane, dashboard panels and an original mascot.
- Done when: a 60-second screen recording shows two agents, the graph growing, and a click-through to a cited line.

**3. Distribution through the tools that won (after the console).**
- Setup guides for adding the ledger as an MCP server in T3 Code (its outside-agents feature) and in Capy (it supports MCP servers).
- An explicit importer for T3's thread store (user-chosen file, per our import rule). T3 has a large audience and no memory, which makes it our best channel.
- MCP access levels (read only, supervised, full), borrowed from T3.

**4. Later, only if the "mini-factory" means orchestration:** do not build an orchestrator. Let orchestrators (Capy Captains, T3 `delegate_task`) read and write the ledger, and show their crews' work in the console. That gives the "factory" view without running agents ourselves.

## New cards (on the board as Backlog)

| Card | Scope |
|---|---|
| U1 Console v0 | Read-only Grafana-style console on the loopback app: live graph, evidence pane, dashboard panels from existing APIs |
| U2 Brand and mascot | Original character, palette and type; reference Capy's warmth only, no copied assets |
| U3 60-second demo video | Script and recording of install → two agents → graph → cited click, using synthetic transcripts only |
| D1 T3 Code integration | Setup guide as an outside MCP server, plus an explicit importer for T3's thread store |
| D2 Capy integration guide | How to add the ledger as an MCP server for a Capy organization |

## Open questions for the team

1. What do "mini-factory" and "automizer" mean exactly?
2. Who owns the console (U1) while P1 is in progress?
3. Is the NVIDIA claim from a source we can cite?
