/**
 * Semantic Search MCP Tools - Vector-based search operations
 * Uses InterBrain's OllamaEmbeddingService via standalone-adapter
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  SemanticSearchService,
  createOllamaEmbeddingService,
  discoverAllDreamNodes
} from '../services/standalone-adapter.js';

// Global semantic search service instance
let semanticSearchService: SemanticSearchService | null = null;

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
 * Tool: semantic_search
 * Search DreamNodes by semantic similarity to a query
 */
export async function semanticSearch(args: {
  query: string;
  max_results?: number;
  threshold?: number;
}): Promise<{
  success: boolean;
  query?: string;
  results?: Array<{
    uuid: string;
    title: string;
    type: 'dream' | 'dreamer';
    score: number;
    snippet?: string;
    path: string;
  }>;
  error?: string;
}> {
  try {
    const service = getSemanticSearchService();

    // Check if Ollama is available
    const ollamaAvailable = await service.isAvailable();

    if (!ollamaAvailable) {
      return {
        success: false,
        error: 'Ollama not available. Make sure Ollama is running with the nomic-embed-text model. Run: ollama pull nomic-embed-text'
      };
    }

    const results = await service.searchByText(args.query, {
      maxResults: args.max_results ?? 10,
      threshold: args.threshold ?? 0.5
    });

    return {
      success: true,
      query: args.query,
      results: results.map(r => ({
        uuid: r.node.uuid,
        title: r.node.title,
        type: r.node.type,
        score: Math.round(r.score * 1000) / 1000, // Round to 3 decimal places
        snippet: r.snippet,
        path: r.node.path
      }))
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Tool: get_context_for_conversation
 * Given conversation text, find relevant DreamNodes that could provide context
 * This is the "dreamwalk" feature - finding relevant contexts for free-flowing ideation
 */
export async function getContextForConversation(args: {
  conversation: string;
  max_contexts?: number;
  threshold?: number;
}): Promise<{
  success: boolean;
  relevant_nodes?: Array<{
    uuid: string;
    title: string;
    type: 'dream' | 'dreamer';
    relevance: number;
    snippet?: string;
    readme_preview?: string;
  }>;
  error?: string;
}> {
  try {
    const service = getSemanticSearchService();

    // Check if Ollama is available
    const ollamaAvailable = await service.isAvailable();

    if (!ollamaAvailable) {
      return {
        success: false,
        error: 'Ollama not available. Make sure Ollama is running with the nomic-embed-text model.'
      };
    }

    // Use higher threshold for context relevance (0.6 default for stronger matches)
    const results = await service.searchByText(args.conversation, {
      maxResults: args.max_contexts ?? 5,
      threshold: args.threshold ?? 0.6
    });

    // Enhance results with README previews
    const enhancedResults = results.map(r => {
      let readmePreview: string | undefined;

      try {
        const readmePath = path.join(r.node.path, 'README.md');
        if (fs.existsSync(readmePath)) {
          const content = fs.readFileSync(readmePath, 'utf-8');
          // Get first 300 chars after the title
          const withoutTitle = content.replace(/^#.*\n/m, '').trim();
          readmePreview = withoutTitle.length > 300
            ? withoutTitle.substring(0, 297) + '...'
            : withoutTitle;
        }
      } catch {
        // Ignore README read errors
      }

      return {
        uuid: r.node.uuid,
        title: r.node.title,
        type: r.node.type,
        relevance: Math.round(r.score * 1000) / 1000,
        snippet: r.snippet,
        readme_preview: readmePreview
      };
    });

    return {
      success: true,
      relevant_nodes: enhancedResults
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

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
 * Tool: process_stream_of_consciousness
 * Deterministic semantic chunking of stream-of-consciousness text
 * Returns candidate DreamNodes for each chunk - LLM then filters false positives
 */
export async function processStreamOfConsciousness(args: {
  text: string;
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
    path: string;
  }>;
  stats?: {
    total_chunks: number;
    total_words: number;
    unique_candidates_found: number;
  };
  error?: string;
}> {
  try {
    const service = getSemanticSearchService();

    // Check Ollama availability
    const ollamaAvailable = await service.isAvailable();
    if (!ollamaAvailable) {
      return {
        success: false,
        error: 'Ollama not available. Make sure Ollama is running with the nomic-embed-text model.'
      };
    }

    // Configuration with defaults
    const chunkSize = args.chunk_size ?? 150;
    const chunkOverlap = args.chunk_overlap ?? 30;
    const threshold = args.threshold ?? 0.35;  // Low threshold to catch subtle mentions
    const maxCandidatesPerChunk = args.max_candidates_per_chunk ?? 5;

    // Tokenize into words
    const words = args.text.split(/\s+/).filter(w => w.length > 0);
    const totalWords = words.length;

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

      // Move position forward, accounting for overlap
      position += (chunkSize - chunkOverlap);
      chunkIndex++;

      // Prevent infinite loop if overlap >= chunkSize
      if (chunkSize <= chunkOverlap) {
        position += 1;
      }
    }

    // Track unique candidates across all chunks
    const uniqueCandidates = new Map<string, {
      uuid: string;
      title: string;
      type: 'dream' | 'dreamer';
      best_score: number;
      matched_chunks: number[];
      path: string;
    }>();

    // Process each chunk
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

    for (const chunk of chunks) {
      // Search for this chunk
      const results = await service.searchByText(chunk.text, {
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

      // Track unique candidates
      for (const candidate of candidates) {
        const existing = uniqueCandidates.get(candidate.uuid);
        if (existing) {
          existing.matched_chunks.push(chunk.index);
          if (candidate.score > existing.best_score) {
            existing.best_score = candidate.score;
          }
        } else {
          uniqueCandidates.set(candidate.uuid, {
            uuid: candidate.uuid,
            title: candidate.title,
            type: candidate.type,
            best_score: candidate.score,
            matched_chunks: [chunk.index],
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

    // Sort unique candidates by best score
    const sortedUniqueCandidates = Array.from(uniqueCandidates.values())
      .sort((a, b) => b.best_score - a.best_score);

    return {
      success: true,
      chunks: processedChunks,
      unique_candidates: sortedUniqueCandidates,
      stats: {
        total_chunks: chunks.length,
        total_words: totalWords,
        unique_candidates_found: sortedUniqueCandidates.length
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
  semantic_search: {
    name: 'semantic_search',
    description: 'Search DreamNodes by semantic similarity. Returns nodes that are conceptually related to the query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query - can be a word, phrase, or concept'
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default: 10)'
        },
        threshold: {
          type: 'number',
          description: 'Minimum similarity threshold 0-1 (default: 0.5)'
        }
      },
      required: ['query']
    },
    handler: semanticSearch
  },

  get_context_for_conversation: {
    name: 'get_context_for_conversation',
    description: 'Find DreamNodes relevant to a conversation. Use for "dreamwalk" - pulling relevant context during free-flowing ideation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        conversation: {
          type: 'string',
          description: 'Conversation or ideation text to find relevant contexts for'
        },
        max_contexts: {
          type: 'number',
          description: 'Maximum contexts to return (default: 5)'
        },
        threshold: {
          type: 'number',
          description: 'Minimum relevance threshold 0-1 (default: 0.6, higher for stronger matches)'
        }
      },
      required: ['conversation']
    },
    handler: getContextForConversation
  },

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

  process_stream_of_consciousness: {
    name: 'process_stream_of_consciousness',
    description: 'Process stream-of-consciousness text with sliding window semantic search. Returns candidate DreamNodes for each chunk. Use this BEFORE LLM analysis - deterministic semantic sweep first, then filter false positives with LLM intelligence.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'The stream of consciousness text to process (transcript, monologue, etc.)'
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
      required: ['text']
    },
    handler: processStreamOfConsciousness
  }
};
