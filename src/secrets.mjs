// Card P4b: find text in a transcript that looks like a credential, so a person can see
// what a hand-off or export would carry before it leaves the machine, and redact it.
// The scanner only reports and replaces; it never stores, prints or sends a value.
//
// Patterns are listed from most to least specific. When two matches overlap, the earlier
// pattern wins, so each span is reported once. Every repetition is bounded, so a long run
// of word characters cannot make a pattern backtrack for long.

const nameKeywords = 'password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token';

/**
 * kind: the label a finding gets. pattern: a global regular expression. group: the capture
 * group holding the value, when the match includes a name or header. prefix: how many
 * leading characters of the value are a fixed, public prefix that may be shown.
 */
const patterns = [
  { kind: 'private-key', pattern: /-----BEGIN (?:[A-Z0-9]{1,16} ){0,3}PRIVATE KEY-----[\s\S]{1,16384}?-----END (?:[A-Z0-9]{1,16} ){0,3}PRIVATE KEY-----/gu, prefix: () => 0 },
  { kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,400}/gu, prefix: () => 7, accept: value => mixed(value.slice(7)) },
  { kind: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,400}/gu, prefix: value => value.match(/^sk-(?:proj-|svcacct-|admin-)?/u)[0].length, accept: value => mixed(value) },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}/gu, prefix: () => 11 },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/gu, prefix: () => 4 },
  { kind: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, prefix: () => 4 },
  { kind: 'aws-secret-access-key', pattern: /\baws_secret_access_key\b["']?\s{0,8}[:=]\s{0,8}["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/giu, group: 1, prefix: () => 0 },
  { kind: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,255}/gu, prefix: () => 5 },
  { kind: 'stripe-key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,255}/gu, prefix: value => value.indexOf('_', 3) + 1 },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/gu, prefix: () => 3 },
  { kind: 'bearer-token', pattern: /\bAuthorization\s{0,8}:\s{0,8}Bearer\s{1,8}([A-Za-z0-9._~+/=-]{16,4096})/giu, group: 1, prefix: () => 0 },
  {
    kind: 'assigned-secret',
    pattern: new RegExp(`\\b(?:[A-Za-z0-9]{1,32}[_.-])?(?:${nameKeywords})\\b["']?\\s{0,8}[:=]\\s{0,8}["']?([^\\s"'\`,;<>(){}\\[\\]]{8,512})`, 'giu'),
    group: 1,
    prefix: () => 0,
    accept: value => !isPlaceholder(value) && looksSecret(value),
  },
];

// Keys have letters and digits; a long hyphenated word that starts with sk- does not.
const mixed = value => /[A-Za-z]/u.test(value) && /[0-9]/u.test(value);

/** Values people write instead of a real secret, which are not worth flagging. */
function isPlaceholder(value) {
  const plain = value.replace(/^["']|["']$/gu, '');
  return /^(?:x+|\*+|\.+|#+|-+|0+)$/iu.test(plain)
    || /^(?:changeme|change[_-]?me|password|passw0rd|secret|token|redacted|placeholder|example|sample|dummy|test|null|none|nil|undefined|true|false|required|optional|string|value|xxx+)$/iu.test(plain)
    || /^(?:your|my|the|an?|insert|enter|replace|fake|example|sample|dummy)[_-]/iu.test(plain)
    || /^\$[{(]?[A-Za-z_][A-Za-z0-9_]*[})]?$/u.test(plain)
    || /^%[A-Za-z_][A-Za-z0-9_]*%$/u.test(plain)
    || /^(?:process\.env|os\.environ|env)\b/iu.test(plain)
    || /^\[REDACTED\b/u.test(plain);
}

/** A value with letters and digits, or a long one, rather than a word or a number. */
function looksSecret(value) {
  if (/^[A-Za-z]+$/u.test(value) && value.length < 24) return false;
  if (/^[0-9]+$/u.test(value)) return false;
  return (/[A-Za-z]/u.test(value) && /[0-9]/u.test(value)) || value.length >= 24;
}

/** Every span in text that looks like a credential, in text order, without overlaps. */
export function findSecrets(text) {
  if (typeof text !== 'string' || !text) return [];
  const candidates = [];
  patterns.forEach((rule, rank) => {
    for (const match of text.matchAll(rule.pattern)) {
      const value = rule.group ? match[rule.group] : match[0];
      if (!value || (rule.accept && !rule.accept(value))) continue;
      const start = rule.group ? match.index + match[0].lastIndexOf(value) : match.index;
      candidates.push({ kind: rule.kind, start, end: start + value.length, rank, prefix: rule.prefix(value) });
    }
  });
  // The most specific pattern wins an overlap; then report in text order.
  candidates.sort((a, b) => a.rank - b.rank || a.start - b.start);
  const kept = [];
  for (const candidate of candidates) {
    if (kept.every(other => candidate.end <= other.start || candidate.start >= other.end)) kept.push(candidate);
  }
  return kept.sort((a, b) => a.start - b.start).map(({ kind, start, end, prefix }) => ({ kind, start, end, prefix }));
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
 * A copy of the session with every message redacted, and the findings by line. The
 * findings hold kinds, lengths and masked previews only, never a value.
 */
export function redactSession(session) {
  const findings = [];
  const messages = session.messages.map(message => {
    const found = findSecrets(message.text);
    for (const finding of found) {
      findings.push({ line: message.line, kind: finding.kind, length: finding.end - finding.start, preview: maskedPreview(message.text, finding) });
    }
    return found.length ? { ...message, text: redactText(message.text, found) } : message;
  });
  return { session: { ...session, messages }, findings };
}
