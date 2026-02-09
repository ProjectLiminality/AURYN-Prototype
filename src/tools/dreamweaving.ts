/**
 * Dreamweaving MCP Tools - Canvas generation and parsing for DreamSongs
 *
 * DreamSongs are Obsidian canvas files that compose DreamNodes into stories.
 * Submodule relationships are inferred from DreamSongs (relationships are
 * downstream of DreamSongs, never directly manipulated).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { findDreamNode, UDDService, commitAllChanges, DreamNodeInfo } from '../services/standalone-adapter.js';

// ============================================================================
// TYPES
// ============================================================================

interface CanvasNode {
  id: string;
  type: 'file' | 'text' | 'group' | 'link';
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  file?: string;
  text?: string;
  url?: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: 'top' | 'right' | 'bottom' | 'left';
  toSide?: 'top' | 'right' | 'bottom' | 'left';
  toEnd?: 'none' | 'arrow';
  color?: string;
  label?: string;
}

interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface SourceInput {
  identifier: string;
  description: string;
}

interface ResolvedSource {
  node: DreamNodeInfo;
  description: string;
  dreamTalkPath: string | null; // vault-relative sovereign path
}

interface DreamSongBlock {
  type: 'text' | 'media' | 'media-text';
  text?: string;
  filePath?: string;
  isLeftAligned?: boolean;
}

// ============================================================================
// LAYOUT CONSTANTS (from InterBrain's canvas-layout-service.ts)
// ============================================================================

const LAYOUT = {
  centerX: 400,
  cardWidth: 360,
  verticalSpacing: 75,
  horizontalOffset: 50,
  avgCharWidth: 8,
  lineHeight: 24,
  cardPadding: 40,
  minHeight: 100,
  maxHeight: 2000,
  mediaHeight: 360, // square default for DreamTalk images
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function generateNodeId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Calculate text node height based on content wrapping.
 * Mirrors InterBrain's canvas-layout-service.ts calculateTextHeight.
 */
function calculateTextHeight(text: string): number {
  const availableWidth = LAYOUT.cardWidth - 40; // horizontal padding
  const charsPerLine = Math.floor(availableWidth / LAYOUT.avgCharWidth);

  const textLines = text.split('\n');
  let totalLines = 0;

  for (const line of textLines) {
    if (line.trim() === '') {
      totalLines += 1;
    } else {
      const wrappedLines = Math.ceil(line.length / charsPerLine);
      totalLines += Math.max(1, wrappedLines);
    }
  }

  const estimatedHeight = (totalLines * LAYOUT.lineHeight) + LAYOUT.cardPadding;
  return Math.max(LAYOUT.minHeight, Math.min(estimatedHeight, LAYOUT.maxHeight));
}

// ============================================================================
// CANVAS GENERATOR
// ============================================================================

function generateCanvas(
  resolvedSources: ResolvedSource[],
  narrativeText?: string
): CanvasData {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  let currentY = 0;

  // Track previous pair's media node for reading-order edges
  let previousMediaNodeId: string | null = null;

  // Optional narrative text at top
  if (narrativeText && narrativeText.trim()) {
    const narrativeId = generateNodeId();
    const narrativeHeight = calculateTextHeight(narrativeText);
    nodes.push({
      id: narrativeId,
      type: 'text',
      x: LAYOUT.centerX,
      y: currentY,
      width: LAYOUT.cardWidth,
      height: narrativeHeight,
      text: narrativeText,
    });
    previousMediaNodeId = narrativeId;
    currentY += narrativeHeight + LAYOUT.verticalSpacing;
  }

  // Generate media-text pairs for each source
  for (const source of resolvedSources) {
    if (!source.dreamTalkPath) continue; // skip sources without DreamTalk

    const mediaId = generateNodeId();
    const textId = generateNodeId();

    const textHeight = calculateTextHeight(source.description);

    // Media node (DreamTalk image) in center column
    const mediaNode: CanvasNode = {
      id: mediaId,
      type: 'file',
      x: LAYOUT.centerX,
      y: currentY,
      width: LAYOUT.cardWidth,
      height: LAYOUT.mediaHeight,
      file: source.dreamTalkPath,
    };

    // Text node horizontally adjacent
    const textX = LAYOUT.centerX + LAYOUT.cardWidth + LAYOUT.horizontalOffset;

    // Vertically center the shorter element relative to the taller
    const maxHeight = Math.max(LAYOUT.mediaHeight, textHeight);
    const mediaYOffset = LAYOUT.mediaHeight < maxHeight ? (maxHeight - LAYOUT.mediaHeight) / 2 : 0;
    const textYOffset = textHeight < maxHeight ? (maxHeight - textHeight) / 2 : 0;

    mediaNode.y = currentY + mediaYOffset;

    const textNode: CanvasNode = {
      id: textId,
      type: 'text',
      x: textX,
      y: currentY + textYOffset,
      width: LAYOUT.cardWidth,
      height: textHeight,
      text: source.description,
    };

    nodes.push(mediaNode, textNode);

    // Undirected edge: media ↔ text (toEnd: "none")
    edges.push({
      id: generateNodeId(),
      fromNode: mediaId,
      toNode: textId,
      fromSide: 'right',
      toSide: 'left',
      toEnd: 'none',
    });

    // Directed edge: previous → current (reading order)
    if (previousMediaNodeId) {
      edges.push({
        id: generateNodeId(),
        fromNode: previousMediaNodeId,
        toNode: mediaId,
        fromSide: 'bottom',
        toSide: 'top',
      });
    }

    previousMediaNodeId = mediaId;
    currentY += maxHeight + LAYOUT.verticalSpacing;
  }

  return { nodes, edges };
}

