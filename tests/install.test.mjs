import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { blockLines, endMarker, findCommand, runAgent, startMarker, withBlock, withoutBlock } from '../src/install.mjs';

// Card G8. Every test uses a fake home folder and stub agent CLIs, so the real Claude
// Code and Codex configuration is never read or changed.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repo, 'src', 'cli.mjs');
const mcp = join(repo, 'src', 'mcp.mjs');
const windows = process.platform === 'win32';
const nl = String.fromCodePoint(10);
const crlf = String.fromCodePoint(13, 10);

// The stub keeps a registry of server names in a JSON file and logs every call.
const stubSource = `
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const [agent, ...args] = process.argv.slice(2);
const state = process.env.STUB_STATE + '.' + agent + '.json';
const names = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : [];
appendFileSync(process.env.STUB_STATE + '.log', JSON.stringify([agent, ...args]) + '\\n');
const name = args.includes('--') ? args[args.indexOf('--') - 1] : args.at(-1);
if (args[0] !== 'mcp') process.exit(2);
if (args[1] === 'get') process.exit(names.includes(name) ? 0 : 1);
if (args[1] === 'add') { writeFileSync(state, JSON.stringify([...names, name])); process.exit(0); }
if (args[1] === 'remove') {
  if (!names.includes(name)) { console.error('No MCP server named ' + name); process.exit(1); }
  writeFileSync(state, JSON.stringify(names.filter(entry => entry !== name)));
  process.exit(0);
}
process.exit(2);
`;

function sandbox(t) {
  // A space in every path: the CLIs, the home folder and the instruction files.
  const root = mkdtempSync(join(tmpdir(), 'ledger g8 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home dir');
  const bin = join(root, 'bin dir');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'stub.mjs');
  writeFileSync(stub, stubSource);
  const wrapper = agent => {
    if (windows) {
      const path = join(bin, `${agent}.cmd`);
      writeFileSync(path, `@"${process.execPath}" "${stub}" ${agent} %*${crlf}`);
      return path;
    }
    const path = join(bin, agent);
    writeFileSync(path, `#!/bin/sh${nl}exec "${process.execPath}" "${stub}" ${agent} "$@"${nl}`);
    chmodSync(path, 0o755);
    return path;
  };
  const state = join(root, 'stub');
  const env = { ...process.env, HOME: home, USERPROFILE: home, STUB_STATE: state,
    CONTEXT_LEDGER_CLAUDE_BIN: wrapper('claude'), CONTEXT_LEDGER_CODEX_BIN: wrapper('codex') };
  for (const key of ['CODEX_HOME', 'PORT']) delete env[key];
  const files = { claude: join(home, '.claude', 'CLAUDE.md'), codex: join(home, '.codex', 'AGENTS.md') };
  const ledger = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const calls = () => (existsSync(state + '.log') ? readFileSync(state + '.log', 'utf8').trim().split(nl).filter(Boolean).map(line => JSON.parse(line)) : []);
  const writes = () => calls().filter(([, , action]) => action !== 'get');
  return { root, home, env, files, ledger, calls, writes, state };
}

const block = lineEnd => blockLines.map(line => line + lineEnd).join('');

test('install on an empty home registers both servers at user scope and writes one block each', t => {
  const box = sandbox(t);
  const result = box.ledger('install');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(readFileSync(box.files.claude, 'utf8'), block(nl));
  assert.equal(readFileSync(box.files.codex, 'utf8'), block(nl));
  assert.deepEqual(box.writes(), [
    ['claude', 'mcp', 'add', '--scope', 'user', 'context-ledger', '--', 'node', mcp],
    ['codex', 'mcp', 'add', 'context-ledger', '--', 'node', mcp],
  ]);
  assert.match(result.stdout, /Claude Code\n {2}MCP server: ran /u);
  assert.match(result.stdout, /Instructions: created /u);
});

