// Card P4b: find text in a transcript that looks like a credential, so a person can see
// what a hand-off or export would carry before it leaves the machine, and redact it.
// The scanner only reports and replaces; it never stores, prints or sends a value.
//
// How a span is found:
// - A pattern with bounded repetition recognises a candidate, so no pattern backtracks for
//   long on a long run of characters.
// - The candidate is then extended to the end of its value by a linear scan (the value's
//   character class, a closing quote, or a private key's END line), so no tail of a long
//   value is left behind.
// - Overlapping candidates are merged into one span. It is labelled with the most specific
//   kind, and a prefix is shown only when that kind's match starts the span.

const nameKeywords = 'password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token';

// Keys have letters and digits; a long hyphenated word that starts with sk- does not.
const mixed = value => /[A-Za-z]/u.test(value) && /[0-9]/u.test(value);
const base64url = /[A-Za-z0-9_-]/u;

/**
 * kind: the label. pattern: a global regular expression that recognises a candidate.
 * group: the capture group holding the value, when the match also has a name or header.
 * tail: the characters the value may continue with past the pattern's bound.
 * prefix: how many leading characters of the value are a fixed public prefix that may be
 * shown. accept: an extra check on the recognised value.
 */
const patterns = [
  { kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,256}/gu, tail: base64url, prefix: () => 7 },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,256}/gu, tail: /[A-Za-z0-9_]/u, prefix: () => 11 },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,256}/gu, tail: /[A-Za-z0-9]/u, prefix: () => 4 },
  { kind: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])/gu, prefix: () => 4 },
  { kind: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,256}/gu, tail: /[A-Za-z0-9-]/u, prefix: () => 5 },
  { kind: 'stripe-key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,256}/gu, tail: /[A-Za-z0-9]/u, prefix: value => value.indexOf('_', 3) + 1 },
  // A JWT: base64url header and payload that both decode from '{"', and a signature that
  // may be empty (an unsecured token).
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,256}\.eyJ[A-Za-z0-9_-]{8,256}\.[A-Za-z0-9_-]{0,256}/gu, tail: base64url, prefix: () => 3 },
  { kind: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,256}/gu, tail: base64url, prefix: value => value.match(/^sk-(?:proj-|svcacct-|admin-)?/u)[0].length, accept: value => mixed(value.slice(3)) },
  { kind: 'aws-secret-access-key', pattern: /\baws_secret_access_key\b["']?\s{0,8}[:=]\s{0,8}["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/giu, group: 1, prefix: () => 0 },
  // Bearer values of eight characters or more; shorter ones are too likely to be examples.
  { kind: 'bearer-token', pattern: /\bAuthorization\s{0,8}:\s{0,8}Bearer\s{1,8}([A-Za-z0-9._~+/=-]{8,256})/giu, group: 1, tail: /[A-Za-z0-9._~+/=-]/u, prefix: () => 0 },
  {
    kind: 'assigned-secret',
    pattern: new RegExp(`\\b(?:[A-Za-z0-9]{1,32}[_.-])?(?:${nameKeywords})\\b["']?\\s{0,8}[:=]\\s{0,8}(["']?)([^\\s"'\`,;<>(){}\\[\\]]{1,256})`, 'giu'),
    group: 2,
    quote: 1,
    tail: /[^\s"'`,;<>(){}[\]]/u,
    prefix: () => 0,
    accept: value => !isPlaceholder(value) && looksSecret(value),
  },
];

/** Values people write instead of a real secret, judged by their shape. */
function isPlaceholder(value) {
  return /^(?:x+|\*+|\.+|#+|-+|0+)$/iu.test(value)
    || /^(?:changeme|change[_-]?me|password|passw0rd|secret|token|redacted|placeholder|example|sample|dummy|test|null|none|nil|undefined|true|false|required|optional|string|value)$/iu.test(value)
    || /^\$[{(]?[A-Za-z_][A-Za-z0-9_]*[})]?$/u.test(value)
    || /^%[A-Za-z_][A-Za-z0-9_]*%$/u.test(value)
    || /^(?:process\.env|os\.environ|env)\b/iu.test(value)
    || /^\[REDACTED\b/u.test(value)
    // Identifiers that are not secrets: a UUID, and a 40-character git commit hash.
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    || /^[0-9a-f]{40}$/iu.test(value);
}

/** A value with letters and digits, or punctuation, or a long one; not a word or a number. */
function looksSecret(value) {
  if (value.length < 8) return false;
  if (/^[0-9]+$/u.test(value)) return false;
  if (/^[A-Za-z]+$/u.test(value)) return value.length >= 24;
  // A dotted or camel-case name such as config.apiKey or getToken is code, not a value.
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(value) && !/[0-9]/u.test(value)) return false;
  return mixed(value) || /[^A-Za-z0-9]/u.test(value) || value.length >= 24;
}

/** The end of a quoted value: the matching unescaped quote, or the end of the line. */
function quotedEnd(text, from, quote) {
  for (let at = from; at < text.length; at += 1) {
    const character = text[at];
    if (character === '\\') at += 1;
    else if (character === quote) return at;
    else if (character === '\n' || character === '\r') return at;
  }
  return text.length;
}

/** Private key blocks, found with a forward scan rather than a bounded pattern. */
function privateKeys(text) {
  const found = [];
  const header = /-----BEGIN ((?:[A-Z0-9]{1,16} ){0,3})PRIVATE KEY-----/gu;
  // The next END line of each label, found once and reused while it lies ahead, so many
  // unfinished headers do not each search the rest of the text.
  const nextEnd = new Map();
  for (const match of text.matchAll(header)) {
    const start = match.index;
    if (found.length && start < found.at(-1).end) continue;
    const endLine = `-----END ${match[1]}PRIVATE KEY-----`;
    const from = start + match[0].length;
    let cached = nextEnd.get(endLine);
    if (!cached || (cached.at !== -1 && cached.at < from)) {
      cached = { at: text.indexOf(endLine, from) };
      nextEnd.set(endLine, cached);
    }
    const close = cached.at;
    let end;
    if (close !== -1) {
      end = close + endLine.length;
    } else {
      // No END line: take the header and every following line that could belong to the
      // block (base64, or PEM headers such as Proc-Type), so the key body is still covered.
      end = start + match[0].length;
      const lines = /\r?\n([A-Za-z0-9+/=]+|[A-Za-z-]{1,32}: [^\r\n]*)(?=\r?\n|$)/uy;
      lines.lastIndex = end;
      for (let line = lines.exec(text); line; line = lines.exec(text)) end = lines.lastIndex;
    }
    found.push({ kind: 'private-key', start, end, rank: -1, prefix: 0 });
  }
  return found;
}

function candidates(text) {
  const all = privateKeys(text);
  patterns.forEach((rule, rank) => {
    for (const match of text.matchAll(rule.pattern)) {
      const matched = match[rule.group ?? 0];
      if (!matched) continue;
      const start = rule.group ? match.index + match[0].length - matched.length : match.index;
      let end = start + matched.length;
      if (rule.quote && match[rule.quote]) end = quotedEnd(text, start, match[rule.quote]);
      else if (rule.tail) while (end < text.length && rule.tail.test(text[end])) end += 1;
      // The check sees the whole value, so a quoted password with spaces is judged whole.
      const value = text.slice(start, end);
      if (!value || (rule.accept && !rule.accept(value))) continue;
      all.push({ kind: rule.kind, start, end, rank, prefix: Math.min(rule.prefix(value), value.length) });
    }
  });
  return all;
}

/**
 * Every span in text that looks like a credential, in text order. Overlapping matches are
 * merged into one span labelled with the most specific kind; its prefix may be shown only
 * when that kind's match begins the span.
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
    // The prefix is shown only when the labelled match begins the span. If an enclosing
    // match starts earlier, those characters would be part of the enclosing value.
    prefix: best.start === start ? best.prefix : 0,
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
