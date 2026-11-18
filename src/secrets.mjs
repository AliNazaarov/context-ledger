// Card P4b: find text in a transcript that looks like a credential, so a person can see
// what a hand-off or export would carry before it leaves the machine, and redact it.
// The scanner only reports and replaces; it never stores, prints or sends a value.
//
// How a span is found:
// - A short pattern recognises where a candidate starts. Its repetition is bounded, so it
//   cannot backtrack for long on a long run of characters.
// - A forward scan then finds where the value really ends: the rest of its character
//   class, its closing quote, a JWT's three segments, or a private key's lines. No cap
//   decides where a value ends, so no tail of a long value is left behind.
// - Each pattern resumes after the whole value it found, so long runs are scanned once.
// - Overlapping candidates merge into one span, labelled with the most specific kind.

const nameKeywords = 'password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token';

// Keys have letters and digits; a long hyphenated word that starts with sk- does not.
const mixed = value => /[A-Za-z]/u.test(value) && /[0-9]/u.test(value);
const base64url = /[A-Za-z0-9_-]/u;
const unquoted = /[^\s"'`,;<>(){}[\]]/u;

/** The end of a run of characters matching cls, starting at from. */
function runEnd(text, from, cls) {
  let end = from;
  while (end < text.length && cls.test(text[end])) end += 1;
  return end;
}

/**
 * The end of a quoted value that starts at from (just inside the quote): the matching
 * unescaped quote, or the end of the line, whichever comes first. A backslash never
 * escapes a line break.
 */
function quotedEnd(text, from, quote) {
  for (let at = from; at < text.length; at += 1) {
    const character = text[at];
    if (character === '\n' || character === '\r' || character === quote) return at;
    if (character === '\\' && at + 1 < text.length && text[at + 1] !== '\n' && text[at + 1] !== '\r') at += 1;
  }
  return text.length;
}

/**
 * Simple rules: a pattern that recognises the start of the value, the value's character
 * class, and how many leading characters are a fixed public prefix that may be shown.
 */
const simpleRules = [
  { kind: 'anthropic-key', start: /\bsk-ant-[A-Za-z0-9_-]{20}/gu, cls: base64url, prefix: () => 7 },
  { kind: 'github-token', start: /\bgithub_pat_[A-Za-z0-9_]{22}/gu, cls: /[A-Za-z0-9_]/u, prefix: () => 11 },
  { kind: 'github-token', start: /\bgh[pousr]_[A-Za-z0-9]{36}/gu, cls: /[A-Za-z0-9]/u, prefix: () => 4 },
  { kind: 'aws-access-key-id', start: /\b(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])/gu, cls: /(?!)/u, prefix: () => 4 },
  { kind: 'slack-token', start: /\bxox[abposr]-[A-Za-z0-9-]{10}/gu, cls: /[A-Za-z0-9-]/u, prefix: () => 5 },
  { kind: 'stripe-key', start: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16}/gu, cls: /[A-Za-z0-9]/u, prefix: value => value.indexOf('_', 3) + 1 },
  { kind: 'openai-key', start: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20}/gu, cls: base64url, prefix: value => value.match(/^sk-(?:proj-|svcacct-|admin-)?/u)[0].length, accept: value => mixed(value.slice(3)) },
];

/**
 * Rules for a value after a name or header. The pattern ends where the value begins; the
 * value is then read whole, quoted or not.
 */
