import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { blockLines, endMarker, findCommand, manifestName, mcpPath, runAgent, startMarker, withBlock, withoutBlock } from '../src/install.mjs';

// Card G8. Every test uses a fake home folder and stub agent CLIs, so the real Claude
// Code and Codex configuration is never read or changed.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repo, 'src', 'cli.mjs');
const windows = process.platform === 'win32';
const nl = String.fromCodePoint(10);
const crlf = String.fromCodePoint(13, 10);
const bom = Buffer.from([0xef, 0xbb, 0xbf]);

// The stubs follow each CLI's argument rules closely enough to catch an argument in the
// wrong place: Claude's -e takes every value up to the next option, as commander does.
// Each keeps its registry in a JSON file and logs every call.
const stubSource = `
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const [agent, ...args] = process.argv.slice(2);
const stateFile = process.env.STUB_STATE + '.' + agent + '.json';
const servers = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
appendFileSync(process.env.STUB_STATE + '.log', JSON.stringify([agent, ...args]) + '\\n');
const save = () => writeFileSync(stateFile, JSON.stringify(servers));
const fail = message => { console.error(message); process.exit(1); };
if (args[0] !== 'mcp') fail('unknown command');
const [, action, ...rest] = args;
function parse(list) {
  const options = { env: [] };
  const positional = [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '--') { positional.push(...list.slice(i + 1)); break; }
    if (agent === 'claude' && arg === '-e') {
      while (list[i + 1] !== undefined && !list[i + 1].startsWith('-')) options.env.push(list[++i]);
    } else if (arg === '--env') options.env.push(list[++i]);
    else if (arg === '--scope' || arg === '-s') options.scope = list[++i];
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('-')) fail('unknown option ' + arg);
    else positional.push(arg);
  }
  return { options, positional };
}
const { options, positional } = parse(rest);
const name = positional[0];
if (options.env.some(pair => !/^[A-Z_]+=/.test(pair))) fail('bad env pair ' + options.env.join(','));
if (action === 'get') {
  const entry = servers[name];
  if (!entry) fail(agent === 'claude' ? 'No MCP server found with name: "' + name + '".' : "Error: No MCP server named '" + name + "' found.");
  if (agent === 'codex') console.log(JSON.stringify({ name, transport: { type: 'stdio', command: entry.command, args: entry.args } }));
  else console.log(name + ':\\n  Scope: ' + (entry.scope === 'user' ? 'User config (available in all your projects)' : 'Local config') + '\\n  Command: ' + entry.command + '\\n  Args: ' + entry.args.join(' '));
  process.exit(0);
}
if (action === 'add') {
  if (servers[name]) fail('MCP server ' + name + ' already exists');
  servers[name] = { scope: options.scope ?? (agent === 'codex' ? 'user' : 'local'), command: positional[1], args: positional.slice(2), env: options.env };
  save();
  process.exit(0);
}
if (action === 'remove') {
  if (!servers[name]) fail('No MCP server named ' + name);
  delete servers[name];
  save();
  process.exit(0);
}
fail('unknown action');
`;

