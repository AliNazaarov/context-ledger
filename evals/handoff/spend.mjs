// The spend log: one JSON line per benchmark run (one agent call in one arm). It holds
// numbers, flags and names only (date, arm, agent, model, tokens, cost, time, scores),
// never transcript or answer text, and lives under the Git-ignored .context-ledger/.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultSpendLog = join(fileURLToPath(new URL('../..', import.meta.url)), '.context-ledger', 'benchmarks', 'handoff-spend.jsonl');

const count = value => (Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

/** Build a log row from a run. Only the listed fields are kept, so no text can slip in. */
export function spendRow({ date, runId, index, position, arm, agent, model, timeoutS, result, gradeA, gradeB }) {
  const crossToolCalls = result.crossToolCalls ?? 0;
  const offToolCalls = result.offToolCalls ?? 0;
  const valid = Boolean(result.ok) && !result.timedOut && offToolCalls === 0 && crossToolCalls === 0;
  return {
    v: 1,
    date,
    runId,
    index,
    position,
    arm,
    agent,
    model,
    timeoutS,
    ok: Boolean(result.ok),
    timedOut: Boolean(result.timedOut),
    offToolCalls,
    crossToolCalls,
    valid,
    tokens: { input: count(result.tokens?.input), cached: count(result.tokens?.cached), output: count(result.tokens?.output) },
    costUsd: typeof result.costUsd === 'number' && Number.isFinite(result.costUsd) ? result.costUsd : null,
    ms: count(result.ms),
    score: { b: gradeB.score, a: gradeA.score, total: gradeB.total },
    facts: Object.fromEntries(Object.entries(gradeB.results).map(([key, right]) => [key, Boolean(right)])),
    graderDisagreements: Object.keys(gradeB.results).filter(key => Boolean(gradeA.results[key]) !== Boolean(gradeB.results[key])).length,
  };
}

export async function appendSpend(path, row) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(row) + '\n');
}

export async function readSpend(path) {
  const text = await readFile(path, 'utf8').catch(error => (error.code === 'ENOENT' ? '' : Promise.reject(error)));
  return text.split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line);
      return row?.v === 1 ? [row] : [];
    } catch {
      return [];
    }
  });
}

const mean = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const round = (value, digits = 0) => (value === null ? null : Number(value.toFixed(digits)));

/**
 * Aggregates per agent, model and arm. Time and token means are over valid runs only.
 * Scores and pass rates are over all runs, with a failed, timed-out or invalid run
 * counting as 0, so an arm cannot look better by failing its hard runs.
 */
export function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.agent, row.model, row.arm]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(group => {
    const valid = group.filter(row => row.valid);
    const scored = group.map(row => (row.valid ? row.score.b : 0));
    const total = group[0].score.total;
    const factKeys = Object.keys(group[0].facts);
    const costs = valid.map(row => row.costUsd).filter(value => value !== null);
    return {
      agent: group[0].agent,
      model: group[0].model,
      arm: group[0].arm,
      runs: group.length,
      valid: valid.length,
      failed: group.filter(row => !row.ok).length,
      timedOut: group.filter(row => row.timedOut).length,
      invalid: group.filter(row => row.ok && !row.timedOut && !row.valid).length,
      meanMs: round(mean(valid.map(row => row.ms))),
      meanTokens: {
        input: round(mean(valid.map(row => row.tokens.input))),
        cached: round(mean(valid.map(row => row.tokens.cached))),
        output: round(mean(valid.map(row => row.tokens.output))),
      },
      costUsd: { total: costs.length ? round(costs.reduce((a, b) => a + b, 0), 4) : null, mean: round(mean(costs), 4), reported: costs.length },
      meanScore: round(mean(scored), 2),
      total,
      meanScoreA: round(mean(group.map(row => (row.valid ? row.score.a : 0))), 2),
      fullPassRate: round(mean(group.map(row => (row.valid && row.score.b === total ? 1 : 0))), 2),
      factPassRate: Object.fromEntries(factKeys.map(key => [key, round(mean(group.map(row => (row.valid && row.facts[key] ? 1 : 0))), 2)])),
      meanGraderDisagreements: round(mean(group.map(row => row.graderDisagreements)), 2),
    };
  });
}

export function formatSummary(summary) {
  if (!summary.length) return 'No benchmark runs logged yet.';
  return summary.map(group => [
    `${group.agent} ${group.model} ${group.arm}: ${group.valid}/${group.runs} valid (${group.failed} failed, ${group.timedOut} timed out, ${group.invalid} invalid)`,
    `  score ${group.meanScore}/${group.total} by grader B (A ${group.meanScoreA}), full pass ${group.fullPassRate}, grader disagreements per run ${group.meanGraderDisagreements}`,
    `  mean ${group.meanMs ?? '-'} ms, tokens in ${group.meanTokens.input ?? '-'} (cached ${group.meanTokens.cached ?? '-'}), out ${group.meanTokens.output ?? '-'}, ` +
      `cost ${group.costUsd.total === null ? 'not reported' : `$${group.costUsd.total} total, $${group.costUsd.mean} mean over ${group.costUsd.reported}`}`,
    `  per fact: ${Object.entries(group.factPassRate).map(([key, rate]) => `${key} ${rate}`).join(', ')}`,
  ].join('\n')).join('\n');
}
