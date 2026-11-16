import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gradeSlice } from '../evals/latent/grade.mjs';
import { isSecretPath, normalizeSpace } from '../src/latent.mjs';
import rules from '../rules/latent-rules.json' with { type: 'json' };
import cases from '../rules/latent-conformance.json' with { type: 'json' };

// H4: rules shared with the Python runtime. rules/latent-rules.json holds the data both
// languages read; rules/latent-conformance.json holds cases that this file and
// runtime/tests/test_rule_conformance.py both run, so a rule changed in one language
// only fails one of the two suites.

const repoFile = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const files = new Map();
function questionOf(entry) {
  if (entry.question) return entry.question;
  const { file, id } = entry.questionRef;
  if (!files.has(file)) files.set(file, repoFile(file));
  const question = files.get(file).questions.find(item => item.id === id);
  assert.ok(question, `${file} has question ${id}`);
  return question;
}

function codePoints(entries) {
  return entries.flatMap(entry => {
    const [low, high = low] = entry.split('-');
    const start = Number.parseInt(low, 16);
    const end = Number.parseInt(high, 16);
    assert.ok(/^[0-9A-F]{4,6}(?:-[0-9A-F]{4,6})?$/u.test(entry) && start <= end, entry);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  });
}

test('H4: the secret-file rule decides every shared case as the table says', () => {
  assert.ok(cases.secretPaths.length >= 30);
  assert.ok(cases.secretPaths.some(entry => entry.secret) && cases.secretPaths.some(entry => !entry.secret));
  for (const { path, secret } of cases.secretPaths) assert.equal(isSecretPath(path.split('/')), secret, path);
});

test('H4: every secret list entry is exercised by a shared case', () => {
  const { dirs, names, prefixes, suffixes, templates } = rules.secretPaths;
  const lower = cases.secretPaths.map(entry => ({ ...entry, segments: entry.path.toLowerCase().split('/') }));
  const secret = lower.filter(entry => entry.secret);
  for (const dir of dirs) assert.ok(secret.some(entry => entry.segments.slice(0, -1).includes(dir)), dir);
  for (const name of names) assert.ok(secret.some(entry => entry.segments.at(-1) === name), name);
  for (const prefix of prefixes) assert.ok(secret.some(entry => entry.segments.at(-1).startsWith(prefix) && entry.segments.at(-1) !== prefix), prefix);
  for (const suffix of suffixes) assert.ok(secret.some(entry => entry.segments.at(-1).endsWith(suffix)), suffix);
  for (const name of templates) assert.ok(lower.some(entry => !entry.secret && entry.segments.at(-1) === name), name);
});

test('H4: the shared whitespace list is exactly what /\\s/u matches', () => {
  const listed = codePoints(rules.quoteWhitespace.codePoints);
  const javascript = [];
  for (let code = 0; code <= 0x10ffff; code += 1) if (/\s/u.test(String.fromCodePoint(code))) javascript.push(code);
  assert.deepEqual(listed, javascript);
  // The characters Python's str.split() treats differently are covered on both sides.
  for (const code of [0x1c, 0x1d, 0x1e, 0x1f, 0x85]) assert.ok(!listed.includes(code), code.toString(16));
  assert.ok(listed.includes(0xfeff));
});

test('H4: the ledger folds whitespace in every shared case as the table says', () => {
  for (const { text, folded } of cases.quoteWhitespace) assert.equal(normalizeSpace(text), folded, JSON.stringify(text));
  // Every listed code point folds, and its neighbours outside the list do not.
  const listed = new Set(codePoints(rules.quoteWhitespace.codePoints));
  for (let code = 0; code <= 0xffff; code += 1) {
    assert.equal(normalizeSpace(`a${String.fromCharCode(code)}b`) === 'a b', listed.has(code), code.toString(16));
  }
});

test('H4: the grader decides every shared graded answer as the table says', () => {
  assert.ok(cases.grader.length >= 20);
  for (const entry of cases.grader) {
    const question = questionOf(entry);
    const { correct, cited } = gradeSlice(question, entry.slice);
    assert.deepEqual({ correct, cited }, entry.expected, `${question.id}: ${JSON.stringify(entry.slice)}`);
  }
  // Questions only JavaScript can grade still grade here.
  for (const entry of cases.graderJavaScriptOnly) {
    assert.equal(typeof gradeSlice(questionOf(entry), { answer: 'x' }).correct, 'boolean');
  }
});
