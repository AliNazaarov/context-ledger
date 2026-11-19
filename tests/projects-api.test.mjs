import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Card U5: GET /api/projects lists every project with its session count, for the
// library's project picker. Synthetic transcripts only.
async function startServer(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-projects-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(directory, 'ledger.sqlite') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const port = output.match(/listening at http:\/\/127\.0\.0\.1:(\d+)/u)?.[1];
    if (port) return `http://127.0.0.1:${port}`;
  }
  throw new Error(`Server exited: ${output}`);
}

const turn = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

async function importInto(base, project, text) {
  const response = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ provider: 'claude', source: `${text}.jsonl`, transcript: turn(text), ...(project ? { project } : {}) }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).session;
}

test('GET /api/projects lists each project by slug with its session count', async t => {
  const base = await startServer(t);
  const empty = await fetch(`${base}/api/projects`);
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await empty.json(), { projects: [{ slug: 'default', sessions: 0 }] });

  await importInto(base, 'orbit', 'first orbit note');
  await importInto(base, 'orbit', 'second orbit note');
  await importInto(base, 'alpha-2', 'alpha note');
  await importInto(base, null, 'loose note');
  // The same bytes again keep their first project and create nothing.
  await importInto(base, 'zeta', 'alpha note');

  const listed = await (await fetch(`${base}/api/projects?ignored=1`)).json();
  assert.deepEqual(listed, { projects: [
    { slug: 'alpha-2', sessions: 1 },
    { slug: 'default', sessions: 1 },
    { slug: 'orbit', sessions: 2 },
  ] });
});

test('GET /api/projects keeps the Host check and refuses other methods', async t => {
  const base = await startServer(t);
  const port = new URL(base).port;
  const { request } = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    const sent = request({ host: '127.0.0.1', port, path: '/api/projects', headers: { Host: 'evil.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    sent.on('error', reject);
    sent.end();
  });
  assert.notEqual(status, 200);
  const post = await fetch(`${base}/api/projects`, { method: 'POST', headers: { Origin: base } });
  assert.notEqual(post.status, 200);
});
