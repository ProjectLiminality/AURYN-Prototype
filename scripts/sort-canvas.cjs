#!/usr/bin/env node
/**
 * sort-canvas.js — Read a DreamSong.canvas file and output its content
 * in topological order as clean, AI-readable text.
 *
 * Usage: node sort-canvas.js /path/to/DreamSong.canvas
 *
 * Output format:
 *   [image: SpringLaunch/AURYN/AURYN.jpg]
 *   AURYN — highest priority, the catalyst...
 *
 *   [image: SpringLaunch/PRISM/PRISM.gif]
 *   PRISM — decentralized media distribution...
 *
 * Edges with toEnd:"none" are undirected (media-text pairs).
 * All other edges are directed (define reading order via topo sort).
 */

const fs = require('fs');

const canvasPath = process.argv[2];
if (!canvasPath) {
  process.stderr.write('Usage: node sort-canvas.js <canvas-path>\n');
  process.exit(1);
}

let raw;
try {
  raw = fs.readFileSync(canvasPath, 'utf8');
} catch (e) {
  process.stderr.write(`Cannot read ${canvasPath}: ${e.message}\n`);
  process.exit(1);
}

const canvas = JSON.parse(raw);
const nodes = canvas.nodes || [];
const edges = canvas.edges || [];

// Separate directed / undirected edges
const directed = [];
const undirected = [];
for (const e of edges) {
  if (e.toEnd === 'none') {
    undirected.push(e);
  } else {
    directed.push(e);
  }
}

// Find media-text pairs (file + text connected by undirected edge)
const nodesById = new Map(nodes.map(n => [n.id, n]));
const pairByMediaId = new Map();
const pairedTextIds = new Set();

for (const e of undirected) {
  const from = nodesById.get(e.fromNode);
  const to = nodesById.get(e.toNode);
  if (!from || !to) continue;

  let media = null, text = null;
  if (from.type === 'file' && to.type === 'text') { media = from; text = to; }
  else if (from.type === 'text' && to.type === 'file') { media = to; text = from; }

  if (media && text) {
    pairByMediaId.set(media.id, text);
    pairedTextIds.add(text.id);
  }
}

// Topo sort (Kahn's) — exclude paired text nodes
const sortNodes = nodes.filter(n => !pairedTextIds.has(n.id));
const nodeIds = new Set(sortNodes.map(n => n.id));
const adj = new Map();
const inDeg = new Map();
for (const id of nodeIds) { adj.set(id, []); inDeg.set(id, 0); }

for (const e of directed) {
  if (nodeIds.has(e.fromNode) && nodeIds.has(e.toNode)) {
    adj.get(e.fromNode).push(e.toNode);
    inDeg.set(e.toNode, inDeg.get(e.toNode) + 1);
  }
}

const queue = [];
for (const n of sortNodes) {
  if (inDeg.get(n.id) === 0) queue.push(n.id);
}
const sorted = [];
while (queue.length > 0) {
  const cur = queue.shift();
  sorted.push(cur);
  for (const nb of (adj.get(cur) || [])) {
    inDeg.set(nb, inDeg.get(nb) - 1);
    if (inDeg.get(nb) === 0) queue.push(nb);
  }
}

// Build output — clean text, no JSON
const out = [];
const placed = new Set();

for (const id of sorted) {
  if (placed.has(id)) continue;
  const node = nodesById.get(id);
  if (!node) continue;
  placed.add(id);

  if (node.type === 'file') {
    out.push(`[image: ${node.file}]`);
    // If paired with text, output it right after
    const paired = pairByMediaId.get(id);
    if (paired && !placed.has(paired.id)) {
      out.push(paired.text);
      placed.add(paired.id);
    }
  } else if (node.type === 'text' && node.text) {
    out.push(node.text);
  }

  out.push(''); // blank line separator
}

process.stdout.write(out.join('\n'));
