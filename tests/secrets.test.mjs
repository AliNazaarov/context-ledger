import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findSecrets, maskedPreview, redactSession, redactText } from '../src/secrets.mjs';

// Card P4b. Every fake credential is put together here from fragments, so no committed
// file holds a whole string in a real credential format (secret-scanning push protection
// would flag one). None of them is a real credential.
const join2 = (...parts) => parts.join('');
const body = (unit, count) => unit.repeat(count);
const fake = {
  'aws-access-key-id': join2('AK', 'IA', 'Q3XZ7W2M9KD4PL6N'),
  'github-token': join2('gh', 'p_', body('Ab3D', 9)),
  'github-pat': join2('github', '_pat_', body('11AB', 6), '_', body('cD9e', 10)),
  'anthropic-key': join2('sk', '-ant-', 'api03-', body('Zq7W', 10)),
  'openai-key': join2('sk', '-proj-', body('Hk4t', 10)),
  'slack-token': join2('xo', 'xb-', '1234567890-', body('aB1c', 5)),
  'stripe-key': join2('sk', '_live_', body('Rf5G', 6)),
  jwt: join2('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'SflKxwRJSMeKKF2QT4fwpM'),
  'aws-secret': body('wJal', 10),
  'bearer': body('Tq8z', 8),
};
const pemType = 'RSA ' + 'PRIVATE KEY';
const pem = `-----BEGIN ${pemType}-----\nMIIEowIBAAKCAQEA${body('q1W2', 16)}\n-----END ${pemType}-----`;

function kinds(text) {
  return findSecrets(text).map(finding => finding.kind);
}

test('P4b: every listed format is found, with its kind and exact span', () => {
  const cases = [
    [`key ${fake['aws-access-key-id']} here`, 'aws-access-key-id', fake['aws-access-key-id']],
    [`push with ${fake['github-token']}.`, 'github-token', fake['github-token']],
    [`pat ${fake['github-pat']}`, 'github-token', fake['github-pat']],
    [`ANTHROPIC_API_KEY ${fake['anthropic-key']}`, 'anthropic-key', fake['anthropic-key']],
    [`openai ${fake['openai-key']}`, 'openai-key', fake['openai-key']],
    [`slack ${fake['slack-token']}`, 'slack-token', fake['slack-token']],
    [`stripe ${fake['stripe-key']}`, 'stripe-key', fake['stripe-key']],
    [`cookie=${fake.jwt}`, 'jwt', fake.jwt],
    [`aws_secret_access_key = ${fake['aws-secret']}`, 'aws-secret-access-key', fake['aws-secret']],
    [`curl -H "Authorization: Bearer ${fake.bearer}"`, 'bearer-token', fake.bearer],
    [`DB_PASSWORD="Kx9mQ2vL7p"`, 'assigned-secret', 'Kx9mQ2vL7p'],
    [`client_secret: Zt4Wq8Lm2Np6Rv0X`, 'assigned-secret', 'Zt4Wq8Lm2Np6Rv0X'],
    [`here is the key:\n${pem}\nthanks`, 'private-key', pem],
  ];
  for (const [text, kind, value] of cases) {
    const found = findSecrets(text);
    assert.equal(found.length, 1, `${kind}: ${JSON.stringify(found)}`);
    assert.equal(found[0].kind, kind);
    assert.equal(text.slice(found[0].start, found[0].end), value, kind);
  }
});

test('P4b: prose, hashes, UUIDs, placeholders and short or plain values are not flagged', () => {
  const quiet = [
    'Please reset your password tomorrow.',
    'The password field is required.',
    'commit 3f2a9c1e7b4d5a6f8e9c0b1a2d3e4f5a6b7c8d9e',
    'session 0b7e2a4c-9f1d-4e3b-8a5c-6d2f1e0a9b8c',
    'password = ${PASSWORD}',
    'api_key: <your-key-here>',
    'token: xxxxxxxxxxxx',
    'password: changeme',
    'secret = process.env.SECRET',
    'token = getToken()',
    'max_tokens: 4096',
    'password: hunter2',
    'Use the risk-assessment-for-the-project-and-team page.',
    'See sk-learn-documentation-for-everyone here.',
    'apiKey = config.apiKey',
  ];
  for (const text of quiet) assert.deepEqual(kinds(text), [], text);
});

test('P4b: overlapping matches are reported once, by the most specific kind', () => {
  // An Anthropic key also matches the OpenAI pattern, and an assigned token matches the
  // name rule: each span must appear once, under its specific kind.
  assert.deepEqual(kinds(`ANTHROPIC_KEY=${fake['anthropic-key']}`), ['anthropic-key']);
  assert.deepEqual(kinds(`GITHUB_TOKEN=${fake['github-token']}`), ['github-token']);
  assert.deepEqual(kinds(`token: ${fake.jwt}`), ['jwt']);
});

test('P4b: redaction replaces only the findings and leaves every other byte', () => {
  const emoji = String.fromCodePoint(0x1f600);
  const text = `a ${emoji}\r\n${fake['github-token']} b\tc ${fake['aws-access-key-id']}!`;
  const redacted = redactText(text);
  assert.equal(redacted, `a ${emoji}\r\n[REDACTED github-token] b\tc [REDACTED aws-access-key-id]!`);
  assert.equal(redactText('nothing here'), 'nothing here');
});

test('P4b: a redacted session keeps its lines and lists findings without any value', () => {
  const session = {
    id: 'a'.repeat(64), provider: 'codex', source: 'orion.jsonl',
    messages: [
      { role: 'user', line: 3, text: `deploy with ${fake['github-token']}` },
      { role: 'assistant', line: 7, text: 'Done, no keys needed.' },
      { role: 'user', line: 9, text: `also ${fake['stripe-key']} and ${fake['aws-access-key-id']}` },
    ],
  };
  const { session: redacted, findings } = redactSession(session);
  assert.deepEqual(redacted.messages.map(message => message.line), [3, 7, 9]);
  assert.equal(redacted.messages[1], session.messages[1], 'clean messages are untouched');
  assert.deepEqual(findings.map(({ line, kind }) => [line, kind]), [[3, 'github-token'], [9, 'stripe-key'], [9, 'aws-access-key-id']]);
  assert.deepEqual(findings.map(finding => finding.preview), ['ghp_…', 'sk_live_…', 'AKIA…']);
  const shown = JSON.stringify({ redacted, findings });
  for (const value of [fake['github-token'], fake['stripe-key'], fake['aws-access-key-id']]) {
    assert.ok(!shown.includes(value), 'no value is kept');
    assert.ok(!shown.includes(value.slice(-6)), 'no tail of a value is kept');
  }
  assert.equal(session.messages[0].text.includes(fake['github-token']), true, 'the input is not changed');
});

test('P4b: a masked preview shows only the known prefix', () => {
  for (const [kind, value] of Object.entries(fake)) {
    const text = kind === 'aws-secret' ? `aws_secret_access_key=${value}` : kind === 'bearer' ? `Authorization: Bearer ${value}` : value;
    for (const finding of findSecrets(text)) {
      const preview = maskedPreview(text, finding);
      assert.ok(preview.endsWith('…'));
      assert.ok(preview.length - 1 <= 11, `${kind}: ${preview}`);
      assert.ok(!preview.slice(0, -1) || value.startsWith(preview.slice(0, -1)), kind);
    }
  }
  assert.equal(maskedPreview(pem, findSecrets(pem)[0]), '…');
});

test('P4b: a 1 MiB transcript and a 1 MiB run of word characters scan in under a second each', () => {
  const chunk = `Normal text about the build. password: Kx9mQ2vL7p and ${fake['github-token']}\n`;
  const big = chunk.repeat(Math.ceil((1024 * 1024) / chunk.length));
  for (const text of [big, 'a'.repeat(1024 * 1024), `${'token'.repeat(200000)}=x`, `sk-${'-'.repeat(1024 * 1024)}`]) {
    const started = performance.now();
    findSecrets(text);
    assert.ok(performance.now() - started < 1000, `${text.length} characters took too long`);
  }
});

async function startServer(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-p4b-'));
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(directory, 'ledger.sqlite') }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(async () => {
    if (server.exitCode === null) {
      const ended = once(server, 'close');
      server.kill();
      await ended;
    }
    await rm(directory, { recursive: true, force: true });
  });
  let output = '';
  for await (const chunk of server.stdout) {
    output += chunk;
    const match = output.match(/listening at (http:\/\/127\.0\.0\.1:(\d+))/u);
    if (match) return { origin: match[1], port: match[2] };
  }
  throw new Error('The server did not start.');
}