// ============================================================================
// CANVAS PARSER (reimplements InterBrain's dreamsong/parser.ts)
// ============================================================================

interface ProcessedEdge {
  fromNodeId: string;
  toNodeId: string;
  isDirected: boolean;
  edgeId: string;
}

interface MediaTextPair {
  mediaNodeId: string;
  textNodeId: string;
}

interface ConnectedComponent {
  nodes: CanvasNode[];
  averageY: number;
}

function processEdges(edges: CanvasEdge[]): { directed: ProcessedEdge[]; undirected: ProcessedEdge[] } {
  const directed: ProcessedEdge[] = [];
  const undirected: ProcessedEdge[] = [];

  for (const edge of edges) {
    const processed: ProcessedEdge = {
      fromNodeId: edge.fromNode,
      toNodeId: edge.toNode,
      isDirected: edge.toEnd !== 'none',
      edgeId: edge.id,
    };
    if (processed.isDirected) {
      directed.push(processed);
    } else {
      undirected.push(processed);
    }
  }

  return { directed, undirected };
}

function findMediaTextPairs(nodes: CanvasNode[], undirectedEdges: ProcessedEdge[]): MediaTextPair[] {
  const pairs: MediaTextPair[] = [];
  const nodesMap = new Map(nodes.map(n => [n.id, n]));

  for (const edge of undirectedEdges) {
    const fromNode = nodesMap.get(edge.fromNodeId);
    const toNode = nodesMap.get(edge.toNodeId);
    if (!fromNode || !toNode) continue;

    let mediaNode: CanvasNode | null = null;
    let textNode: CanvasNode | null = null;

    if (fromNode.type === 'file' && toNode.type === 'text') {
      mediaNode = fromNode;
      textNode = toNode;
    } else if (fromNode.type === 'text' && toNode.type === 'file') {
      mediaNode = toNode;
      textNode = fromNode;
    }

    if (mediaNode && textNode) {
      pairs.push({ mediaNodeId: mediaNode.id, textNodeId: textNode.id });
    }
  }

  return pairs;
}

function findConnectedComponents(nodes: CanvasNode[], edges: ProcessedEdge[]): ConnectedComponent[] {
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const edge of edges) {
    adjacency.get(edge.fromNodeId)?.add(edge.toNodeId);
    adjacency.get(edge.toNodeId)?.add(edge.fromNodeId);
  }

  const visited = new Set<string>();
  const components: CanvasNode[][] = [];

  function dfs(nodeId: string, component: Set<string>) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    component.add(nodeId);
    const neighbors = adjacency.get(nodeId);
    if (neighbors) {
      for (const neighbor of neighbors) dfs(neighbor, component);
    }
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      const component = new Set<string>();
      dfs(node.id, component);
      components.push(nodes.filter(n => component.has(n.id)));
    }
  }

  return components
    .map(componentNodes => ({
      nodes: componentNodes,
      averageY: componentNodes.reduce((sum, n) => sum + n.y, 0) / componentNodes.length,
    }))
    .sort((a, b) => a.averageY - b.averageY);
}

