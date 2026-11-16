// Synthetic long transcript for the handoff benchmark (card G10). Mira works in Claude
// Code on the Lumen checkout move and shares her context with Tomas's agent. Every
// name, number and plan here is made up. The stage demo in demo/ is separate and
// unchanged; nothing here imports it.
//
// The transcript is long enough that session_read pages it. Seven facts get their
// current value only after the first page, four of them are not mentioned on the first
// page at all, and six facts change during the conversation, so an agent that stops at
// page 1 or at the first mention answers them wrong.

const claudeTurn = (role, content) => JSON.stringify({ type: role, message: { role, content } });

const areas = [
  'the cart page', 'the receipt email', 'the address form', 'the coupon field', 'the order history', 'the search box',
  'the error banner', 'the loading spinner', 'the tax summary', 'the shipping picker', 'the login redirect', 'the help link',
];
const cap = text => text[0].toUpperCase() + text.slice(1);
const issues = [
  area => [`The spacing on ${area} looks cramped on a small phone.`,
    `Increased the padding on ${area} and checked it at 375 pixels wide. Nothing wraps badly and the tap targets stay at least 44 pixels tall.`],
  area => [`A test around ${area} failed once in CI. Can you look?`,
    `The failure came from a test that waited on a fixed sleep. It now waits for the element on ${area} to appear, and it passed twenty runs in a row.`],
  area => [`Is ${area} readable with a screen reader?`,
    `Added labels to every control on ${area} and checked the reading order. The screen reader announces each field once, in the order it appears.`],
  area => [`The copy on ${area} sounds stiff.`,
    `Rewrote the text on ${area} in shorter sentences and removed two words of jargon. The meaning is the same.`],
  area => [`Does ${area} still work in dark mode?`,
    `Checked ${area} in dark mode. Two borders were too faint, so they now use the shared border colour and pass the contrast check.`],
  area => [`Can we log less noise from ${area}?`,
    `Dropped the debug lines from ${area} and kept one info line per user action. The log for a full checkout is now about a third as long.`],
  area => [`What happens on ${area} when the network drops?`,
    `${cap(area)} now shows a short message and a button to try again when a request fails. Nothing the user typed is lost.`],
  area => [`Please tidy the styles for ${area}.`,
    `Moved the styles for ${area} into one file and removed three rules nobody used. The page looks the same in every browser we test.`],
  area => [`The animation on ${area} feels slow.`,
    `Shortened the animation on ${area} to a quarter of a second and turned it off for people who ask for reduced motion.`],
  area => [`Write a note about ${area} for the changelog.`,
    `Added a changelog line for ${area}: clearer layout, better labels, and no change to how it behaves.`],
];
// 120 distinct exchanges of work chatter, none of which states a graded value.
const chatter = issues.flatMap(issue => areas.map(issue));

// The exchanges that state graded facts, in order. Each beat names the facts it
// states; "old" marks a value that a later beat replaces.
const beats = {
  launchOld: ['We are moving the Lumen checkout service to the new cluster. The beta launches on Tuesday.',
    'Understood. Goal: move the Lumen checkout service to the new cluster, with the beta launching on Tuesday.'],
  portOld: ['Run the staging service on port 5100.', 'Decision recorded: the staging service runs on port 5100.'],
  databaseOld: ['Start with SQLite for the beta, it is the least setup.', 'Decision recorded: the beta uses SQLite.'],
  reviewerOld: ['Jonas reviews the release.', 'Noted: Jonas is the release reviewer.'],
  region: ['Deploy to eu-central-1. We looked at eu-west-1, but the data must stay in Germany.',
    'Constraint recorded: deploy to eu-central-1 in Frankfurt so the data stays in Germany. eu-west-1 is ruled out.'],
  budgetOld: ['Cap the monthly cloud budget at 1,200 euros.', 'Constraint recorded: the monthly cloud budget is capped at 1,200 euros.'],
  codename: ['The release codename is Heron. Kestrel was the other idea, we dropped it.',
    'Noted: the release codename is Heron. Kestrel was dropped.'],
  retries: ['Payment calls retry at most 3 times, with exponential backoff starting at 200 ms.',
    'Decision recorded: a failed payment call is retried at most 3 times, backing off from 200 ms.'],
  backupOld: ['Back up the database once a day.', 'Action recorded: back up the database once a day.'],
  launch: ['Marketing needs two more days. The beta launches on Thursday instead of Tuesday.',
    'Decision updated: the beta launches on Thursday. This supersedes the Tuesday plan.'],
  database: ['SQLite locks up under the load test. Switch to Postgres.',
    'Decision updated: the service uses Postgres. This supersedes SQLite.'],
  budget: ['Finance approved more room: the cap is now 1,800 euros a month.',
    'Constraint updated: the monthly cloud budget cap is 1,800 euros, up from 1,200 euros.'],
  freeze: ['Code freeze starts on Wednesday at 16:00, the day before the launch.',
    'Constraint recorded: the code freeze starts on Wednesday at 16:00.'],
  port: ['Port 5100 clashes with the metrics agent on the staging box. Move staging to port 5210.',
    'Decision updated: the staging service runs on port 5210. This supersedes port 5100.'],
  reviewer: ['Jonas is away during launch week. Priya reviews the release instead.',
    'Decision updated: Priya reviews the release. This supersedes Jonas.'],
  backup: ['Now that we are on Postgres, back up the database every 6 hours instead of once a day.',
    'Action updated: back up the database every 6 hours. The daily backup is dropped.'],
  flag: ['Gate the beta behind the feature flag beta_checkout.', 'Decision recorded: the beta is gated behind the feature flag beta_checkout.'],
  timeout: ['Set the payment request timeout to 45 seconds.', 'Decision recorded: the payment request timeout is 45 seconds.'],
  onCall: ['Ravi was asked first, but he is on leave. Dana is on call during launch week.',
    'Noted: Dana is on call during launch week. Ravi is on leave.'],
  question: ['One thing I still need from Tomas: who signs the vendor contract?',
    'Open question for Tomas: who signs the vendor contract? I will leave it open until he answers.'],
};