function cli(args, port) {
  const child = spawn(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
}

test('P4b: ledger redact reports kinds, lines and masked previews, never a value, in every format', async t => {
  const { origin, port } = await startServer(t);
  const line = (role, text) => JSON.stringify({ type: role, message: { role, content: text } });
  const transcript = [
    line('user', `Deploy the Vega site with ${fake['github-token']} please.`),
    line('assistant', 'Deploying now.'),
    line('user', `And the DB_PASSWORD="Kx9mQ2vL7p" plus ${fake['aws-access-key-id']}.`),
  ].join('\n');
  const imported = await (await fetch(`${origin}/api/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ provider: 'claude', source: 'vega.jsonl', transcript }),
  })).json();
  const id = imported.session.id;
  const values = [fake['github-token'], 'Kx9mQ2vL7p', fake['aws-access-key-id']];

  const report = await cli(['redact', id], port);
  assert.equal(report.code, 0, report.stderr);
  assert.equal(report.stdout, [
    'line 1  github-token  40 characters  ghp_…',
    'line 3  assigned-secret  10 characters  …',
    'line 3  aws-access-key-id  20 characters  AKIA…',
    '3 possible secrets in 2 lines. Values are not shown; use --text for the redacted hand-off.',
    '',
  ].join('\n'));

  const json = await cli(['redact', id, '--json'], port);
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.count, 3);
  assert.equal(parsed.lines, 2);
  assert.deepEqual(parsed.findings.map(finding => finding.kind), ['github-token', 'assigned-secret', 'aws-access-key-id']);

  const text = await cli(['redact', id, '--text'], port);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /## user · line 1/u);
  assert.match(text.stdout, /\[REDACTED github-token\]/u);

  for (const run of [report, json, text]) {
    for (const value of values) assert.ok(!run.stdout.includes(value) && !run.stderr.includes(value), 'no value is printed');
    assert.doesNotMatch(run.stdout, /[^\P{Cc}\n]|\p{Cf}/u, 'no raw control or format characters');
  }

  const clean = await cli(['redact', 'b'.repeat(64)], port);
  assert.equal(clean.code, 1);
  assert.match(clean.stderr, /Session not found\./u);
  const bad = await cli(['redact', id, '--html'], port);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Usage: npm run ledger/u);
  const handoff = await cli(['handoff', id], port);
  assert.ok(handoff.stdout.includes(fake['github-token']), 'ledger handoff is unchanged by P4b');
});
