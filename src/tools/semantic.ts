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
  }
};
