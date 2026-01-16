/**
 * AURYN Types - Core data structures for the MCP server
 */

/**
 * UDD file structure - mirrors InterBrain's UDDFile type
 */
export interface UDDFile {
  uuid: string;
  title: string;
  type: 'dream' | 'dreamer';
  dreamTalk: string;
  submodules: string[];
  supermodules: (string | SupermoduleEntry)[];
  email?: string;
  phone?: string;
  radicleId?: string;
  did?: string;
  githubRepoUrl?: string;
  githubPagesUrl?: string;
}

/**
 * Enhanced supermodule entry with historical tracking
 */
export interface SupermoduleEntry {
  radicleId: string;
  title: string;
  atCommit: string;
  addedAt: number;
}

/**
 * DreamNode discovery result
 */
export interface DreamNodeInfo {
  uuid: string;
  title: string;
  type: 'dream' | 'dreamer';
  path: string;
  vaultPath: string;
  radicleId?: string;
  submodules: string[];
  supermodules: (string | SupermoduleEntry)[];
}

/**
 * Vault information
 */
export interface VaultInfo {
  path: string;
  name: string;
}

/**
 * Vector data for semantic search
 */
export interface VectorData {
  nodeId: string;
  contentHash: string;
  embedding: number[];
  lastIndexed: number;
  metadata: {
    title: string;
    type: 'dream' | 'dreamer';
    wordCount: number;
    commitHash?: string;
  };
}

/**
 * Search result with similarity score
 */
export interface SearchResult {
  node: DreamNodeInfo;
  score: number;
  snippet?: string;
}

/**
 * AURYN configuration
 */
export interface AurynConfig {
  vaults: VaultInfo[];
  ollamaBaseUrl: string;
  ollamaModel: string;
}