function topologicalSort(nodes: CanvasNode[], directedEdges: ProcessedEdge[]): string[] {
  const nodeIds = new Set(nodes.map(n => n.id));
  const adjList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const id of nodeIds) {
    adjList.set(id, []);
    inDegree.set(id, 0);
  }

  for (const edge of directedEdges) {
    if (nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)) {
      adjList.get(edge.fromNodeId)!.push(edge.toNodeId);
      inDegree.set(edge.toNodeId, inDegree.get(edge.toNodeId)! + 1);
    }
  }

  const queue: string[] = [];
  for (const node of nodes) {
    if (inDegree.get(node.id) === 0) queue.push(node.id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const neighbor of (adjList.get(current) || [])) {
      inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
      if (inDegree.get(neighbor) === 0) queue.push(neighbor);
    }
  }

  return sorted;
}

function parseCanvasToBlocks(canvasData: CanvasData): DreamSongBlock[] {
  if (!canvasData.nodes || canvasData.nodes.length === 0) return [];

  // Filter to connected nodes only
  const nodesWithEdges = new Set<string>();
  for (const edge of canvasData.edges) {
    nodesWithEdges.add(edge.fromNode);
    nodesWithEdges.add(edge.toNode);
  }
  const connectedNodes = canvasData.nodes.filter(n => nodesWithEdges.has(n.id));

  const { directed, undirected } = processEdges(canvasData.edges);
  const pairs = findMediaTextPairs(connectedNodes, undirected);

  // Exclude paired text nodes from topological sort
  const textNodesInPairs = new Set(pairs.map(p => p.textNodeId));
  const nodesForSort = connectedNodes.filter(n => !textNodesInPairs.has(n.id));

  const islands = findConnectedComponents(nodesForSort, [...directed, ...undirected]);

  const sortedNodeIds: string[] = [];
  for (const island of islands) {
    sortedNodeIds.push(...topologicalSort(island.nodes, directed));
  }

  // Build blocks
  const blocks: DreamSongBlock[] = [];
  const nodesMap = new Map(connectedNodes.map(n => [n.id, n]));
  const processedNodes = new Set<string>();
  const pairsByMediaId = new Map(pairs.map(p => [p.mediaNodeId, p]));

  let isLeftAligned = true;

  for (const nodeId of sortedNodeIds) {
    if (processedNodes.has(nodeId)) continue;
    const node = nodesMap.get(nodeId);
    if (!node) continue;

    const pair = node.type === 'file' ? pairsByMediaId.get(nodeId) : null;

    if (pair && !processedNodes.has(pair.mediaNodeId) && !processedNodes.has(pair.textNodeId)) {
      const mediaNode = nodesMap.get(pair.mediaNodeId);
      const textNode = nodesMap.get(pair.textNodeId);

      if (mediaNode && textNode) {
        blocks.push({
          type: 'media-text',
          filePath: mediaNode.file,
          text: textNode.text || '',
          isLeftAligned,
        });
        processedNodes.add(pair.mediaNodeId);
        processedNodes.add(pair.textNodeId);
        isLeftAligned = !isLeftAligned;
      }
    } else {
      if (node.type === 'file' && node.file) {
        blocks.push({ type: 'media', filePath: node.file });
      } else if (node.type === 'text' && node.text?.trim()) {
        blocks.push({ type: 'text', text: node.text });
      }
      processedNodes.add(nodeId);
    }
  }

  return blocks;
}

// ============================================================================
// TOOL HANDLERS
// ============================================================================

/**
 * Tool: weave_dreamsong
 * Generate a DreamSong.canvas that weaves source DreamNodes into a target DreamNode
 */