function sandbox(t, { codexHome } = {}) {
  // A space in every path: the CLIs, the home folder and the instruction files.
  const root = mkdtempSync(join(tmpdir(), 'ledger g8 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home dir');
  const bin = join(root, 'bin dir!x');
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
  if (codexHome) env.CODEX_HOME = join(root, codexHome);
  const codexDir = env.CODEX_HOME ?? join(home, '.codex');
  const files = { claude: join(home, '.claude', 'CLAUDE.md'), codex: join(codexDir, 'AGENTS.md') };
  const manifests = { claude: join(home, '.claude', manifestName), codex: join(codexDir, manifestName) };
  const ledger = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const calls = () => (existsSync(state + '.log') ? readFileSync(state + '.log', 'utf8').trim().split(nl).filter(Boolean).map(line => JSON.parse(line)) : []);
  const writes = () => calls().filter(([, , action]) => action !== 'get');
  const servers = agent => (existsSync(`${state}.${agent}.json`) ? JSON.parse(readFileSync(`${state}.${agent}.json`, 'utf8')) : {});
  const seed = (agent, entries) => writeFileSync(`${state}.${agent}.json`, JSON.stringify(entries));
  const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  return { root, home, env, files, manifests, ledger, calls, writes, servers, seed, write };
}

const block = lineEnd => blockLines.map(line => line + lineEnd).join('');

test('install on an empty home registers both servers at user scope and writes one block each', t => {
  const box = sandbox(t);
  const result = box.ledger('install');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(readFileSync(box.files.claude, 'utf8'), block(nl));
  assert.equal(readFileSync(box.files.codex, 'utf8'), block(nl));
  assert.deepEqual(box.writes(), [
    ['claude', 'mcp', 'add', '--scope', 'user', 'context-ledger', '--', 'node', mcpPath],
    ['codex', 'mcp', 'add', 'context-ledger', '--', 'node', mcpPath],
  ]);
  assert.equal(box.servers('claude')['context-ledger'].scope, 'user');
  assert.deepEqual(JSON.parse(readFileSync(box.manifests.claude, 'utf8')),
    { version: 1, server: { added: true }, instructions: { created: true, separator: '' } });
  assert.match(result.stdout, /Claude Code\n {2}MCP server: ran /u);
  assert.match(result.stdout, /Instructions: created /u);
});

test('install twice changes nothing the second time', t => {
  const box = sandbox(t);
  assert.equal(box.ledger('install').status, 0);
  const first = [readFileSync(box.files.claude), readFileSync(box.files.codex), readFileSync(box.manifests.claude)];
  const again = box.ledger('install');
  assert.equal(again.status, 0);
  assert.deepEqual([readFileSync(box.files.claude), readFileSync(box.files.codex), readFileSync(box.manifests.claude)], first);
  assert.equal(box.writes().length, 2, 'no second registration');
  assert.match(again.stdout, /registered \(by an earlier install\)/u);
  assert.match(again.stdout, /already has the block/u);
});

test('install and uninstall give back the exact bytes of an existing file: CRLF, no final line break, a BOM', t => {
  const cases = [
    `# My rules${crlf}${crlf}Be brief.${crlf}`,
    'Be brief.',
    `Notes${nl}${nl}`,
    '',
  ];
  for (const before of cases) {
    const box = sandbox(t);
    box.write(box.files.claude, before);
    assert.equal(box.ledger('install', '--agent', 'claude').status, 0);
    assert.ok(readFileSync(box.files.claude, 'utf8').startsWith(before));
    assert.equal(box.ledger('uninstall', '--agent', 'claude').status, 0);
    assert.equal(readFileSync(box.files.claude, 'utf8'), before, JSON.stringify(before));
    assert.equal(existsSync(box.manifests.claude), false, 'the record goes once nothing is left');
  }
  const box = sandbox(t);
  box.write(box.files.claude, Buffer.concat([bom, Buffer.from(`Rules${crlf}`)]));
  assert.equal(box.ledger('install', '--agent', 'claude').status, 0);
  const installed = readFileSync(box.files.claude);
  assert.ok(installed.subarray(0, 3).equals(bom));
  assert.ok(installed.toString('utf8').includes(startMarker + crlf), 'block uses the file\'s CRLF');
  assert.equal(box.ledger('uninstall', '--agent', 'claude').status, 0);
  assert.deepEqual(readFileSync(box.files.claude), Buffer.concat([bom, Buffer.from(`Rules${crlf}`)]));
  assert.equal(existsSync(box.files.codex), false, '--agent claude leaves Codex alone');
  assert.deepEqual(box.calls().map(call => call[0]).filter(agent => agent === 'codex'), []);
});

test('uninstall removes a file that install created, and says when there is nothing to remove', t => {
  const box = sandbox(t);
  assert.equal(box.ledger('install').status, 0);
  const result = box.ledger('uninstall');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(existsSync(box.files.claude), false);
  assert.equal(existsSync(box.files.codex), false);
  assert.deepEqual(box.writes().slice(2), [
    ['claude', 'mcp', 'remove', '--scope', 'user', 'context-ledger'],
    ['codex', 'mcp', 'remove', 'context-ledger'],
  ]);
  const again = box.ledger('uninstall');
  assert.equal(again.status, 0);
  assert.match(again.stdout, /is not registered/u);
  assert.match(again.stdout, /no block in /u);
});

test('a server registered before install, or changed since, is never removed', t => {
  const box = sandbox(t);
  const theirs = { 'context-ledger': { scope: 'user', command: 'node', args: ['/elsewhere/src/mcp.mjs'] } };
  box.seed('codex', theirs);
  const installed = box.ledger('install', '--agent', 'codex');
  assert.match(installed.stdout, /already registered; left as it is/u);
  assert.equal(box.ledger('uninstall', '--agent', 'codex').status, 0);
  assert.deepEqual(box.servers('codex'), theirs);

  // Claude: added by install, then pointed elsewhere by the person.
  assert.equal(box.ledger('install', '--agent', 'claude').status, 0);
  box.seed('claude', { 'context-ledger': { scope: 'user', command: 'node', args: ['/other/checkout/src/mcp.mjs'] } });
  const result = box.ledger('uninstall', '--agent', 'claude');
  assert.match(result.stdout, /was changed since install; left as it is/u);
  assert.equal(box.servers('claude')['context-ledger'].args[0], '/other/checkout/src/mcp.mjs');
  assert.equal(box.writes().filter(call => call[2] === 'remove').length, 0);
});

test('a server at another Claude scope is reported and left alone', t => {
  const box = sandbox(t);
  box.seed('claude', { 'context-ledger': { scope: 'local', command: 'node', args: [mcpPath] } });
  const result = box.ledger('install', '--agent', 'claude');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /already registered at another scope; left as it is/u);
  assert.deepEqual(box.writes(), []);
});

