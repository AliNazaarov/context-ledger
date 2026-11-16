# Benchmarks

## Handoff benchmark

One agent hands its context to another. We measure whether the receiving agent gets the facts right, and what that costs, when it reads the sender's raw transcript or the sender's graph.

The sender is Mira, working in Claude Code. The receiver is Tomas's agent. Mira's session is synthetic: 204 exchanges (408 JSONL lines) about moving a checkout service, mostly work chatter. The code lives in `evals/handoff/`. The stage demo in `demo/` is separate and is not used.

Live results are not recorded yet. Nothing below is a measured result of a model.

### The two arms

- **Transcript arm.** The agent calls `session_read` on Mira's session and follows its continuation notes to the end. The transcript takes two `session_read` pages.
- **Graph arm.** The agent calls `context_for` on a fixed, hand-written graph of the same session (`referenceGraph` in `evals/handoff/fixtures.mjs`). The graph keeps each superseded decision as its own node, linked by a `supersedes` edge, and cites transcript lines.

The graph is fixed so that every run reads the same content. The cost of making a graph is not part of either arm; measure it separately.

### The question

Both arms answer the same question: one JSON object with 14 keys. Each key is one fact.

- 6 facts change during the conversation (port, launch day, database, reviewer, budget, backup interval). The old value is a trap.
- 7 facts get their current value only after the first `session_read` page. 4 of them are not mentioned on the first page at all (feature flag, timeout, on-call person, open question).
- A test proves both points with the real `session_read` tool against a test ledger (`tests/handoff-bench.test.mjs`).

### Fairness rules

1. **Same model.** Both arms of a run use the same agent and the same `--model`. A live run must name the model.
2. **Same question.** Both prompts carry the same question text. Only the sentence that names the source differs.
3. **Same tools.** Both arms get the same two ledger tools, `session_read` and `context_for`, through the same MCP server. Claude Code gets no built-in tools (`--tools ''`). Codex runs in a read-only sandbox. A run that calls the other arm's tool, or any tool outside the ledger (a Codex shell command, for example), is invalid.
4. **Alternating order.** Run 1 reads the transcript first, run 2 the graph first, and so on. This spreads cache warm-up and time-of-day effects over both arms.
5. **One timeout.** Every agent call has the same timeout (`--timeout-s`, default 300 seconds). A call that hits it is killed and counted as timed out.
6. **Fresh state.** Each invocation starts its own ledger on a free port with a temporary database, and each agent call is a fresh, non-persistent session.

### What is counted

- **Tokens.** Claude Code: input is `input_tokens` plus cache reads plus cache writes; cached is the cache reads; output is `output_tokens`, all from the final `result` event. Codex: the sums of `input_tokens` (which already includes cached tokens), `cached_input_tokens` and `output_tokens` over every `turn.completed` event.
- **Cost.** Claude Code reports `total_cost_usd`, which is logged. Codex reports no cost, so its cost is logged as null. Compare Codex arms by tokens.
- **Time.** Wall-clock milliseconds from starting the CLI to its exit, on the same machine. It includes starting the MCP server and the model's latency.

### What counts as a pass

- **Per fact.** Grader B decides (`evals/handoff/grade-values.mjs`). A fact passes when its answer field asserts the current value and asserts no other value of the same type. A superseded value may appear only when it is marked as old ("5210 (was 5100)"). Grader A (`evals/handoff/grade-keyword.mjs`) is logged beside it, along with the number of facts where the two disagree.
- **Per run.** A run is valid when the CLI exits cleanly with a reply, does not time out, and makes no invalid tool call. A run passes when it is valid and all 14 facts pass.
- **In the summary.** Scores and pass rates are over all runs. A failed, timed-out or invalid run counts as 0, so an arm cannot look better by failing its hard runs. Time and token means are over valid runs only. Failed, timed-out and invalid runs are always reported as counts.

### Before quoting a number

- Quote a mean only with at least 10 valid runs per arm, for one agent and one model.
- Always give the number of runs, the number of valid runs and the failures next to the mean.
- Report per-fact pass rates, not only the total. The late facts are the point of the benchmark.

### The graders

Grader A checks for keywords, like `gradeHandoff` in `demo/fixtures.mjs`. It cannot see an extra false claim.

Grader B extracts every value of the fact's type from the field (ports, weekdays, people, amounts, regions, times, intervals, identifiers) and checks them against an explicit current value, explicit superseded values and values that were only mentioned. Any other asserted value fails the field.

`evals/handoff/labelled.json` holds 82 synthetic answers to single fields, each labelled by hand: right, paraphrase, superseded, superseded but marked as old, negated, hedged, missing, and right plus an added false detail. Run `node evals/handoff/agreement.mjs` for each grader's agreement with the labels and with each other, and for every disagreement. The current numbers are in `docs/evals.md` under G10.

Known limit: grader B does not look at claims of another type. "Thursday at 09:00" for the launch day adds a time the transcript never gives, and B still passes it.

### How to run it

Each live run costs money. Check the plan first.

```sh
node evals/handoff/run.mjs --agent codex --model <model> --runs 10 --dry-run
node evals/handoff/run.mjs --agent claude --model <model> --runs 10
node evals/handoff/run.mjs --agent codex --model <model> --runs 10
node evals/handoff/run.mjs --summary
```

- `--runs N` runs both arms N times each, in alternating order.
- `--timeout-s S` sets the one timeout for every call.
- `--spend-log PATH` writes the log somewhere else.
- `--keep-replies` also saves the replies next to the log, for checking the graders on live answers.
- `--fake-cli evals/handoff/fake-cli.mjs` runs everything with a stand-in CLI: no model and no cost. The tests use it.

The `claude` and `codex` CLIs must be installed and signed in for a live run.

### The spend log

Every run (one agent call in one arm) appends one JSON line to `.context-ledger/benchmarks/handoff-spend.jsonl`. Git ignores that folder. A line holds the date, run, arm and order, agent, model, timeout, validity flags, tokens (in, cached, out), cost, time, both scores and a pass flag per fact. It never holds transcript or answer text.

`--summary` prints only aggregates per agent, model and arm: counts, means and rates.
