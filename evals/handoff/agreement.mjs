#!/usr/bin/env node
// Agreement of the two graders with the hand-written labels and with each other.
//   node evals/handoff/agreement.mjs [--json]
// The labelled answers are synthetic, so printing their IDs and kinds is safe.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keywordGrader } from './grade-keyword.mjs';
import { valueGrader } from './grade-values.mjs';
import { fieldText } from './reply.mjs';

export const labelled = JSON.parse(readFileSync(new URL('labelled.json', import.meta.url), 'utf8')).items;

/** One grader's verdict on one labelled field, the same way gradeReply judges it. */
export function verdict(grader, item) {
  const text = fieldText(item.value).trim();
  return text !== '' && grader[item.fact](text);
}

export function agreement(items = labelled) {
  const rows = items.map(item => ({
    id: item.id, fact: item.fact, kind: item.kind, label: item.label === 'right',
    a: verdict(keywordGrader, item), b: verdict(valueGrader, item),
  }));
  const count = predicate => rows.filter(predicate).length;
  const byKind = {};
  for (const row of rows) {
    const entry = byKind[row.kind] ??= { items: 0, a: 0, b: 0 };
    entry.items += 1;
    entry.a += row.a === row.label ? 1 : 0;
    entry.b += row.b === row.label ? 1 : 0;
  }
  return {
    items: rows.length,
    right: count(row => row.label),
    wrong: count(row => !row.label),
    aWithLabels: count(row => row.a === row.label),
    bWithLabels: count(row => row.b === row.label),
    aWithB: count(row => row.a === row.b),
    aFalseAccepts: count(row => row.a && !row.label),
    aFalseRejects: count(row => !row.a && row.label),
    bFalseAccepts: count(row => row.b && !row.label),
    bFalseRejects: count(row => !row.b && row.label),
    byKind,
    disagreements: rows.filter(row => row.a !== row.label || row.b !== row.label || row.a !== row.b)
      .map(({ id, fact, kind, label, a, b }) => ({ id, fact, kind, label: label ? 'right' : 'wrong', a: a ? 'right' : 'wrong', b: b ? 'right' : 'wrong' })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = agreement();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const pct = value => `${value}/${report.items} (${Math.round((100 * value) / report.items)}%)`;
    console.log(`${report.items} labelled answers: ${report.right} right, ${report.wrong} wrong`);
    console.log(`grader A (keyword) agrees with the labels on ${pct(report.aWithLabels)}: ${report.aFalseAccepts} false accepts, ${report.aFalseRejects} false rejects`);
    console.log(`grader B (values)  agrees with the labels on ${pct(report.bWithLabels)}: ${report.bFalseAccepts} false accepts, ${report.bFalseRejects} false rejects`);
    console.log(`A and B agree with each other on ${pct(report.aWithB)}`);
    console.log('By kind (items, A right, B right):');
    for (const [kind, entry] of Object.entries(report.byKind)) console.log(`  ${kind}: ${entry.items}, ${entry.a}, ${entry.b}`);
    console.log('Disagreements (id, kind, label, A, B):');
    for (const row of report.disagreements) console.log(`  ${row.id} ${row.kind} label=${row.label} A=${row.a} B=${row.b}`);
  }
}