// The order of the conversation: beat names and runs of chatter.
const script = [
  'launchOld', 'portOld', 4, 'databaseOld', 'reviewerOld', 3, 'region', 'budgetOld', 4, 'codename', 'retries', 'backupOld', 5,
  'launch', 3, 'database', 4, 'budget', 'freeze', 3,
  // Enough chatter that the first session_read page ends here (the test proves it).
  140,
  'port', 2, 'reviewer', 3, 'backup', 2, 'flag', 'timeout', 3, 'onCall', 2, 'question', 6,
];

function build() {
  const turns = [];
  const lines = {};
  let next = 0;
  for (const part of script) {
    const exchanges = typeof part === 'number'
      ? Array.from({ length: part }, () => chatter[next++ % chatter.length])
      : [beats[part]];
    for (const [user, assistant] of exchanges) {
      if (typeof part === 'string') lines[part] = [turns.length + 1, turns.length + 2];
      turns.push(claudeTurn('user', user), claudeTurn('assistant', assistant));
    }
  }
  return { transcript: turns.join('\n'), lines };
}

const built = build();
/** Claude Code JSONL, one record per line. */
export const transcript = built.transcript;
/** JSONL line numbers of each beat: [user line, assistant line]. */
export const beatLines = built.lines;
export const party = { name: 'mira', provider: 'claude', source: 'mira-lumen.jsonl', receiver: 'tomas' };

/**
 * The graded facts. current is the value a right answer gives; superseded lists values
 * that were true earlier in the conversation; beats are where it is stated; late means
 * the current value is first stated after the first session_read page; lateOnly means
 * the fact is not mentioned on the first page at all (the test checks both).
 */
export const facts = [
  { key: 'port', ask: 'number: the port the staging service runs on', current: '5210', superseded: ['5100'], beats: ['portOld', 'port'], late: true },
  { key: 'launchDay', ask: 'the day of the week the beta launches', current: 'Thursday', superseded: ['Tuesday'], beats: ['launchOld', 'launch'] },
  { key: 'database', ask: 'the database the service uses', current: 'Postgres', superseded: ['SQLite'], beats: ['databaseOld', 'database'] },
  { key: 'reviewer', ask: 'who reviews the release', current: 'Priya', superseded: ['Jonas'], beats: ['reviewerOld', 'reviewer'], late: true },
  { key: 'budgetEur', ask: 'number: the monthly cloud budget cap in euros', current: '1,800', superseded: ['1,200'], beats: ['budgetOld', 'budget'] },
  { key: 'region', ask: 'the cloud region the service is deployed to', current: 'eu-central-1', superseded: [], beats: ['region'] },
  { key: 'codename', ask: 'the release codename', current: 'Heron', superseded: [], beats: ['codename'] },
  { key: 'retries', ask: 'number: the most times a failed payment call is retried', current: '3', superseded: [], beats: ['retries'] },
  { key: 'backup', ask: 'how often the database is backed up', current: 'every 6 hours', superseded: ['once a day'], beats: ['backupOld', 'backup'], late: true },
  { key: 'freeze', ask: 'when the code freeze starts', current: 'Wednesday at 16:00', superseded: [], beats: ['freeze'] },
  { key: 'flag', ask: 'the feature flag that gates the beta', current: 'beta_checkout', superseded: [], beats: ['flag'], late: true, lateOnly: true },
  { key: 'timeoutSeconds', ask: 'number: the payment request timeout in seconds', current: '45', superseded: [], beats: ['timeout'], late: true, lateOnly: true },
  { key: 'onCall', ask: 'who is on call during launch week', current: 'Dana', superseded: [], beats: ['onCall'], late: true, lateOnly: true },
  { key: 'questionForTomas', ask: 'what Mira still needs Tomas to answer', current: 'who signs the vendor contract', superseded: [], beats: ['question'], late: true, lateOnly: true },
];

