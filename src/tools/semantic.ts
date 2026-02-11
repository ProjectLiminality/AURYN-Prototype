/**
 * Semantic Search MCP Tools - Vector-based search operations
 * Uses InterBrain's OllamaEmbeddingService via standalone-adapter
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  SemanticSearchService,
  FuzzySearchService,
  createOllamaEmbeddingService,
  discoverAllDreamNodes
} from '../services/standalone-adapter.js';

// Global semantic search service instance
let semanticSearchService: SemanticSearchService | null = null;

// Global fuzzy search service instance (no Ollama dependency)
let fuzzySearchService: FuzzySearchService | null = null;

/**
 * Get or create the semantic search service
 */
function getSemanticSearchService(): SemanticSearchService {
  if (!semanticSearchService) {
    semanticSearchService = new SemanticSearchService();
  }
  return semanticSearchService;
}

/**
 * Get or create the fuzzy search service
 */
function getFuzzySearchService(): FuzzySearchService {
  if (!fuzzySearchService) {
    fuzzySearchService = new FuzzySearchService();
  }
  return fuzzySearchService;
}

// semantic_search REMOVED - consolidated into process_content
// get_context_for_conversation REMOVED - consolidated into process_content
// Use context-provider agent which uses process_content for all semantic search needs

/**
 * Tool: index_dreamnodes
 * Index or reindex all DreamNodes for semantic search
 */
