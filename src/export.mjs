// Card G12: a graph as node-link JSON, the format NetworkX writes and Graphify keeps in
// graphify-out/graph.json (edges under "links"), so decisions can be merged beside code.
import { canonicalPacket } from './graph.mjs';

// Party names and node IDs match ^[a-z0-9]+(?:-[a-z0-9]+)*$ in both schemas, so
// turning "-" into "_" fits Graphify's [a-z0-9_] alphabet and never makes two names one.
// A double underscore cannot come from a single "-", so it joins the namespace and the
// node without ambiguity: party leo-x with node y is ctm_leo_x__y, party leo with node
// x-y is ctm_leo__x_y.
const part = name => name.replaceAll('-', '_');

/** The namespace of a graph's node IDs: its party, or its session for a version 1 graph. */
export function namespaceOf(packet) {
  return packet.party ? part(packet.party) : `session_${packet.sessionId.slice(0, 8)}`;
}

export const exportNodeId = (packet, nodeId) => `ctm_${namespaceOf(packet)}__${part(nodeId)}`;

const fileType = kind => (kind === 'decision' || kind === 'constraint' ? 'rationale' : 'concept');

/**
 * The export of a stored graph. lookupGraph(id) returns a stored graph, used to name the
 * far end of a cross-graph link in the other party's naming.
 */
export function nodeLinkExport(graph, session, { lookupGraph } = {}) {
  const packet = canonicalPacket(graph.packet);
  const id = nodeId => exportNodeId(packet, nodeId);
  const sourceFile = session.source;
  const nodes = packet.nodes.map(node => ({
    id: id(node.id),
    label: node.label,
    file_type: fileType(node.kind),
    source_file: sourceFile,
    source_location: node.evidenceLines.map(line => `L${line}`).join(', '),
    kind: node.kind,
    ...(node.status ? { status: node.status } : {}),
    ...(node.to ? { to: node.to } : {}),
    ledger_graph: graph.id,
    ledger_node: node.id,
  }));
  // The graph is undirected for Graphify, so each link also says which end it starts from.
  const link = (source, target, relation) => ({
    source, target, relation, ledger_from: source, ledger_to: target,
    confidence: 'EXTRACTED', confidence_score: 1, source_file: sourceFile, weight: 1,
  });
  const links = packet.edges.map(edge => link(id(edge.from), id(edge.to), edge.type));
  for (const entry of packet.links ?? []) {
    // Links were checked at publish against a stored graph; that graph names the far end.
    const other = lookupGraph?.(entry.graph);
    if (other) links.push({ ...link(id(entry.from), exportNodeId(other.packet, entry.to), entry.type), ledger_graph: entry.graph });
  }
  return {
    // Graphify keeps undirected graphs, and merge-graphs refuses to mix the two.
    directed: false,
    multigraph: false,
    graph: {
      source: 'context-ledger',
      ledger_graph: graph.id,
      ...(packet.party ? { party: packet.party } : {}),
      session: packet.sessionId,
      source_file: sourceFile,
    },
    nodes,
    links,
  };
}