test('install twice changes nothing the second time', t => {
  const box = sandbox(t);
  assert.equal(box.ledger('install').status, 0);
  const first = [readFileSync(box.files.claude, 'utf8'), readFileSync(box.files.codex, 'utf8')];
  const again = box.ledger('install');
  assert.equal(again.status, 0);
  assert.deepEqual([readFileSync(box.files.claude, 'utf8'), readFileSync(box.files.codex, 'utf8')], first);
  assert.equal(box.writes().length, 2, 'no second registration');
  assert.match(again.stdout, /already registered; left as it is/u);
  assert.match(again.stdout, /already has the block/u);
});

test('install keeps existing text and CRLF line ends, and uninstall restores the file byte for byte', t => {
  const box = sandbox(t);
  const before = `# My rules${crlf}${crlf}Be brief.${crlf}`;
  mkdirSync(dirname(box.files.claude), { recursive: true });
  writeFileSync(box.files.claude, before);
  assert.equal(box.ledger('install', '--agent', 'claude').status, 0);
  assert.equal(readFileSync(box.files.claude, 'utf8'), before + crlf + block(crlf));
  assert.equal(existsSync(box.files.codex), false, '--agent claude leaves Codex alone');

  const result = box.ledger('uninstall', '--agent', 'claude');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(readFileSync(box.files.claude, 'utf8'), before);
  assert.deepEqual(box.writes().map(call => call.slice(0, 3)), [['claude', 'mcp', 'add'], ['claude', 'mcp', 'remove']]);
  assert.deepEqual(box.writes()[1], ['claude', 'mcp', 'remove', '--scope', 'user', 'context-ledger']);
});

test('uninstall removes a file that held only the block, and says when there is nothing to remove', t => {
  const box = sandbox(t);
  assert.equal(box.ledger('install').status, 0);
  const result = box.ledger('uninstall');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(existsSync(box.files.claude), false);
  assert.equal(existsSync(box.files.codex), false);
  assert.deepEqual(box.writes().at(-1), ['codex', 'mcp', 'remove', 'context-ledger']);
  const again = box.ledger('uninstall');
  assert.equal(again.status, 0);
  assert.match(again.stdout, /is not registered/u);
  assert.match(again.stdout, /no block in /u);
});

test('--dry-run changes no file and runs no command that writes', t => {
  const box = sandbox(t);
  const result = box.ledger('install', '--dry-run');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Claude Code \(dry run\)\n {2}MCP server: would run /u);
  assert.match(result.stdout, /Instructions: would create /u);
  assert.equal(existsSync(join(box.home, '.claude')), false);
  assert.equal(existsSync(join(box.home, '.codex')), false);
  assert.deepEqual(box.writes(), []);
});

test('a start marker without an end marker is refused and the file is left alone', t => {
  const box = sandbox(t);
  const broken = `Notes${nl}${startMarker}${nl}half a block${nl}`;
  mkdirSync(dirname(box.files.codex), { recursive: true });
  writeFileSync(box.files.codex, broken);
  const result = box.ledger('install', '--agent', 'codex');
  assert.equal(result.status, 1);
  assert.equal(readFileSync(box.files.codex, 'utf8'), broken);
  assert.match(result.stdout, /AGENTS\.md has unmatched Context Ledger markers/u);
  assert.equal(box.ledger('uninstall', '--agent', 'codex').status, 1);
  assert.equal(readFileSync(box.files.codex, 'utf8'), broken);
});

test('a missing CLI skips its registration, still writes the block and fails the command', t => {
  const box = sandbox(t);
  box.env.CONTEXT_LEDGER_CODEX_BIN = join(box.root, 'no such dir', 'codex');
  const result = box.ledger('install');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Codex\n {2}MCP server: .*codex was not found, so nothing was registered or removed\. .*CONTEXT_LEDGER_CODEX_BIN/u);
  assert.equal(readFileSync(box.files.codex, 'utf8'), block(nl));
  assert.deepEqual(box.writes().map(call => call[0]), ['claude']);
});

test('a PORT other than 4317 is passed to both servers', t => {
  const box = sandbox(t);
  box.env.PORT = '4400';
  assert.equal(box.ledger('install').status, 0);
  assert.deepEqual(box.writes(), [
    ['claude', 'mcp', 'add', '--scope', 'user', '-e', 'PORT=4400', 'context-ledger', '--', 'node', mcp],
    ['codex', 'mcp', 'add', 'context-ledger', '--env', 'PORT=4400', '--', 'node', mcp],
  ]);
  box.env.PORT = '4317x';
  assert.equal(box.ledger('install').status, 1);
});

