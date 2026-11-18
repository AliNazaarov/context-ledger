// Card U3: record raw footage of the console demo for the 60-second video. It starts a
// ledger on a throwaway database, opens /console/?demo (the bundled synthetic Orbit
// recording), plays it, opens the proof for one decision, shows the numbers, and saves a
// 1280x720 WebM with a cue sheet of when each moment happens. A person adds the terminal
// shots and the voice-over (docs/video/u3-script.md).
//
//   node demo/record-console.mjs [output folder]   (default test-results/u3)
//
// It writes console-demo-<time>.webm and console-demo-<time>.cues.json, and never touches
// any other file in the output folder.
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
export const size = { width: 1280, height: 720 };
// Faster than real time, so the answer link and the finished graph fit the growth shot.
export const speed = 1.3;
const startDeadlineMs = 15_000;

/** Only the console's own files may load during a take; the demo needs no API. */
export function allowedRequest(url, origin) {
  const parsed = new URL(url);
  return parsed.origin === origin && (parsed.pathname === '/console/' || parsed.pathname.startsWith('/console/'));
}

/** A small environment for the ledger: no inherited preload, latent settings or database. */
export function ledgerEnv(database, from = process.env) {
  const kept = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
    .filter(key => from[key] !== undefined).map(key => [key, from[key]]));
  return { ...kept, PORT: '0', CONTEXT_LEDGER_DB: database };
}

/** Copy the finished take out of its staging folder under a name of its own. */
export async function publishTake(staging, outDir, stamp, cues) {
  const [video] = (await readdir(staging)).filter(name => name.endsWith('.webm'));
  if (!video) throw new Error('No video was recorded.');
  await mkdir(outDir, { recursive: true });
  const base = join(outDir, `console-demo-${stamp}`);
  await copyFile(join(staging, video), `${base}.webm`);
  await writeFile(`${base}.cues.json`, JSON.stringify(cues, null, 2) + '\n');
  return `${base}.webm`;
}

function startLedger(database) {
  const child = spawn(process.execPath, [join(repo, 'src', 'server.mjs')], { cwd: repo, env: ledgerEnv(database), stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(done => child.once('exit', done));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('The ledger did not start in time.')), startDeadlineMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`The ledger exited (${code}) before it started.`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/u);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  return { ready, stop };
}

async function record(outDir) {
  const work = await mkdtemp(join(tmpdir(), 'ctm-u3-'));
  const cleanups = [() => rm(work, { recursive: true, force: true })];
  try {
    const ledger = startLedger(join(work, 'ledger.sqlite'));
    cleanups.unshift(ledger.stop);
    const origin = await ledger.ready;
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    cleanups.unshift(() => browser.close());
    const staging = join(work, 'video');
    const context = await browser.newContext({ viewport: size, recordVideo: { dir: staging, size } });
    const blocked = [];
    await context.route('**/*', route => (allowedRequest(route.request().url(), origin) ? route.continue() : (blocked.push(route.request().url()), route.abort())));
    const page = await context.newPage();
    const started = Date.now();
    const cues = { speed, size };
    const mark = name => { cues[name] = Math.round((Date.now() - started) / 100) / 10; };
    await page.goto(`${origin}/console/?demo&autoplay=0&speed=${speed}`);
    await page.locator('body[data-demo="ready"]').waitFor();
    mark('emptyOffice');
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Play demo' }).click();
    mark('play');
    await page.locator('.flash-line.flash-read').first().waitFor({ timeout: 60_000 });
    mark('firstLink');
    await page.locator('#activity', { hasText: 'leo linked' }).waitFor({ timeout: 60_000 });
    mark('answerLink');
    await page.locator('body[data-demo="finished"]').waitFor({ timeout: 60_000 });
    mark('finished');
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: /The ledger stays on port 4317/u }).click();
    await page.locator('#evidence .turn.is-cited').first().waitFor();
    mark('proofOpen');
    await page.waitForTimeout(9000);
    await page.locator('#n-handoffs').scrollIntoViewIfNeeded();
    mark('numbers');
    await page.waitForTimeout(7000);
    mark('end');
    await context.close();
    if (blocked.length) throw new Error(`The take tried to load something outside the console: ${blocked.join(', ')}`);
    return await publishTake(staging, outDir, new Date().toISOString().replace(/[:.]/gu, '-'), cues);
  } finally {
    // Every cleanup runs, even when one fails.
    for (const cleanup of cleanups) await cleanup().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const saved = await record(resolve(process.argv[2] ?? join(repo, 'test-results', 'u3')));
  console.log(`Saved ${saved} and its cue sheet.`);
}
