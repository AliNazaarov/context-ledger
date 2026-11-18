import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

// Card U2: the brand tokens pass contrast, and Pip's SVGs are safe to serve as they are.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

function tokens(block) {
  return Object.fromEntries([...block.matchAll(/--(ctm-[a-z0-9-]+):\s*(#[0-9a-f]{6})/gu)].map(match => [match[1], match[2]]));
}

test('the brand colours are the CTM site\'s', () => {
  const css = read('docs/brand/tokens.css');
  const light = tokens(css.slice(0, css.indexOf('.ctm-dark')));
  assert.equal(light['ctm-charcoal'], '#18181c');
  assert.equal(light['ctm-violet'], '#723bfa');
  assert.equal(light['ctm-lime'], '#b9f500');
  assert.equal(light['ctm-paper'], '#f4f3f7');
});

test('every text pair in both sets passes WCAG AA, and white on lime does not', () => {
  const css = read('docs/brand/tokens.css');
  const light = tokens(css.slice(0, css.indexOf('.ctm-dark')));
  const dark = { ...light, ...tokens(css.slice(css.indexOf('.ctm-dark'))) };
  const pairs = set => [
    ['ctm-text', 'ctm-bg'], ['ctm-text', 'ctm-surface'], ['ctm-text-2', 'ctm-bg'], ['ctm-text-2', 'ctm-surface'],
    ['ctm-primary', 'ctm-bg'], ['ctm-quoted', 'ctm-bg'], ['ctm-inferred', 'ctm-bg'],
    ['ctm-working', 'ctm-bg'], ['ctm-waiting', 'ctm-bg'], ['ctm-idle', 'ctm-bg'],
  ].map(([text, ground]) => [text, ground, set[text], set[ground]]);
  for (const [name, set] of [['light', light], ['dark', dark]]) {
    for (const [text, ground, a, b] of pairs(set)) {
      assert.ok(contrast(a, b) >= 4.5, `${name}: ${text} on ${ground} is ${contrast(a, b).toFixed(2)}`);
    }
  }
  // Marks on their own fills, white on the primary, and charcoal on lime.
  assert.ok(contrast(light['ctm-quoted'], light['ctm-quoted-fill']) >= 4.5);
  assert.ok(contrast(light['ctm-inferred'], light['ctm-inferred-fill']) >= 4.5);
  assert.ok(contrast('#ffffff', light['ctm-primary']) >= 4.5);
  assert.ok(contrast(light['ctm-charcoal'], light['ctm-lime']) >= 4.5);
  assert.ok(contrast('#ffffff', light['ctm-lime']) < 3, 'the guide says never put white text on lime');
});

test('Pip\'s SVGs are small, titled, and hold no script, outside link or font', () => {
  for (const file of ['pip.svg', 'pip-working.svg', 'pip-waiting.svg']) {
    const path = `docs/brand/${file}`;
    const svg = read(path);
    assert.ok(statSync(new URL(`../${path}`, import.meta.url)).size < 4096, file);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 120 120" role="img" aria-labelledby="t">/u, file);
    assert.match(svg, /<title id="t">Pip, the CTM mascot, [a-z ]+<\/title>/u, file);
    assert.doesNotMatch(svg, /<script|on[a-z]+=|href|url\(|@import|<image|<foreignObject|font-family|<text/iu, file);
    assert.ok(!/[\p{Cc}\p{Cf}]/u.test(svg.replace(/[\t\n\r]/gu, '')), `${file} has a raw control or format character`);
    // Only brand colours (and white) appear.
    const colours = new Set(svg.match(/#[0-9a-f]{6}/giu).map(colour => colour.toLowerCase()));
    for (const colour of colours) {
      assert.ok(['#18181c', '#723bfa', '#5b2bd4', '#b9f500', '#f4f3f7', '#ffffff', '#c44bff', '#8a4f00'].includes(colour), `${file}: ${colour}`);
    }
  }
});

test('the brand guide points at files that exist', () => {
  const guide = read('docs/brand/brand.md');
  for (const [, target] of guide.matchAll(/\]\(([^)#]+)\)/gu)) {
    if (target.startsWith('http')) continue;
    assert.ok(statSync(new URL(`../docs/brand/${target}`, import.meta.url)), target);
  }
});