export async function weaveDreamsong(args: {
  target_identifier: string;
  sources: SourceInput[];
  narrative_text?: string;
  overwrite?: boolean;
}): Promise<{
  success: boolean;
  canvas_path?: string;
  sources_woven?: string[];
  missing_dreamtalks?: string[];
  error?: string;
}> {
  try {
    const overwrite = args.overwrite !== false; // default true

    // Resolve target DreamNode
    const target = await findDreamNode(args.target_identifier);
    if (!target) {
      return {
        success: false,
        error: `Target DreamNode not found: "${args.target_identifier}". Create it first with create_dreamnode.`,
      };
    }

    // Check for existing DreamSong.canvas
    const canvasPath = path.join(target.path, 'DreamSong.canvas');
    if (fs.existsSync(canvasPath) && !overwrite) {
      return {
        success: false,
        error: `DreamSong.canvas already exists in "${target.title}". Set overwrite: true to replace it.`,
      };
    }

    if (!args.sources || args.sources.length === 0) {
      return {
        success: false,
        error: 'At least one source DreamNode is required.',
      };
    }

    // Resolve each source
    const resolvedSources: ResolvedSource[] = [];
    const missingDreamtalks: string[] = [];
    const errors: string[] = [];

    for (const source of args.sources) {
      const node = await findDreamNode(source.identifier);
      if (!node) {
        errors.push(`Source DreamNode not found: "${source.identifier}"`);
        continue;
      }

      // Read .udd to get dreamTalk filename
      let dreamTalkPath: string | null = null;
      try {
        const udd = await UDDService.readUDD(node.path);
        if (udd.dreamTalk && udd.dreamTalk.trim()) {
          // Vault-relative sovereign path: "DirName/DreamTalk.png"
          const dirName = path.basename(node.path);
          dreamTalkPath = `${dirName}/${udd.dreamTalk}`;
        } else {
          missingDreamtalks.push(node.title);
        }
      } catch {
        missingDreamtalks.push(node.title);
      }

      resolvedSources.push({
        node,
        description: source.description,
        dreamTalkPath,
      });
    }

    if (errors.length > 0 && resolvedSources.length === 0) {
      return {
        success: false,
        error: errors.join('; '),
      };
    }

    // Filter to sources with DreamTalk images for canvas generation
    const sourcesWithImages = resolvedSources.filter(s => s.dreamTalkPath);

    if (sourcesWithImages.length === 0) {
      return {
        success: false,
        error: `None of the source DreamNodes have DreamTalk images. Missing: ${missingDreamtalks.join(', ')}`,
        missing_dreamtalks: missingDreamtalks,
      };
    }

    // Generate canvas
    const canvasData = generateCanvas(sourcesWithImages, args.narrative_text);

    // Write canvas file
    fs.writeFileSync(canvasPath, JSON.stringify(canvasData, null, 2), 'utf-8');

    // Git commit
    await commitAllChanges(target.path, `Weave DreamSong: ${sourcesWithImages.map(s => s.node.title).join(' + ')}`);

    return {
      success: true,
      canvas_path: canvasPath,
      sources_woven: sourcesWithImages.map(s => s.node.title),
      missing_dreamtalks: missingDreamtalks.length > 0 ? missingDreamtalks : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Tool: read_dreamsong
 * Parse a DreamSong.canvas into ordered content blocks
 */
export async function readDreamsong(args: {
  identifier: string;
}): Promise<{
  found: boolean;
  blocks?: DreamSongBlock[];
  node_title?: string;
  error?: string;
}> {
  try {
    const node = await findDreamNode(args.identifier);
    if (!node) {
      return {
        found: false,
        error: `DreamNode not found: "${args.identifier}"`,
      };
    }

    const canvasPath = path.join(node.path, 'DreamSong.canvas');
    if (!fs.existsSync(canvasPath)) {
      return {
        found: false,
        error: `No DreamSong.canvas found in "${node.title}"`,
      };
    }

    const content = fs.readFileSync(canvasPath, 'utf-8');
    const canvasData = JSON.parse(content) as CanvasData;

    if (!canvasData.nodes || !Array.isArray(canvasData.nodes)) {
      return { found: false, error: 'Invalid canvas format: missing nodes array' };
    }
    if (!canvasData.edges) {
      canvasData.edges = [];
    }

    const blocks = parseCanvasToBlocks(canvasData);

    return {
      found: true,
      blocks,
      node_title: node.title,
    };
  } catch (error) {
    return {
      found: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const dreamweavingTools = {
  weave_dreamsong: {
    name: 'weave_dreamsong',
    description: 'Generate a DreamSong.canvas that weaves source DreamNodes into a target DreamNode. Creates an Obsidian canvas file with DreamTalk images and descriptive text, establishing the creative relationships from which submodule imports are inferred.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target_identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to create DreamSong.canvas in (must already exist)',
        },
        sources: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              identifier: {
                type: 'string',
                description: 'UUID or title of a source DreamNode to weave',
              },
              description: {
                type: 'string',
                description: 'Text describing how this DreamNode fits into the story',
              },
            },
            required: ['identifier', 'description'],
          },
          description: 'Source DreamNodes to weave together with their descriptions',
        },
        narrative_text: {
          type: 'string',
          description: 'Optional overall narrative text displayed at the top of the DreamSong',
        },
        overwrite: {
          type: 'boolean',
          description: 'Whether to overwrite an existing DreamSong.canvas (default: true)',
        },
      },
      required: ['target_identifier', 'sources'],
    },
    handler: weaveDreamsong,
  },

  read_dreamsong: {
    name: 'read_dreamsong',
    description: 'Parse a DreamSong.canvas into ordered content blocks. Returns topologically sorted blocks with media-text pairs identified, useful for understanding DreamSong structure.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to read DreamSong from',
        },
      },
      required: ['identifier'],
    },
    handler: readDreamsong,
  },
};
