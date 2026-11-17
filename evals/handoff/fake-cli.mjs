#!/usr/bin/env node
// A stand-in for the claude and codex CLIs, used by the tests and by
// `run.mjs --fake-cli`. It reads the prompt on stdin and prints canned output in the
// CLI's own format, so the runner's parsing, grading, timing and spend log run for
// real without a model or any cost. It never contacts the ledger.
//   node fake-cli.mjs <claude|codex> <the CLI's arguments...>
// FAKE_HANDOFF_MODE: unset (normal), cross (also calls the other arm's tool),
// fail (exits 1), hang (never answers, for the timeout).
import { writeFileSync } from 'node:fs';

const [agent, ...args] = process.argv.slice(2);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const mode = process.env.FAKE_HANDOFF_MODE ?? '';
if (mode === 'hang') await new Promise(() => setInterval(() => {}, 1000));
if (mode === 'fail') {
  process.stderr.write('fake failure\n');
  process.exit(1);
}

const transcriptArm = /Call session_read/u.test(prompt);
const right = {
  port: 5210, launchDay: 'Thursday', database: 'Postgres', reviewer: 'Priya', budgetEur: 1800, region: 'eu-central-1',
  codename: 'Heron', retries: 3, backup: 'every 6 hours', freeze: 'Wednesday at 16:00', flag: 'beta_checkout',
  timeoutSeconds: 45, onCall: 'Dana', questionForTomas: 'Who signs the vendor contract?',
};
// The transcript arm answers as an agent that stopped after the first page would.
const answer = transcriptArm
  ? { ...right, port: 5100, reviewer: 'Jonas', backup: 'once a day', flag: null, timeoutSeconds: null, onCall: null, questionForTomas: null }
  : right;
const reply = JSON.stringify(answer);
const tools = transcriptArm ? ['session_read'] : ['context_for'];
if (mode === 'cross') tools.push(transcriptArm ? 'context_for' : 'session_read');

if (agent === 'claude') {
  const say = event => process.stdout.write(JSON.stringify(event) + '\n');
  say({ type: 'system', subtype: 'init', tools: tools.map(name => `mcp__context-ledger__${name}`) });
  for (const name of tools) {
    say({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${name}`, name: `mcp__context-ledger__${name}`, input: {} }] } });
    say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${name}`, content: 'fake' }] } });
  }
  say({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
  say({
    type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: transcriptArm ? 0.0421 : 0.0113,
    usage: { input_tokens: 120, cache_read_input_tokens: transcriptArm ? 30000 : 4000, cache_creation_input_tokens: transcriptArm ? 2000 : 500, output_tokens: 310 },
  });
} else if (agent === 'codex') {
  const say = event => process.stdout.write(JSON.stringify(event) + '\n');
  say({ type: 'thread.started', thread_id: 'fake' });
  say({ type: 'turn.started' });
  for (const name of tools) {
    say({ type: 'item.started', item: { id: `i-${name}`, type: 'mcp_tool_call', server: 'context-ledger', tool: name, status: 'in_progress' } });
    say({ type: 'item.completed', item: { id: `i-${name}`, type: 'mcp_tool_call', server: 'context-ledger', tool: name, status: 'completed' } });
  }
  say({ type: 'item.completed', item: { id: 'i-answer', type: 'agent_message', text: reply } });
  say({ type: 'turn.completed', usage: { input_tokens: transcriptArm ? 41000 : 6000, cached_input_tokens: transcriptArm ? 20000 : 3000, output_tokens: 290 } });
  const last = args[args.indexOf('--output-last-message') + 1];
  writeFileSync(last, reply);
} else {
  process.stderr.write('usage: fake-cli.mjs <claude|codex> ...\n');
  process.exit(2);
}
