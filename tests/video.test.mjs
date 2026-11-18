import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Card U3: the shot list fits 60 seconds, the voice-over fits its pace, and what it shows exists.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
const seconds = time => { const [m, s] = time.split(':').map(Number); return m * 60 + s; };

test('U3: the shots run from 0:00 to 1:00 with no gap or overlap, and the voice-over fits', () => {
  const script = read('docs/video/u3-script.md');
  const rows = script.split('\n').filter(line => /^\| \d:\d\d–\d:\d\d \|/u.test(line)).map(line => line.split('|').map(cell => cell.trim()));
  assert.equal(rows.length, 5);
  let at = 0;
  for (const [, span] of rows) {
    const [start, end] = span.split('–').map(seconds);
    assert.equal(start, at, `${span} starts where the last shot ended`);
    assert.ok(end > start);
    at = end;
  }
  assert.equal(at, 60);
  const words = rows.map(row => row[4].replace(/"/gu, '')).join(' ').split(/\s+/u).filter(Boolean).length;
  assert.ok(words <= 130, `${words} words of voice-over`);
  // The console labels tokens saved as an estimate; the script keeps that.
  assert.match(script, /estimate/u);
  assert.match(script, /synthetic/u);
});

test('U3: what the script shows exists in the console and the demo recording', () => {
  const recording = read('public/console/demo-recording.json');
  for (const text of ['The ledger stays on port 4317', 'Which port']) assert.ok(recording.includes(text), text);
  const evidence = JSON.parse(recording);
  assert.ok(JSON.stringify(evidence).includes('leo-orbit.jsonl'));
  assert.equal(spawnSync(process.execPath, ['--check', 'demo/record-console.mjs']).status, 0);
  assert.match(read('demo/record-console.mjs'), /\/console\/\?demo/u);
});