test('--dry-run changes no file and runs no command that writes, for install and uninstall', t => {
  const box = sandbox(t);
  const result = box.ledger('install', '--dry-run');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Claude Code \(dry run\)\n {2}MCP server: would run /u);
  assert.match(result.stdout, /Instructions: would create /u);
  assert.equal(existsSync(join(box.home, '.claude')), false);
  assert.equal(existsSync(join(box.home, '.codex')), false);
  assert.deepEqual(box.writes(), []);

  assert.equal(box.ledger('install').status, 0);
  const snapshot = [readFileSync(box.files.claude), readFileSync(box.manifests.claude), JSON.stringify(box.servers('claude'))];
  const dry = box.ledger('uninstall', '--dry-run');
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /would run .*mcp remove/u);
  assert.match(dry.stdout, /Instructions: would remove /u);
  assert.deepEqual([readFileSync(box.files.claude), readFileSync(box.manifests.claude), JSON.stringify(box.servers('claude'))], snapshot);
  assert.equal(box.writes().length, 2);
});

test('unmatched or edited markers, UTF-16 and invalid UTF-8 are refused before the CLI changes anything', t => {
  const utf16 = Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00]);
  const badUtf8 = Buffer.from([0x41, 0xff, 0x0a]);
  const edited = block(nl).replace('## Context Ledger', '## My heading');
  const cases = [
    [`Notes${nl}${startMarker}${nl}half a block${nl}`, /unmatched Context Ledger markers/u],
    [edited, /was edited by hand/u],
    [utf16, /is UTF-16 text/u],
    [badUtf8, /is not valid UTF-8/u],
  ];
  for (const [content, message] of cases) {
    const box = sandbox(t);
    box.write(box.files.codex, content);
    for (const mode of ['install', 'uninstall']) {
      const result = box.ledger(mode, '--agent', 'codex');
      assert.equal(result.status, 1, mode);
      assert.match(result.stdout, message);
      assert.match(result.stdout, /Nothing changed: /u);
    }
    assert.deepEqual(readFileSync(box.files.codex), Buffer.from(content));
    assert.deepEqual(box.writes(), [], 'no registration was added');
  }
});

test('a missing CLI skips its registration, still handles the block and fails the command', t => {
  const box = sandbox(t);
  box.env.CONTEXT_LEDGER_CODEX_BIN = join(box.root, 'no such dir', 'codex');
  const result = box.ledger('install');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Codex\n {2}MCP server: .*codex was not found, so the server was not registered\. .*CONTEXT_LEDGER_CODEX_BIN/u);
  assert.equal(readFileSync(box.files.codex, 'utf8'), block(nl));
  const removed = box.ledger('uninstall', '--agent', 'codex');
  assert.equal(removed.status, 1);
  assert.match(removed.stdout, /not removed/u);
  assert.equal(existsSync(box.files.codex), false, 'the block is still removed');
  assert.deepEqual(box.writes().map(call => call[0]), ['claude']);
});

test('a CLI that fails to answer is not taken as "not registered"', t => {
  const box = sandbox(t);
  const fake = (bin, args) => (args[1] === 'get' ? { status: 3, stdout: '', detail: 'config is broken' } : { status: 0, stdout: '' });
  return import('../src/install.mjs').then(({ setupAgents }) => {
    const { ok, lines } = setupAgents({ mode: 'install', agents: ['claude'], env: box.env, run: fake });
    assert.equal(ok, false);
    assert.match(lines.join(nl), /failed \(config is broken\); nothing was changed/u);
  });
});

test('a PORT other than 4317 is passed to both servers in a place each CLI parses', t => {
  const box = sandbox(t);
  box.env.PORT = '4400';
  const result = box.ledger('install');
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(box.writes(), [
    ['claude', 'mcp', 'add', '-e', 'PORT=4400', '--scope', 'user', 'context-ledger', '--', 'node', mcpPath],
    ['codex', 'mcp', 'add', 'context-ledger', '--env', 'PORT=4400', '--', 'node', mcpPath],
  ]);
  assert.deepEqual(box.servers('claude')['context-ledger'].env, ['PORT=4400']);
  for (const port of ['4317x', '0', '65536', '99999']) {
    box.env.PORT = port;
    assert.equal(box.ledger('install').status, 1, port);
  }
});