export async function indexDreamnodes(args: {
  force_reindex?: boolean;
}): Promise<{
  success: boolean;
  indexed?: number;
  errors?: number;
  error?: string;
}> {
  try {
    // Check if Ollama is available
    const embeddingService = createOllamaEmbeddingService();
    const ollamaAvailable = await embeddingService.isAvailable();

    if (!ollamaAvailable) {
      return {
        success: false,
        error: 'Ollama not available. Make sure Ollama is running with the nomic-embed-text model. Run: ollama pull nomic-embed-text'
      };
    }

    // Reset service if force reindex
    if (args.force_reindex) {
      semanticSearchService = null;
    }

    const service = getSemanticSearchService();
    const result = await service.indexAllNodes();

    return {
      success: true,
      indexed: result.indexed,
      errors: result.errors
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Tool: check_ollama_status
 * Check if the Ollama embedding service is available
 */
export async function checkOllamaStatus(): Promise<{
  available: boolean;
  base_url: string;
  model: string;
  error?: string;
}> {
  const baseUrl = 'http://localhost:11434';
  const model = 'nomic-embed-text';

  const embeddingService = createOllamaEmbeddingService(baseUrl, model);
  const available = await embeddingService.isAvailable();

  if (!available) {
    return {
      available: false,
      base_url: baseUrl,
      model,
      error: 'Ollama not running or model not installed. Run: ollama pull nomic-embed-text'
    };
  }

  return {
    available: true,
    base_url: baseUrl,
    model
  };
}

/**
 * Tool: process_content
 * Unified semantic search tool for the context-provider agent.
 * Handles both short queries and long text/files with sliding window chunking.
 * Returns candidate DreamNodes - the context-provider agent then filters with LLM intelligence.
 */
export async function processContent(args: {
  text?: string;  // Direct text input
  file_path?: string;  // OR path to transcript/text file (more token-efficient)
  chunk_size?: number;  // words per chunk (default: 150)
  chunk_overlap?: number;  // overlap in words (default: 30)
  threshold?: number;  // similarity threshold (default: 0.35 - low to catch subtle mentions)
  max_candidates_per_chunk?: number;  // max DreamNodes per chunk (default: 5)
}): Promise<{
  success: boolean;
  chunks?: Array<{
    index: number;
    text: string;
    word_count: number;
    candidates: Array<{
      uuid: string;
      title: string;
      type: 'dream' | 'dreamer';
      score: number;
      path: string;
    }>;
  }>;
  unique_candidates?: Array<{
    uuid: string;
    title: string;
    type: 'dream' | 'dreamer';
    best_score: number;
    matched_chunks: number[];
    match_source: 'semantic' | 'fuzzy' | 'both';
    path: string;
  }>;
  stats?: {
    total_chunks: number;
    total_words: number;
    unique_candidates_found: number;
    search_modes_used: string[];
  };
  error?: string;
}> {
  try {
    // Get text from either direct input or file (before Ollama check)
    let inputText: string;
    if (args.file_path) {
      if (!fs.existsSync(args.file_path)) {
        return { success: false, error: `File not found: ${args.file_path}` };
      }
      inputText = fs.readFileSync(args.file_path, 'utf-8');
    } else if (args.text) {
      inputText = args.text;
    } else {
      return { success: false, error: 'Either text or file_path must be provided' };
    }

    // Configuration with defaults
    const chunkSize = args.chunk_size ?? 150;
    const chunkOverlap = args.chunk_overlap ?? 30;
    const threshold = args.threshold ?? 0.35;
    const maxCandidatesPerChunk = args.max_candidates_per_chunk ?? 5;

    // Track which search modes were used
    const searchModesUsed: string[] = [];

    // ---- Fuzzy search (always runs, no Ollama dependency) ----
    const fuzzyService = getFuzzySearchService();
    const fuzzyResults = await fuzzyService.searchByText(inputText, {
      maxResults: 20,
      threshold: 0.25
    });
    searchModesUsed.push('fuzzy');

    // Build unique candidates map with match_source tracking
    const uniqueCandidates = new Map<string, {
      uuid: string;
      title: string;
      type: 'dream' | 'dreamer';
      best_score: number;
      matched_chunks: number[];
      match_source: 'semantic' | 'fuzzy' | 'both';
      path: string;
    }>();

    // Add fuzzy results (matched_chunks: [-1] to indicate fuzzy, not chunk-based)
    for (const r of fuzzyResults) {
      uniqueCandidates.set(r.node.uuid, {
        uuid: r.node.uuid,
        title: r.node.title,
        type: r.node.type,
        best_score: Math.round(r.score * 1000) / 1000,
        matched_chunks: [-1],
        match_source: 'fuzzy',
        path: r.node.path
      });
    }

    // ---- Semantic search (only if Ollama is available) ----
    const semanticService = getSemanticSearchService();
    const ollamaAvailable = await semanticService.isAvailable();

    // Tokenize into words
    const words = inputText.split(/\s+/).filter(w => w.length > 0);
    const totalWords = words.length;

    // For chunk-level results (only populated by semantic search)
    const processedChunks: Array<{
      index: number;
      text: string;
      word_count: number;
      candidates: Array<{
        uuid: string;
        title: string;
        type: 'dream' | 'dreamer';
        score: number;
        path: string;
      }>;
    }> = [];

    let totalChunks = 0;

    if (ollamaAvailable) {
      searchModesUsed.push('semantic');

      // Create sliding window chunks
      const chunks: Array<{ index: number; text: string; words: string[] }> = [];
      let position = 0;
      let chunkIndex = 0;

      while (position < words.length) {
        const chunkWords = words.slice(position, position + chunkSize);
        chunks.push({
          index: chunkIndex,
          text: chunkWords.join(' '),
          words: chunkWords
        });

        position += (chunkSize - chunkOverlap);
        chunkIndex++;

        if (chunkSize <= chunkOverlap) {
          position += 1;
        }
      }

      totalChunks = chunks.length;

      // Process each chunk with semantic search
      for (const chunk of chunks) {
        const results = await semanticService.searchByText(chunk.text, {
          maxResults: maxCandidatesPerChunk,
          threshold: threshold
        });

        const candidates = results.map(r => ({
          uuid: r.node.uuid,
          title: r.node.title,
          type: r.node.type,
          score: Math.round(r.score * 1000) / 1000,
          path: r.node.path
        }));

        // Merge semantic results into unique candidates
        for (const candidate of candidates) {
          const existing = uniqueCandidates.get(candidate.uuid);
          if (existing) {
            existing.matched_chunks.push(chunk.index);
            if (candidate.score > existing.best_score) {
              existing.best_score = candidate.score;
            }
            // Upgrade match_source to 'both' if previously fuzzy-only
            if (existing.match_source === 'fuzzy') {
              existing.match_source = 'both';
            }
          } else {
            uniqueCandidates.set(candidate.uuid, {
              uuid: candidate.uuid,
              title: candidate.title,
              type: candidate.type,
              best_score: candidate.score,
              matched_chunks: [chunk.index],
              match_source: 'semantic',
              path: candidate.path
            });
          }
        }

        processedChunks.push({
          index: chunk.index,
          text: chunk.text,
          word_count: chunk.words.length,
          candidates
        });
      }
    }

    // Sort unique candidates by best score
    const sortedUniqueCandidates = Array.from(uniqueCandidates.values())
      .sort((a, b) => b.best_score - a.best_score);

    return {
      success: true,
      chunks: processedChunks,
      unique_candidates: sortedUniqueCandidates,
      stats: {
        total_chunks: totalChunks,
        total_words: totalWords,
        unique_candidates_found: sortedUniqueCandidates.length,
        search_modes_used: searchModesUsed
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Export tool definitions for MCP registration
 */
export const semanticTools = {
  // semantic_search REMOVED - use context-provider agent
  // get_context_for_conversation REMOVED - use context-provider agent

  index_dreamnodes: {
    name: 'index_dreamnodes',
    description: 'Index all DreamNodes for semantic search. Must be run before first search or after significant changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        force_reindex: {
          type: 'boolean',
          description: 'Force complete reindex even if already indexed'
        }
      }
    },
    handler: indexDreamnodes
  },

  check_ollama_status: {
    name: 'check_ollama_status',
    description: 'Check if the Ollama embedding service is available for semantic search',
    inputSchema: {
      type: 'object' as const,
      properties: {}
    },
    handler: checkOllamaStatus
  },

  process_content: {
    name: 'process_content',
    description: 'Unified semantic search for context-provider agent. Handles short queries and long text/files with sliding window chunking. Returns candidate DreamNodes for LLM filtering. Combines fuzzy text matching (always available) with semantic search (requires Ollama). Falls back to fuzzy-only when Ollama is down.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'Direct text input (use this OR file_path, not both)'
        },
        file_path: {
          type: 'string',
          description: 'Path to transcript/text file - more token-efficient than passing text directly'
        },
        chunk_size: {
          type: 'number',
          description: 'Words per chunk (default: 150). Smaller = more granular but slower.'
        },
        chunk_overlap: {
          type: 'number',
          description: 'Overlap between chunks in words (default: 30). Prevents missing context at boundaries.'
        },
        threshold: {
          type: 'number',
          description: 'Similarity threshold 0-1 (default: 0.35 - intentionally low to catch subtle mentions). Lower = more candidates, more false positives for LLM to filter.'
        },
        max_candidates_per_chunk: {
          type: 'number',
          description: 'Maximum candidate DreamNodes per chunk (default: 5)'
        }
      },
      required: []  // Either text or file_path required, validated in handler
    },
    handler: processContent
  }
};
