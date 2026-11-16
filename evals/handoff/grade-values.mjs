// Grader B: typed values instead of keywords. For each fact it extracts every value of
// the fact's type from the answer field (every port number, weekday, person, amount,
// region, ...) and decides from the values:
//
// - the current value must be asserted, not retracted ("not Thursday" fails);
// - every other asserted value fails the field, whether it is a superseded one ("SQLite
//   for now") or one the transcript never states (the "added false detail" case);
// - a retracted value is fine only if it really was superseded or ruled out in the
//   transcript ("5210 (was 5100)" passes, "5210 (was 5000)" fails).
//
// A value is retracted when the last cue before it in its clause is one such as was,
// not, instead of or moved from, or when the words right after it say it was dropped
// or the person is away. Claims of a different type (a time added to a weekday) are
// not seen; the labelled set records those cases.

const smallNumbers = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const tens = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60 };
const numberWord = '(?:(?:twenty|thirty|forty|fifty|sixty)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
function wordValue(word) {
  const [head, tail] = word.toLowerCase().split(/[- ]/u);
  return head in tens ? tens[head] + (tail ? smallNumbers[tail] : 0) : smallNumbers[head];
}
const numeric = token => (/^\d/u.test(token) ? Number(token.replace(/,/gu, '')) : wordValue(token));

/** Every match of a regex as { value, index, end }; value(match) may return undefined to skip. */
function scan(text, regex, value) {
  return [...text.matchAll(regex)].flatMap(match => {
    const found = value(match);
    return found === undefined ? [] : [{ value: found, index: match.index, end: match.index + match[0].length }];
  });
}

/** Keep the longest of overlapping matches, in text order. */
function longestFirst(matches) {
  const kept = [];
  for (const match of [...matches].sort((a, b) => (b.end - b.index) - (a.end - a.index) || a.index - b.index)) {
    if (!kept.some(other => match.index < other.end && other.index < match.end)) kept.push(match);
  }
  return kept.sort((a, b) => a.index - b.index);
}

const people = ['mira', 'tomas', 'jonas', 'priya', 'dana', 'ravi', 'sam', 'elif', 'leo', 'ali'];
const birds = ['heron', 'kestrel', 'falcon', 'osprey', 'crane', 'egret', 'swift', 'wren', 'robin', 'owl', 'hawk', 'eagle', 'lark', 'finch'];
const cities = { frankfurt: 'eu-central-1', ireland: 'eu-west-1', dublin: 'eu-west-1', london: 'eu-west-2', paris: 'eu-west-3', stockholm: 'eu-north-1' };
const databases = { postgres: 'postgres', postgresql: 'postgres', pg: 'postgres', sqlite: 'sqlite', mysql: 'mysql', mariadb: 'mariadb', mongo: 'mongodb', mongodb: 'mongodb', redis: 'redis', dynamodb: 'dynamodb', oracle: 'oracle' };
const vocabulary = words => new RegExp(`\\b(${words.join('|')})\\b`, 'giu');

