import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

// Card U2: the brand tokens pass contrast, and Pip's SVGs are safe to inline as they are.
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
const tokensIn = block => Object.fromEntries([...block.matchAll(/--(ctm-[a-z0-9-]+):\s*(#[0-9a-f]{6})/gu)].map(match => [match[1], match[2]]));

function sets() {
  const css = read('docs/brand/tokens.css');
  const split = css.indexOf('.ctm-dark');
  const light = tokensIn(css.slice(0, split));
  const darkOwn = tokensIn(css.slice(split));
  return { light, darkOwn, dark: { ...light, ...darkOwn } };
}

test('the brand colours are the CTM site\'s, Soft Violet included', () => {
  const { light } = sets();
  assert.deepEqual(['ctm-charcoal', 'ctm-violet', 'ctm-violet-soft', 'ctm-lime', 'ctm-paper'].map(name => light[name]),
    ['#18181c', '#723bfa', '#9e7bff', '#b9f500', '#f4f3f7']);
});

test('every pair in the guide passes WCAG AA in both sets, and the dark set inherits no colour it must set', () => {
  const { light, darkOwn, dark } = sets();
  // The pairs of the guide's table, as [foreground, background] variable names.
  const pairs = [
    ['ctm-text', 'ctm-bg'], ['ctm-text-2', 'ctm-bg'], ['ctm-link', 'ctm-bg'], ['ctm-link-hover', 'ctm-bg'],
    ['ctm-button-text', 'ctm-button-fill'], ['ctm-button-text', 'ctm-button-fill-hover'],
    ['ctm-quoted', 'ctm-quoted-fill'], ['ctm-inferred', 'ctm-inferred-fill'],
    ['ctm-text', 'ctm-surface'], ['ctm-text-2', 'ctm-surface'], ['ctm-link', 'ctm-surface'],
    ['ctm-quoted', 'ctm-bg'], ['ctm-inferred', 'ctm-bg'], ['ctm-working', 'ctm-bg'], ['ctm-waiting', 'ctm-bg'], ['ctm-idle', 'ctm-bg'],
  ];
  for (const [name, set] of [['light', light], ['dark', dark]]) {
    for (const [fore, back] of pairs) {
      const ratio = contrast(set[fore], set[back]);
      assert.ok(ratio >= 4.5, `${name}: ${fore} on ${back} is ${ratio.toFixed(2)}`);
    }
  }
  // Every text, fill and button variable is set again for dark (review of U2).
  for (const name of new Set(pairs.flat())) assert.ok(name in darkOwn, `the dark set sets ${name}`);
  assert.ok(contrast(light['ctm-charcoal'], light['ctm-lime']) >= 4.5);
  assert.ok(contrast('#ffffff', light['ctm-lime']) < 3, 'the guide says never put white text on lime');
});

test('the ratios printed in the guide are the computed ones', () => {
  const guide = read('docs/brand/brand.md');
  const { light, dark } = sets();
  const printed = [
    [light['ctm-text'], light['ctm-bg'], '16.0'], [light['ctm-text-2'], light['ctm-bg'], '6.8'], [dark['ctm-text-2'], dark['ctm-bg'], '8.7'],
    [light['ctm-link'], light['ctm-bg'], '5.1'], [dark['ctm-link'], dark['ctm-bg'], '5.7'], [light['ctm-link-hover'], light['ctm-bg'], '6.9'],
    [dark['ctm-link-hover'], dark['ctm-bg'], '8.2'], ['#ffffff', light['ctm-button-fill'], '5.6'], ['#ffffff', light['ctm-button-fill-hover'], '7.7'],
    [light['ctm-quoted'], light['ctm-quoted-fill'], '5.5'], [dark['ctm-quoted'], dark['ctm-quoted-fill'], '6.6'],
    [light['ctm-inferred'], light['ctm-inferred-fill'], '5.7'], [dark['ctm-inferred'], dark['ctm-inferred-fill'], '7.1'],
  ];
  for (const [fore, back, shown] of printed) {
    assert.equal(contrast(fore, back).toFixed(1), shown, `${fore} on ${back}`);
    assert.ok(guide.includes(`${shown}:1`), `the guide prints ${shown}:1`);
  }
});

const allowedElements = new Set(['svg', 'path', 'ellipse', 'circle', 'rect']);
const allowedAttributes = new Set(['xmlns', 'viewBox', 'role', 'aria-label', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'opacity']);
const illustrationColours = new Set(['#18181c', '#723bfa', '#9e7bff', '#b9f500', '#f4f3f7', '#ffffff', '#5b2bd4', '#8a4f00']);

test('Pip\'s SVGs hold only allowed elements, attributes and colours, and name their pose', () => {
  const poses = { 'pip.svg': 'idle', 'pip-working.svg': 'working', 'pip-waiting.svg': 'waiting for an answer' };
  for (const [file, pose] of Object.entries(poses)) {
    const path = `docs/brand/${file}`;
    const svg = read(path);
    assert.ok(statSync(new URL(`../${path}`, import.meta.url)).size < 4096, file);
    assert.ok(!/[\p{Cc}\p{Cf}]/u.test(svg.replace(/[\t\n\r]/gu, '')), `${file}: raw control or format character`);
    assert.match(svg, new RegExp(`^<svg [^>]*aria-label="Pip, the CTM mascot, ${pose}"`, 'u'), file);
    assert.doesNotMatch(svg, /\sid=/u, `${file}: no IDs, so inlined copies cannot clash`);
    const body = svg.replace(/<!--[\s\S]*?-->/gu, '');
    for (const [, name, attributes] of body.matchAll(/<([a-zA-Z][\w:-]*)([^>]*)>/gu)) {
      assert.ok(allowedElements.has(name), `${file}: element <${name}>`);
      for (const [, attribute] of attributes.matchAll(/([\w:-]+)\s*=/gu)) assert.ok(allowedAttributes.has(attribute), `${file}: attribute ${attribute}`);
    }
    for (const colour of body.match(/#[0-9a-f]{6}/giu)) assert.ok(illustrationColours.has(colour.toLowerCase()), `${file}: colour ${colour}`);
  }
});

test('the brand guide points at files that exist', () => {
  const guide = read('docs/brand/brand.md');
  for (const [, target] of guide.matchAll(/\]\(([^)#]+)\)/gu)) {
    if (target.startsWith('http')) continue;
    assert.ok(statSync(new URL(`../docs/brand/${target}`, import.meta.url)), target);
  }
});