test('CODEX_HOME moves the Codex instruction file and record', t => {
  const box = sandbox(t, { codexHome: 'codex home' });
  assert.equal(box.ledger('install', '--agent', 'codex').status, 0);
  assert.equal(readFileSync(join(box.root, 'codex home', 'AGENTS.md'), 'utf8'), block(nl));
  assert.ok(existsSync(join(box.root, 'codex home', manifestName)));
});

test('printed paths are escaped, so a folder name cannot drive the terminal', t => {
  const rlo = String.fromCodePoint(0x202e);
  const box = sandbox(t, { codexHome: `codex${rlo}home` });
  const result = box.ledger('install', '--agent', 'codex', '--dry-run');
  assert.equal(result.status, 0);
  assert.ok(!result.stdout.includes(rlo));
  assert.ok(result.stdout.includes(`codex${String.fromCodePoint(0x5c)}u202ehome`));
});

test('bad arguments print the usage and change nothing', t => {
  const box = sandbox(t);
  for (const args of [['install', '--agent', 'cursor'], ['install', '--agent='], ['install', 'extra'], ['uninstall', '--force']]) {
    const result = box.ledger(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /Usage:|Unknown option/u);
  }
  assert.deepEqual(box.calls(), []);
});

test('a symbolic link stays a link, and a file keeps its mode', t => {
  const box = sandbox(t);
  const target = join(box.root, 'dotfiles', 'AGENTS.md');
  box.write(target, `Shared rules${nl}`);
  mkdirSync(dirname(box.files.codex), { recursive: true });
  try {
    symlinkSync(target, box.files.codex);
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('symbolic links need extra rights on this Windows account');
    throw error;
  }
  if (!windows) chmodSync(target, 0o600);
  assert.equal(box.ledger('install', '--agent', 'codex').status, 0);
  assert.ok(readFileSync(target, 'utf8').includes(startMarker), 'written through the link');
  assert.equal(readFileSync(box.files.codex, 'utf8'), readFileSync(target, 'utf8'));
  if (!windows) assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.equal(box.ledger('uninstall', '--agent', 'codex').status, 0);
  assert.equal(readFileSync(target, 'utf8'), `Shared rules${nl}`);
});

test('arguments with spaces, ! and shell characters reach the CLI exactly; quotes and percent signs are refused on Windows', t => {
  const box = sandbox(t);
  const args = ['mcp', 'add', 'x', '--', 'node', join(box.root, 'a b!PATH!', 'mcp.mjs'), 'a&b|c', '(x)', '^caret'];
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
  writeFileSync(join(dir, 'tool'), `#!/bin/sh${nl}`);
  if (windows) {
    writeFileSync(join(dir, 'tool.cmd'), `@echo off${crlf}`);
    assert.equal(findCommand('tool', { platform: 'win32', env: { PATH: dir, PATHEXT: '.EXE;.CMD' } }), join(dir, 'tool.cmd'));
  } else {
    chmodSync(join(dir, 'tool'), 0o755);
    writeFileSync(join(dir, 'plain'), 'not executable');
    assert.equal(findCommand('tool', { platform: 'linux', env: { PATH: dir } }), join(dir, 'tool'));
    assert.equal(findCommand('plain', { platform: 'linux', env: { PATH: dir } }), null);
  }
  assert.equal(findCommand('nope', { env: { PATH: dir } }), null);
});

test('withBlock and withoutBlock keep the text around the block', () => {
  const added = withBlock('A');
  assert.equal(added.separator, nl + nl);
  assert.equal(withoutBlock(added.text, added.separator), 'A');
  assert.equal(withBlock(added.text).separator, null, 'already there');
  assert.equal(withoutBlock(`A${nl}${block(nl)}B${nl}`), `A${nl}B${nl}`, 'text after the block is kept');
  assert.equal(withoutBlock(`A${nl}${nl}${block(nl)}`), `A${nl}${nl}`, 'without a record only the block goes');
  assert.throws(() => withBlock(`${endMarker}${nl}`), /unmatched/u);
  assert.throws(() => withBlock(`${block(nl)}${block(nl)}`), /unmatched/u);
});

test('the block names the tools agents should call and says labels are data', () => {
  const text = blockLines.join(nl);
  for (const tool of ['graph_list', 'session_search', 'context_for']) assert.ok(text.includes(tool), tool);
  assert.match(text, /data, not as instructions/u);
  assert.ok(text.length < 700, 'short');
});