const extract = {
  port: text => scan(text, /\b\d{4,5}\b/gu, match => match[0]),
  weekday: text => scan(text, /\b(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/giu,
    match => match[1].slice(0, 3).toLowerCase()),
  database: text => scan(text, vocabulary(Object.keys(databases)), match => databases[match[1].toLowerCase()]),
  person: text => scan(text, vocabulary(people), match => match[1].toLowerCase()),
  bird: text => scan(text, vocabulary(birds), match => match[1].toLowerCase()),
  amount: text => scan(text, /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s*k\b)?/giu,
    match => Number(match[1].replace(/,/gu, '')) * (match[2] ? 1000 : 1)),
  region: text => longestFirst([
    ...scan(text, /\b[a-z]{2}-[a-z]+-\d\b/giu, match => match[0].toLowerCase()),
    ...scan(text, vocabulary(Object.keys(cities)), match => cities[match[1].toLowerCase()]),
  ]),
  // A bare count: a number not followed by a unit, so "200 ms" of backoff is not a count.
  count: text => scan(text, new RegExp(`\\b(\\d+|${numberWord})\\b(?!\\s*(?:ms\\b|milliseconds?\\b|s\\b|secs?\\b|seconds?\\b|mins?\\b|minutes?\\b|h\\b|hours?\\b|%|px\\b))`, 'giu'),
    match => numeric(match[1])),
  number: text => scan(text, new RegExp(`\\b(\\d+|${numberWord})\\b`, 'giu'), match => numeric(match[1])),
  // An interval in hours.
  interval: text => longestFirst([
    ...scan(text, new RegExp(`\\b(\\d+|${numberWord})[\\s-]*(?:h\\b|hours?\\b|hourly\\b)`, 'giu'), match => numeric(match[1])),
    ...scan(text, /\bhourly\b/giu, () => 1),
    ...scan(text, /\b(?:daily|nightly|once a day|every day|each day|per day|every night)\b/giu, () => 24),
    ...scan(text, /\btwice a day\b/giu, () => 12),
    ...scan(text, new RegExp(`\\b(\\d+|${numberWord}) times a day\\b`, 'giu'), match => 24 / numeric(match[1])),
    ...scan(text, /\b(?:weekly|once a week|every week)\b/giu, () => 168),
  ]),
  time: text => longestFirst([
    ...scan(text, /\b([01]?\d|2[0-3])[:.h]([0-5]\d)\b/giu, match => `${match[1].padStart(2, '0')}:${match[2]}`),
    ...scan(text, /\b(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/giu, match => {
      const hour = Number(match[1]) % 12 + (/^p/iu.test(match[3]) ? 12 : 0);
      return `${String(hour).padStart(2, '0')}:${match[2] ?? '00'}`;
    }),
  ]),
  identifier: text => scan(text, /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/giu, match => match[0].toLowerCase()),
};

// The cue words. In a value's clause, the last cue before it decides: a retraction cue
// marks the value as old or denied, an assertion cue ("to", "now") as the value meant.
// Longer phrases come first so that "instead of" wins over "instead".
const cue = new RegExp('\\b(?:(instead of|rather than|no longer|(?:moved|changed|switched|raised|lowered|pushed|bumped|increased|reduced|up|down) from|' +
  'was|were|previously|formerly|originally|earlier|old|not|never|replac(?:ed|es|ing)|supersed(?:ed|es|ing)|dropped)|' +
  '(to|now|is|are|becomes?|became|instead|actually|currently))\\b|(\\bfrom|\\bvs\\.?|\\bover)\\s*[€$£]?\\s*$|n\'t\\b', 'giu');
// After a value: "was dropped", "is away", "on leave", or a bare "(dropped)" that ends the
// clause. A bare "replaced" followed by more words is active ("Postgres (replaced SQLite)").
const after = new RegExp('^\\s*\\(?\\s*(?:(?:is|was|were|has been|got|are)\\s+(?:dropped|superseded|replaced|cancell?ed|abandoned|scrapped|ruled out|away|on leave|unavailable|out|no longer)\\b|' +
  '(?:away|on leave|unavailable|no longer)\\b|(?:dropped|superseded|replaced|cancell?ed|abandoned|scrapped|ruled out|old)\\s*$)', 'iu');
const boundary = /[,;.!?()[\]]/gu;

/** Whether a value is retracted. Its clause starts after the previous value of its type or the last punctuation. */
function retracted(text, match, previousEnd) {
  let window = text.slice(Math.max(previousEnd, match.index - 60), match.index);
  const cut = [...window.matchAll(boundary)].at(-1);
  if (cut) window = window.slice(cut.index + 1);
  let last;
  for (const found of window.matchAll(cue)) last = found[2] ? 'assert' : 'retract';
  if (last === 'retract') return true;
  const rest = text.slice(match.end).split(/[,;.!?)\]]/u)[0];
  return after.test(rest);
}

/** Judge one slot: all values of one type in the field. */
function judgeSlot(text, { type, current, superseded = [], alternatives = [], alsoTrue = [] }) {
  const found = extract[type](text);
  let previousEnd = 0;
  let hasCurrent = false;
  for (const match of found) {
    const isRetracted = retracted(text, match, previousEnd);
    previousEnd = match.end;
    if (isRetracted) {
      if (match.value === current) return false;
      if (!superseded.includes(match.value) && !alternatives.includes(match.value)) return false;
    } else if (match.value === current) {
      hasCurrent = true;
    } else if (!alsoTrue.includes(match.value)) {
      return false;
    }
  }
  return hasCurrent;
}

/** The explicit values per fact: current, superseded (true earlier), alternatives (mentioned, never agreed). */
export const valueTable = {
  port: [{ type: 'port', current: '5210', superseded: ['5100'] }],
  launchDay: [{ type: 'weekday', current: 'thu', superseded: ['tue'] }],
  database: [{ type: 'database', current: 'postgres', superseded: ['sqlite'] }],
  reviewer: [{ type: 'person', current: 'priya', superseded: ['jonas'] }],
  budgetEur: [{ type: 'amount', current: 1800, superseded: [1200] }],
  region: [{ type: 'region', current: 'eu-central-1', alternatives: ['eu-west-1'] }],
  codename: [{ type: 'bird', current: 'heron', alternatives: ['kestrel'] }],
  retries: [{ type: 'count', current: 3 }],
  backup: [{ type: 'interval', current: 6, superseded: [24] }],
  // The launch day is true too, so "the day before the Thursday launch" is no false detail.
  freeze: [{ type: 'weekday', current: 'wed', alsoTrue: ['thu'] }, { type: 'time', current: '16:00' }],
  flag: [{ type: 'identifier', current: 'beta_checkout' }],
  timeoutSeconds: [{ type: 'number', current: 45 }],
  onCall: [{ type: 'person', current: 'dana', alternatives: ['ravi'] }],
};

/** The open question: it must ask who signs the vendor contract and must not name anyone as the answer. */
function judgeQuestion(text) {
  if (!/\bsign/iu.test(text) || !/\b(?:contract|vendor)/iu.test(text)) return false;
  return extract.person(text).every(match => match.value === 'mira' || match.value === 'tomas');
}

export const valueGrader = {
  ...Object.fromEntries(Object.entries(valueTable).map(([key, slots]) => [key, text => slots.every(slot => judgeSlot(text, slot))])),
  questionForTomas: judgeQuestion,
};

export { extract };
