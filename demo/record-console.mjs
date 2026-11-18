// Card U3: record raw footage of the console demo for the 60-second video. It starts a
// ledger on a throwaway database, opens /console/?demo (the bundled synthetic Orbit
// recording), plays it to the end, opens the proof for one decision, and saves a 1280x720
// WebM. A person adds the terminal shots and the voice-over (docs/video/u3-script.md).
//
//   node demo/record-console.mjs [output folder]   (default test-results/u3)
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const outDir = resolve(process.argv[2] ?? 'test-results/u3');
const size = { width: 1280, height: 720 };

async function startLedger() {
  const dir = await mkdtemp(join(tmpdir(), 'ctm-u3-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(dir, 'ledger.sqlite') }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/u);
    if (match) {
      return { origin: match[1], stop: async () => { child.kill(); await new Promise(done => child.once('exit', done)); await rm(dir, { recursive: true, force: true }); } };
    }
  }
  throw new Error('The ledger did not start.');
}

const ledger = await startLedger();
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: size, recordVideo: { dir: outDir, size } });
  const page = await context.newPage();
  await page.goto(`${ledger.origin}/console/?demo&autoplay=0&speed=1`);
  await page.locator('body[data-demo="ready"]').waitFor();
  await page.waitForTimeout(1500); // the empty office, for the opening shot
  await page.getByRole('button', { name: 'Play demo' }).click();
  await page.locator('body[data-demo="finished"]').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  // The click-through: one decision, then the transcript lines that prove it.
  await page.getByRole('button', { name: /The ledger stays on port 4317/u }).click();
  await page.locator('#evidence .turn.is-cited').first().waitFor();
  await page.waitForTimeout(5000);
  const video = page.video();
  await context.close();
  const recorded = await video.path();
  const target = join(outDir, 'console-demo.webm');
  await rename(recorded, target);
  for (const name of await readdir(outDir)) if (name.endsWith('.webm') && name !== 'console-demo.webm') await rm(join(outDir, name));
  console.log(`Saved ${target}`);
} finally {
  await browser.close();
  await ledger.stop();
}