const valueRules = [
  { kind: 'aws-secret-access-key', lead: /\baws_secret_access_key\b["']?\s{0,8}[:=]\s{0,8}/giu, accept: value => /^[A-Za-z0-9/+=]{40}$/u.test(value) },
  // Bearer values of eight characters or more, as a bare header or inside JSON or a
  // quoted string; shorter ones are too likely to be examples.
  { kind: 'bearer-token', lead: /\bAuthorization["']?\s{0,8}:\s{0,8}["']?\s{0,8}Bearer\s{1,8}/giu, cls: /[A-Za-z0-9._~+/=-]/u, accept: value => value.length >= 8 },
  {
    kind: 'assigned-secret',
    lead: new RegExp(`\\b(?:[A-Za-z0-9]{1,32}[_.-])?(?:${nameKeywords})\\b["']?\\s{0,8}[:=]\\s{0,8}`, 'giu'),
    accept: value => !isPlaceholder(value) && looksSecret(value),
  },
];

/** Values people write instead of a real secret, judged by their shape. */
function isPlaceholder(value) {
  return /^(?:x+|\*+|\.+|#+|-+|0+)$/iu.test(value)
    || /^(?:changeme|change[_-]?me|password|passw0rd|secret|token|redacted|placeholder|example|sample|dummy|test|null|none|nil|undefined|true|false|required|optional|string|value)$/iu.test(value)
    || /^\$[{(]?[A-Za-z_][A-Za-z0-9_]*[})]?$/u.test(value)
    || /^%[A-Za-z_][A-Za-z0-9_]*%$/u.test(value)
    // A complete reference to an environment variable, not a value.
    || /^(?:process\.env|import\.meta\.env|os\.environ)(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/u.test(value)
    || /^\[REDACTED\b/u.test(value)
    // Identifiers that are not secrets: a UUID, and a 40-character git commit hash.
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    || /^[0-9a-f]{40}$/iu.test(value);
}

/**
 * A value that looks secret: at least eight characters, not all digits, not a short word,
 * and not a dotted or camel-case code name such as config.apiKey.
 */
function looksSecret(value) {
  if (value.length < 8) return false;
  if (/^[0-9]+$/u.test(value)) return false;
  if (/^[A-Za-z]+$/u.test(value)) return value.length >= 24;
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(value) && !/[0-9]/u.test(value)) return false;
  return mixed(value) || /[^A-Za-z0-9]/u.test(value) || value.length >= 24;
}

/** JSON Web Tokens: two base64url segments that start eyJ and a signature that may be empty. */
function jwts(text) {
  const found = [];
  const start = /\beyJ[A-Za-z0-9_-]{8}/gu;
  for (let match = start.exec(text); match; match = start.exec(text)) {
    const headerEnd = runEnd(text, match.index, base64url);
    let end = headerEnd;
    if (text[end] === '.' && text.startsWith('eyJ', end + 1)) {
      const payloadEnd = runEnd(text, end + 1, base64url);
      if (payloadEnd - (end + 1) >= 11 && text[payloadEnd] === '.') {
        end = runEnd(text, payloadEnd + 1, base64url);
        found.push({ kind: 'jwt', start: match.index, end, prefix: 3 });
      }
    }
    start.lastIndex = Math.max(start.lastIndex, end);
  }
  return found;
}

/**
 * Private key blocks, walked line by line: the BEGIN line, any PEM header lines (such as
 * Proc-Type) and the blank line after them, base64 lines, and the END line of the same
 * label when it comes next. An unfinished block ends at the first line that cannot belong
 * to it, so it never swallows prose or a later block.
 */
function privateKeys(text) {
  const found = [];
  const begin = /-----BEGIN ((?:[A-Z0-9]{1,16} ){0,3})PRIVATE KEY-----/gu;
  for (let match = begin.exec(text); match; match = begin.exec(text)) {
    const endLine = `-----END ${match[1]}PRIVATE KEY-----`;
    let end = match.index + match[0].length;
    let blankAllowed = false;
    while (end < text.length) {
      const lineStart = text[end] === '\r' && text[end + 1] === '\n' ? end + 2 : text[end] === '\n' ? end + 1 : -1;
      if (lineStart === -1) break;
      const newline = text.indexOf('\n', lineStart);
      const lineEnd = newline === -1 ? text.length : text[newline - 1] === '\r' ? newline - 1 : newline;
      const line = text.slice(lineStart, lineEnd);
      if (line === endLine) {
        end = lineEnd;
        break;
      }
      if (/^[A-Za-z-]{1,32}: \S/u.test(line)) {
        blankAllowed = true;
      } else if (line === '' && blankAllowed) {
        blankAllowed = false;
      } else if (/^[A-Za-z0-9+/=]+$/u.test(line)) {
        blankAllowed = false;
      } else {
        break;
      }
      end = lineEnd;
    }
    found.push({ kind: 'private-key', start: match.index, end, prefix: 0 });
    begin.lastIndex = Math.max(begin.lastIndex, end);
  }
  return found;
}

/** Every candidate span, each with the rank of its rule (lower is more specific). */
function candidates(text) {
  const all = [];
  for (const candidate of privateKeys(text)) all.push({ ...candidate, rank: 0 });
  for (const candidate of jwts(text)) all.push({ ...candidate, rank: 1 });
  simpleRules.forEach((rule, index) => {
    const pattern = new RegExp(rule.start.source, rule.start.flags);
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const start = match.index;
      const end = runEnd(text, start + match[0].length, rule.cls);
      const value = text.slice(start, end);
      if (!rule.accept || rule.accept(value)) all.push({ kind: rule.kind, start, end, rank: 2 + index, prefix: Math.min(rule.prefix(value), value.length) });
      // Resume after the whole run, so a long run is read once.
      pattern.lastIndex = Math.max(pattern.lastIndex, end);
    }
  });
  valueRules.forEach((rule, index) => {
    const pattern = new RegExp(rule.lead.source, rule.lead.flags);
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      let start = match.index + match[0].length;
      let end;
      const quote = text[start];
      if (quote === '"' || quote === "'" || quote === '`') {
        start += 1;
        end = quotedEnd(text, start, quote);
      } else {
        end = runEnd(text, start, rule.cls ?? unquoted);
      }
      const value = text.slice(start, end);
      if (value && rule.accept(value)) all.push({ kind: rule.kind, start, end, rank: 2 + simpleRules.length + index, prefix: 0 });
      pattern.lastIndex = Math.max(pattern.lastIndex, end);
    }
  });
  return all;
}

/**
 * Every span in text that looks like a credential, in text order. Overlapping candidates
 * merge into one span labelled with the most specific kind. Its prefix may be shown only
 * when that kind's match covers the whole span; otherwise the prefix would be part of an
 * enclosing value.
 */
export function findSecrets(text) {
  if (typeof text !== 'string' || !text) return [];
  const spans = [];
  for (const candidate of candidates(text).sort((a, b) => a.start - b.start || a.rank - b.rank)) {
    const last = spans.at(-1);
    if (last && candidate.start < last.end) {
      last.end = Math.max(last.end, candidate.end);
      if (candidate.rank < last.best.rank) last.best = candidate;
    } else {
      spans.push({ start: candidate.start, end: candidate.end, best: candidate });
    }
  }
  return spans.map(({ start, end, best }) => ({
    kind: best.kind,
    start,
    end,
    prefix: best.start === start && best.end === end ? best.prefix : 0,
  }));
}

/** text with every finding replaced by [REDACTED <kind>]; everything else is unchanged. */
export function redactText(text, findings = findSecrets(text)) {
  let out = '';
  let at = 0;
  for (const { kind, start, end } of findings) {
    out += text.slice(at, start) + `[REDACTED ${kind}]`;
    at = end;
  }
  return out + text.slice(at);
}

/** What may be shown of a finding: its known public prefix, never any other character. */
export function maskedPreview(text, finding) {
  return `${text.slice(finding.start, finding.start + finding.prefix)}…`;
}

/**
 * A copy of the session with its source name and every message redacted, and the
 * findings. Each finding has a line (null for the source name), a kind, a length and a
 * masked preview, never a value.
 */
export function redactSession(session) {
  const findings = [];
  const record = (text, line) => {
    const found = findSecrets(text);
    for (const finding of found) {
      findings.push({ line, kind: finding.kind, length: finding.end - finding.start, preview: maskedPreview(text, finding) });
    }
    return found.length ? redactText(text, found) : text;
  };
  const source = typeof session.source === 'string' ? record(session.source, null) : session.source;
  const messages = session.messages.map(message => {
    const text = record(message.text, message.line);
    return text === message.text ? message : { ...message, text };
  });
  return { session: { ...session, source, messages }, findings };
}
