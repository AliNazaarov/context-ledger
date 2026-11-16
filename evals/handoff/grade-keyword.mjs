// Grader A: keyword and regex checks in the style of gradeHandoff in demo/fixtures.mjs,
// one per fact. It checks that the required words are present, that a number field's
// first number is the current one, and rejects a few plain negations. It does not look
// for extra claims, so "the right value plus a false detail" passes; grader B
// (grade-values.mjs) is built to catch that.

const words = { three: 3, six: 6, 'forty-five': 45, 'forty five': 45 };

/** The first number in the text: digits with optional thousands commas and a k suffix, or a few number words. */
function firstNumber(text) {
  const match = text.match(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s*k\b)?|\b(three|six|forty[- ]five)\b/iu);
  if (!match) return undefined;
  if (match[3]) return words[match[3].toLowerCase()];
  return Number(match[1].replace(/,/gu, '')) * (match[2] ? 1000 : 1);
}

export const keywordGrader = {
  port: text => Number(text.match(/\b\d{4,5}\b/u)?.[0]) === 5210,
  launchDay: text => /thu/iu.test(text) && !/\bnot\b[^.;]*thu/iu.test(text),
  database: text => /postgres|\bpg\b/iu.test(text),
  reviewer: text => /priya/iu.test(text),
  budgetEur: text => firstNumber(text) === 1800,
  region: text => /eu-central-1|frankfurt/iu.test(text),
  codename: text => /heron/iu.test(text),
  retries: text => firstNumber(text) === 3,
  backup: text => /\b6\b|\bsix\b/iu.test(text) && /hour|\d\s*h\b/iu.test(text),
  freeze: text => /wed/iu.test(text) && /16[:.]?00|\b4\s*pm/iu.test(text),
  flag: text => /beta_checkout/iu.test(text),
  timeoutSeconds: text => firstNumber(text) === 45,
  onCall: text => /dana/iu.test(text),
  questionForTomas: text => /sign/iu.test(text) && /contract|vendor/iu.test(text),
};