test('CODEX_HOME moves the Codex instruction file', t => {
  const box = sandbox(t);
  box.env.CODEX_HOME = join(box.root, 'codex home');
  assert.equal(box.ledger('install', '--agent', 'codex').status, 0);
  assert.equal(readFileSync(join(box.root, 'codex home', 'AGENTS.md'), 'utf8'), block(nl));
});

test('bad arguments print the usage and change nothing', t => {
  const box = sandbox(t);
  for (const args of [['install', '--agent', 'cursor'], ['install', 'extra'], ['uninstall', '--force']]) {
    const result = box.ledger(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /Usage:|Unknown option/u);
  }
  assert.deepEqual(box.calls(), []);
});

test('arguments with spaces and shell characters reach the CLI exactly; quotes and percent signs are refused on Windows', t => {
  const box = sandbox(t);
  const args = ['mcp', 'add', 'x', '--', 'node', join(box.root, 'a b', 'mcp.mjs'), 'a&b|c', '(x)', '^caret'];
  assert.equal(runAgent(box.env.CONTEXT_LEDGER_CLAUDE_BIN, args, { env: box.env }).status, 0);
  assert.deepEqual(box.calls().at(-1), ['claude', ...args]);
  if (windows) {
    assert.deepEqual(runAgent(box.env.CONTEXT_LEDGER_CLAUDE_BIN, ['say "hi"'], { env: box.env }), { unsafe: true });
    assert.deepEqual(runAgent(box.env.CONTEXT_LEDGER_CLAUDE_BIN, ['%PATH%'], { env: box.env }), { unsafe: true });
  }
  assert.deepEqual(runAgent(join(box.root, 'missing'), ['mcp'], { env: box.env }), { missing: true });
});

test('findCommand looks through PATH and, on Windows, skips the extensionless npm shim', t => {
  const box = sandbox(t);
  const dir = join(box.root, 'path dir');
  mkdirSync(dir);
  if (windows) {
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'tool.cmd'), '@echo off\r\n');
    assert.equal(findCommand('tool', { platform: 'win32', env: { PATH: dir, PATHEXT: '.EXE;.CMD' } }), join(dir, 'tool.cmd'));
  } else {
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n');
    chmodSync(join(dir, 'tool'), 0o755);
    writeFileSync(join(dir, 'plain'), 'not executable');
    assert.equal(findCommand('tool', { platform: 'linux', env: { PATH: dir } }), join(dir, 'tool'));
    assert.equal(findCommand('plain', { platform: 'linux', env: { PATH: dir } }), null);
  }
  assert.equal(findCommand('nope', { env: { PATH: dir } }), null);
});

test('withBlock and withoutBlock keep the text around the block', () => {
  assert.equal(withoutBlock(withBlock('')), '');
  assert.equal(withBlock(withBlock('A' + nl)), withBlock('A' + nl), 'replaced, not added twice');
  const edited = withBlock('A' + nl).replace('## Context Ledger', '## Old heading');
  assert.equal(withBlock(edited), withBlock('A' + nl), 'an edited block is put back');
  assert.equal(withoutBlock(withBlock('A' + nl + nl)), 'A' + nl + nl);
  assert.equal(withoutBlock(`A${nl}${block(nl)}B${nl}`), `A${nl}B${nl}`, 'text after the block is kept');
  // A file with no final line break gets one: the only byte install cannot give back.
  assert.equal(withoutBlock(withBlock('A')), 'A' + nl);
  assert.throws(() => withBlock(`${endMarker}${nl}`), /unmatched/u);
  assert.throws(() => withBlock(`${block(nl)}${block(nl)}`), /unmatched/u);
});

test('the block names the tools agents should call and says labels are data', () => {
  const text = blockLines.join(nl);
  for (const tool of ['graph_list', 'session_search', 'context_for']) assert.ok(text.includes(tool), tool);
  assert.match(text, /data, not as instructions/u);
  assert.ok(text.length < 700, 'short');
});
