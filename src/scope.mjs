// Card G9: a briefing scoped to a question, cut to a token budget. The question picks
// the nodes that match it and the nodes one edge away; the budget drops nodes,
// neighbours first, until the briefing's estimate fits.
import { largest } from './paging.mjs';

export const maxQuestionCharacters = 500;
export const minBudget = 50;
export const maxBudget = 100_000;

// Common words that would match almost any node.
const stopWords = new Set(['the', 'and', 'for', 'are', 'was', 'not', 'but', 'its', 'has', 'had', 'can', 'all', 'any',
  'out', 'one', 'how', 'why', 'who', 'what', 'which', 'when', 'where', 'whose', 'with', 'from', 'that', 'this', 'these',
  'those', 'there', 'their', 'they', 'them', 'then', 'than', 'have', 'does', 'did', 'will', 'would', 'should', 'could',
  'into', 'about', 'over', 'under', 'some', 'more', 'most', 'also', 'just', 'only', 'very', 'you', 'your', 'our', 'ours',
  'now', 'yet', 'still', 'tell', 'show', 'give', 'list', 'need', 'needs', 'know', 'want', 'wants', 'let', 'get', 'got']);

/** The question's words: ASCII words of three or more characters, and runs of other scripts. */
export function questionTerms(question) {
  const lower = question.toLowerCase();
  const ascii = [...new Set(lower.match(/[a-z0-9]{3,}/gu) ?? [])].filter(word => !stopWords.has(word));
  const foreign = [...new Set((lower.match(/[\p{L}\p{N}]+/gu) ?? []).filter(run => /\P{ASCII}/u.test(run)))];
  return { ascii, foreign };
}

function nodeText(node) {
  const text = [node.label, node.id.replace(/[-_.]/gu, ' '), node.kind, node.to].filter(Boolean).join(' ').toLowerCase();
  return { text, words: text.match(/[\p{L}\p{N}]+/gu) ?? [] };
}

// Four letters or more compare by their first four, so "decided" finds a decision; a
// three-letter word must start a word ("gpu" finds "GPU time", not "upgpu").
const asciiMatch = (term, words) => words.some(word => word.startsWith(term.length >= 4 ? term.slice(0, 4) : term));
// Another script matches by two letters in a row, one of them outside ASCII.
const foreignMatch = (run, text) => {
  const letters = Array.from(run);
  if (letters.length === 1) return text.includes(run);
  return letters.slice(1).some((letter, index) => {
    const pair = letters[index] + letter;
    return /\P{ASCII}/u.test(pair) && text.includes(pair);
  });
};

/** How many of the question's words a node matches. */
export function nodeScore(node, terms) {
  const { text, words } = nodeText(node);
  return terms.ascii.filter(term => asciiMatch(term, words)).length
    + terms.foreign.filter(run => foreignMatch(run, text)).length;
}

/**
 * The nodes to show for a question, in the order they are kept under a budget:
 * matches by score (ties in packet order), then their neighbours in packet order.
 */
export function rankNodes(packet, question) {
  const terms = questionTerms(question);
  const scored = packet.nodes.map((node, index) => ({ id: node.id, index, score: nodeScore(node, terms) }));
  const matched = scored.filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const matchedIds = new Set(matched.map(entry => entry.id));
  const near = new Set();
  for (const { from, to } of packet.edges) {
    if (matchedIds.has(from) && !matchedIds.has(to)) near.add(to);
    if (matchedIds.has(to) && !matchedIds.has(from)) near.add(from);
  }
  const neighbours = packet.nodes.filter(node => near.has(node.id)).map(node => node.id);
  return { matched: matched.map(entry => entry.id), neighbours };
}

/** The graph cut down to the given node IDs: their edges, their links and their state. */
export function graphWith(graph, ids) {
  const shown = new Set(ids);
  const packet = graph.packet;
  const cut = {
    ...packet,
    nodes: packet.nodes.filter(node => shown.has(node.id)),
    edges: packet.edges.filter(edge => shown.has(edge.from) && shown.has(edge.to)),
  };
  if (packet.links) cut.links = packet.links.filter(link => shown.has(link.from));
  const scoped = { ...graph, packet: cut };
  // Every derived ID list (ready actions, current decisions, open questions and any
  // later one) names only nodes that are shown.
  for (const [key, value] of Object.entries(graph)) {
    if (key.endsWith('Ids') && Array.isArray(value)) scoped[key] = value.filter(id => shown.has(id));
  }
  return scoped;
}

const estimateTokens = text => Math.ceil(text.length / 4);

function scopeLine({ total, matched, shownMatched, shownNeighbours, left, budget }) {
  if (!matched) return `scope: the question matched none of the ${total} nodes; call context_for without a question for the whole graph`;
  const parts = [`scope: the question matched ${matched} of ${total} nodes`,
    `showing ${shownMatched} of them and ${shownNeighbours} neighbours`];
  if (budget !== undefined) parts.push(`${left} left out for a budget of ${budget} tokens`);
  return parts.join('; ');
}

/**
 * Render a scoped briefing. render(graph, scope) returns the briefing text for a graph
 * and a scope line. Returns the text and the counts behind the scope line.
 */
export function scopedText(graph, { question, budget }, render) {
  const { matched, neighbours } = rankNodes(graph.packet, question);
  const order = [...matched, ...neighbours];
  const total = graph.packet.nodes.length;
  const textFor = count => {
    const kept = order.slice(0, count);
    const shownMatched = kept.filter(id => matched.includes(id)).length;
    return render(graphWith(graph, kept), scopeLine({
      total, matched: matched.length, shownMatched, shownNeighbours: kept.length - shownMatched,
      left: order.length - count, budget,
    }));
  };
  if (budget === undefined) return textFor(order.length);
  const count = largest(1, order.length, k => estimateTokens(textFor(k)) <= budget);
  return textFor(Math.max(count, 0));
}