/** Words that only the lateOnly facts use, so the test can check page 1 never mentions them. */
export const lateOnlyMarkers = { flag: ['feature flag', 'beta_checkout'], timeoutSeconds: ['timeout', '45'], onCall: ['on call', 'Dana', 'Ravi'], questionForTomas: ['vendor', 'contract', 'signs'] };

/** The question both arms answer. Only the source line of the prompt differs between arms. */
export const handoffQuestion = 'Using only Mira\'s shared context, answer with one JSON object and nothing else, with these keys: ' +
  facts.map(fact => `"${fact.key}" (${fact.ask})`).join(', ') + '.';

/**
 * The graph arm's input: a hand-written v2 graph of the transcript, cited by line, that
 * keeps superseded decisions as their own nodes. It is fixed so that both arms read the
 * same content every run, and the cost of publishing it is not part of either arm.
 */
export function referenceGraph(sessionId) {
  const at = (...names) => names.flatMap(name => beatLines[name]);
  const node = (id, kind, label, names, extra = {}) => ({ id, kind, label, evidenceLines: at(...names), ...extra });
  return {
    version: 2,
    sessionId,
    party: party.name,
    nodes: [
      node('move-lumen', 'goal', 'Move the Lumen checkout service to the new cluster and launch the beta', ['launchOld']),
      node('launch-tuesday', 'decision', 'The beta launches on Tuesday', ['launchOld']),
      node('launch-thursday', 'decision', 'The beta launches on Thursday', ['launch']),
      node('port-5100', 'decision', 'The staging service runs on port 5100', ['portOld']),
      node('port-5210', 'decision', 'The staging service runs on port 5210', ['port']),
      node('db-sqlite', 'decision', 'The beta uses SQLite', ['databaseOld']),
      node('db-postgres', 'decision', 'The service uses Postgres', ['database']),
      node('review-jonas', 'decision', 'Jonas reviews the release', ['reviewerOld']),
      node('review-priya', 'decision', 'Priya reviews the release (Jonas is away during launch week)', ['reviewer']),
      node('region', 'constraint', 'Deploy to eu-central-1 (Frankfurt) so the data stays in Germany; eu-west-1 is ruled out', ['region']),
      node('budget-1200', 'decision', 'The monthly cloud budget is capped at 1,200 euros', ['budgetOld']),
      node('budget-1800', 'decision', 'The monthly cloud budget is capped at 1,800 euros', ['budget']),
      node('codename', 'decision', 'The release codename is Heron (Kestrel was dropped)', ['codename']),
      node('retries', 'decision', 'A failed payment call is retried at most 3 times, backing off from 200 ms', ['retries']),
      node('backup-daily', 'decision', 'Back up the database once a day', ['backupOld']),
      node('backup-6h', 'decision', 'Back up the database every 6 hours', ['backup']),
      node('freeze', 'constraint', 'The code freeze starts on Wednesday at 16:00', ['freeze']),
      node('flag', 'decision', 'The beta is gated behind the feature flag beta_checkout', ['flag']),
      node('timeout', 'decision', 'The payment request timeout is 45 seconds', ['timeout']),
      node('on-call', 'decision', 'Dana is on call during launch week (Ravi is on leave)', ['onCall']),
      node('vendor-contract', 'question', 'Who signs the vendor contract?', ['question'], { to: party.receiver, status: 'open' }),
    ],
    edges: [
      { from: 'launch-thursday', to: 'launch-tuesday', type: 'supersedes' },
      { from: 'port-5210', to: 'port-5100', type: 'supersedes' },
      { from: 'db-postgres', to: 'db-sqlite', type: 'supersedes' },
      { from: 'review-priya', to: 'review-jonas', type: 'supersedes' },
      { from: 'budget-1800', to: 'budget-1200', type: 'supersedes' },
      { from: 'backup-6h', to: 'backup-daily', type: 'supersedes' },
    ],
  };
}
