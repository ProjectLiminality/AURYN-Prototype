/**
 * Standalone Adapter for InterBrain Services
 *
 * Imports and re-exports InterBrain's Obsidian-free services.
 * Only adds thin wrappers where InterBrain doesn't provide standalone functions.
 *
 * Note: InterBrain files are TypeScript - we use tsx for runtime imports.
 * The adapter re-implements essential services for standalone operation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============================================================================
// LOCAL TYPE DEFINITIONS
// Mirrors InterBrain types for standalone use
// ============================================================================

export interface SupermoduleEntry {
  radicleId: string;
  title: string;
  atCommit: string;
  addedAt: number;
}

export interface UDDFile {
  uuid: string;
  title: string;
  type: 'dream' | 'dreamer';
  dreamTalk: string;
  submodules: string[];
  supermodules: (string | SupermoduleEntry)[];
  radicleId?: string;
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
 * Vector data for semantic search (local storage)
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

// ============================================================================
// UDD SERVICE
// Direct implementation for standalone use (mirrors InterBrain's UDDService)
// ============================================================================

export class UDDService {
  static async readUDD(dreamNodePath: string): Promise<UDDFile> {
    const uddPath = path.join(dreamNodePath, '.udd');
    const content = fs.readFileSync(uddPath, 'utf-8');
    const udd = JSON.parse(content) as UDDFile;

    if (!udd.uuid || !udd.title || !udd.type) {
      throw new Error(`Invalid .udd file: missing required fields in ${uddPath}`);
    }

    // Ensure arrays exist
    udd.submodules = udd.submodules || [];
    udd.supermodules = udd.supermodules || [];

    return udd;
  }

  static async writeUDD(dreamNodePath: string, udd: UDDFile): Promise<void> {
    const uddPath = path.join(dreamNodePath, '.udd');
    fs.writeFileSync(uddPath, JSON.stringify(udd, null, 2), 'utf-8');
  }

  static async addSubmodule(dreamNodePath: string, radicleId: string): Promise<void> {
    const udd = await this.readUDD(dreamNodePath);
    if (!udd.submodules.includes(radicleId)) {
      udd.submodules.push(radicleId);
      await this.writeUDD(dreamNodePath, udd);
    }
  }

  static async addSupermoduleEntry(dreamNodePath: string, entry: SupermoduleEntry): Promise<void> {
    const udd = await this.readUDD(dreamNodePath);
    const exists = udd.supermodules.some(s =>
      typeof s === 'object' && s.radicleId === entry.radicleId
    );
    if (!exists) {
      udd.supermodules.push(entry);
      await this.writeUDD(dreamNodePath, udd);
    }
  }
}

// ============================================================================
// GIT UTILITIES
// Direct implementation for standalone use (mirrors InterBrain's git-utils)
// ============================================================================

export async function initRepo(dirPath: string): Promise<void> {
  await execAsync('git init', { cwd: dirPath });
}

export function isGitRepo(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, '.git'));
}

export async function commitAllChanges(dirPath: string, message: string): Promise<void> {
  await execAsync('git add -A', { cwd: dirPath });
  await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: dirPath });
}

export function getSubmoduleNames(dirPath: string): string[] {
  const gitmodulesPath = path.join(dirPath, '.gitmodules');
  if (!fs.existsSync(gitmodulesPath)) return [];

  const content = fs.readFileSync(gitmodulesPath, 'utf-8');
  const names: string[] = [];
  const regex = /\[submodule "([^"]+)"\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    names.push(match[1]);
  }
  return names;
}

// ============================================================================
// VAULT SCANNER
// Direct implementation for standalone use (mirrors InterBrain's vault-scanner)
// ============================================================================

export interface DiscoveredNode {
  dirPath: string;
  udd: UDDFile;
}

export interface VaultScanResult {
  discovered: DiscoveredNode[];
  errors: string[];
}

export async function discoverDreamNodes(vaultPath: string): Promise<VaultScanResult> {
  const discovered: DiscoveredNode[] = [];
  const errors: string[] = [];

  // Only scan direct children of vault root (sovereign DreamNodes)
  // Submodules exist as sovereign nodes at root level, so no need to recurse
  try {
    const entries = fs.readdirSync(vaultPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const dirPath = path.join(vaultPath, entry.name);
        const uddPath = path.join(dirPath, '.udd');

        if (fs.existsSync(uddPath)) {
          try {
            const content = fs.readFileSync(uddPath, 'utf-8');
            const udd = JSON.parse(content) as UDDFile;
            if (udd.uuid && udd.title && udd.type) {
              discovered.push({ dirPath, udd });
            }
          } catch (e) {
            errors.push(`Failed to read ${uddPath}: ${e}`);
          }
        }
      }
    }
  } catch {
    // Ignore permission errors
  }

  return { discovered, errors };
}

// ============================================================================
// OLLAMA EMBEDDING SERVICE
// Direct implementation for standalone use (mirrors InterBrain's service)
// ============================================================================

export interface EmbeddingConfig {
  chunkSize: number;
  chunkOverlap: number;
  maxRetries: number;
  retryDelay: number;
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  chunkSize: 500,
  chunkOverlap: 100,
  maxRetries: 3,
  retryDelay: 1000
};

export class OllamaEmbeddingService {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string = 'http://localhost:11434', model: string = 'nomic-embed-text') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) return false;

      const data = await response.json() as { models: Array<{ name: string; model: string }> };
      return data.models.some(m =>
        m.name === this.model ||
        m.model === this.model ||
        m.name.startsWith(`${this.model}:`)
      );
    } catch {
      return false;
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }

  async processLongText(text: string): Promise<number[]> {
    // For simplicity, just embed the full text (truncated if needed)
    const truncated = text.length > 8000 ? text.substring(0, 8000) : text;
    return this.generateEmbedding(truncated);
  }
}

export function createOllamaEmbeddingService(
  baseUrl: string = 'http://localhost:11434',
  model: string = 'nomic-embed-text'
): OllamaEmbeddingService {
  return new OllamaEmbeddingService(baseUrl, model);
}

// ============================================================================
// VECTOR UTILITIES
// Direct implementation (mirrors InterBrain's VectorUtils)
// ============================================================================

export class VectorUtils {
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }
}

/**
 * Multi-vault discovery - finds Obsidian vaults from config
 * InterBrain assumes single vault from Obsidian context; we need multi-vault for CLI
 */
export function discoverObsidianVaults(): VaultInfo[] {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const obsidianConfigPath = path.join(
    homeDir,
    'Library',
    'Application Support',
    'obsidian',
    'obsidian.json'
  );

  try {
    if (!fs.existsSync(obsidianConfigPath)) {
      console.warn('Obsidian config not found at:', obsidianConfigPath);
      return [];
    }

    const configContent = fs.readFileSync(obsidianConfigPath, 'utf-8');
    const config = JSON.parse(configContent);

    if (!config.vaults || typeof config.vaults !== 'object') {
      console.warn('No vaults found in Obsidian config');
      return [];
    }

    const vaults: VaultInfo[] = [];
    const seenPaths = new Set<string>();

    for (const vaultId of Object.keys(config.vaults)) {
      const vaultData = config.vaults[vaultId];
      if (vaultData.path && typeof vaultData.path === 'string') {
        // Deduplicate by path
        if (seenPaths.has(vaultData.path)) continue;
        seenPaths.add(vaultData.path);

        if (fs.existsSync(vaultData.path)) {
          vaults.push({
            path: vaultData.path,
            name: path.basename(vaultData.path)
          });
        }
      }
    }

    return vaults;
  } catch (error) {
    console.error('Failed to discover Obsidian vaults:', error);
    return [];
  }
}

/**
 * Discover all DreamNodes across all Obsidian vaults
 * Uses InterBrain's discoverDreamNodes for each vault
 * Deduplicates by UUID to avoid duplicates from overlapping vault scans
 */
export async function discoverAllDreamNodes(): Promise<DreamNodeInfo[]> {
  const vaults = discoverObsidianVaults();
  const seenUUIDs = new Set<string>();
  const allDreamNodes: DreamNodeInfo[] = [];

  for (const vault of vaults) {
    const result = await discoverDreamNodes(vault.path);

    for (const node of result.discovered) {
      // Skip if we've already seen this UUID (deduplication)
      if (seenUUIDs.has(node.udd.uuid)) {
        continue;
      }
      seenUUIDs.add(node.udd.uuid);

      allDreamNodes.push({
        uuid: node.udd.uuid,
        title: node.udd.title,
        type: node.udd.type,
        path: node.dirPath,
        vaultPath: vault.path,
        radicleId: node.udd.radicleId,
        submodules: node.udd.submodules || [],
        supermodules: node.udd.supermodules || []
      });
    }
  }

  return allDreamNodes;
}

/**
 * Find a DreamNode by UUID or title
 */
export async function findDreamNode(identifier: string): Promise<DreamNodeInfo | null> {
  const allNodes = await discoverAllDreamNodes();

  // Try exact UUID match first
  const byUUID = allNodes.find(node => node.uuid === identifier);
  if (byUUID) return byUUID;

  // Try exact title match
  const byTitle = allNodes.find(node => node.title === identifier);
  if (byTitle) return byTitle;

  // Try case-insensitive title match
  const lowerIdentifier = identifier.toLowerCase();
  const byTitleCI = allNodes.find(
    node => node.title.toLowerCase() === lowerIdentifier
  );
  if (byTitleCI) return byTitleCI;

  // Try partial title match
  const byPartialTitle = allNodes.find(
    node => node.title.toLowerCase().includes(lowerIdentifier)
  );
  if (byPartialTitle) return byPartialTitle;

  return null;
}

/**
 * Standalone DreamNode Service
 * Wraps InterBrain's git-utils and UDDService for DreamNode operations
 */
export class DreamNodeService {
  /**
   * Create a new DreamNode with git repository
   * Uses InterBrain's initRepo and UDDService
   */
  static async createDreamNode(
    parentPath: string,
    name: string,
    type: 'dream' | 'dreamer'
  ): Promise<DreamNodeInfo> {
    const nodePath = path.join(parentPath, name);

    // Create directory
    fs.mkdirSync(nodePath, { recursive: true });

    // Initialize git repository using InterBrain's git-utils
    await initRepo(nodePath);

    // Generate UUID
    const uuid = randomUUID();

    // Create .udd file using InterBrain's UDDService
    const udd: UDDFile = {
      uuid,
      title: name,
      type,
      dreamTalk: '',
      submodules: [],
      supermodules: []
    };
    await UDDService.writeUDD(nodePath, udd);

    // Create README.md
    const readmeContent = `# ${name}\n\n`;
    fs.writeFileSync(path.join(nodePath, 'README.md'), readmeContent, 'utf-8');

    // Initial commit using InterBrain's git-utils
    await commitAllChanges(nodePath, 'Initialize DreamNode');

    return {
      uuid,
      title: name,
      type,
      path: nodePath,
      vaultPath: parentPath,
      submodules: [],
      supermodules: []
    };
  }

  /**
   * Delete a DreamNode
   */
  static async deleteDreamNode(nodePath: string): Promise<void> {
    const uddExists = fs.existsSync(path.join(nodePath, '.udd'));
    if (!uddExists) {
      throw new Error(`Not a DreamNode: ${nodePath}`);
    }

    fs.rmSync(nodePath, { recursive: true, force: true });
  }

  /**
   * List all DreamNodes with optional filtering
   */
  static async listDreamNodes(options?: {
    typeFilter?: 'dream' | 'dreamer';
    namePattern?: string;
  }): Promise<DreamNodeInfo[]> {
    let nodes = await discoverAllDreamNodes();

    if (options?.typeFilter) {
      nodes = nodes.filter(node => node.type === options.typeFilter);
    }

    if (options?.namePattern) {
      const pattern = options.namePattern.toLowerCase();
      nodes = nodes.filter(node =>
        node.title.toLowerCase().includes(pattern)
      );
    }

    return nodes;
  }

  /**
   * Get a specific DreamNode
   */
  static async getDreamNode(identifier: string): Promise<DreamNodeInfo | null> {
    return findDreamNode(identifier);
  }

  /**
   * Update a DreamNode's metadata using InterBrain's UDDService
   */
  static async updateDreamNode(
    identifier: string,
    updates: { title?: string; type?: 'dream' | 'dreamer' }
  ): Promise<DreamNodeInfo | null> {
    const node = await findDreamNode(identifier);
    if (!node) return null;

    // Read current UDD
    const udd = await UDDService.readUDD(node.path);

    // Apply updates
    if (updates.title !== undefined) udd.title = updates.title;
    if (updates.type !== undefined) udd.type = updates.type;

    // Write back
    await UDDService.writeUDD(node.path, udd);

    // Return updated info
    return {
      ...node,
      title: udd.title,
      type: udd.type
    };
  }
}

/**
 * Standalone Submodule Service
 * Uses InterBrain's git-utils for git operations
 */
export class SubmoduleService {
  /**
   * Add a DreamNode as a git submodule
   */
  static async addSubmodule(
    parentPath: string,
    childPath: string,
    submoduleName?: string
  ): Promise<{ success: boolean; error?: string }> {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    try {
      // Verify both are git repos using InterBrain's git-utils
      if (!isGitRepo(parentPath)) {
        return { success: false, error: 'Parent is not a git repository' };
      }
      if (!isGitRepo(childPath)) {
        return { success: false, error: 'Child is not a git repository' };
      }

      // Get submodule name
      const name = submoduleName || path.basename(childPath);

      // Get child's radicle ID if available
      const childUDD = await UDDService.readUDD(childPath);
      const parentUDD = await UDDService.readUDD(parentPath);

      // Add git submodule using relative path
      const relativePath = path.relative(parentPath, childPath);
      await execAsync(`git submodule add --force "${relativePath}" "${name}"`, { cwd: parentPath });

      // Update parent's .udd with child's radicleId
      if (childUDD.radicleId) {
        await UDDService.addSubmodule(parentPath, childUDD.radicleId);
      }

      // Update child's .udd with parent's radicleId
      if (parentUDD.radicleId) {
        const { stdout } = await execAsync('git rev-parse HEAD', { cwd: parentPath });
        await UDDService.addSupermoduleEntry(childPath, {
          radicleId: parentUDD.radicleId,
          title: parentUDD.title,
          atCommit: stdout.trim(),
          addedAt: Date.now()
        });
      }

      // Commit the change
      await commitAllChanges(parentPath, `Add submodule: ${name}`);

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Remove a git submodule
   */
  static async removeSubmodule(
    parentPath: string,
    submoduleName: string
  ): Promise<{ success: boolean; error?: string }> {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    try {
      // Deinitialize submodule
      await execAsync(`git submodule deinit -f "${submoduleName}"`, { cwd: parentPath });

      // Remove from git
      await execAsync(`git rm -f "${submoduleName}"`, { cwd: parentPath });

      // Remove directory if still exists
      const submodulePath = path.join(parentPath, submoduleName);
      if (fs.existsSync(submodulePath)) {
        fs.rmSync(submodulePath, { recursive: true, force: true });
      }

      // Commit the change
      await commitAllChanges(parentPath, `Remove submodule: ${submoduleName}`);

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  /**
   * List submodules in a DreamNode
   */
  static async listSubmodules(parentPath: string): Promise<string[]> {
    return getSubmoduleNames(parentPath);
  }
}

/**
 * Standalone Semantic Search Service
 * Uses InterBrain's OllamaEmbeddingService and VectorUtils
 */
export class SemanticSearchService {
  private embeddingService: OllamaEmbeddingService;
  private vectorCache: Map<string, VectorData> = new Map();

  constructor(embeddingService?: OllamaEmbeddingService) {
    this.embeddingService = embeddingService || createOllamaEmbeddingService();
  }

  /**
   * Check if embedding service is available
   */
  async isAvailable(): Promise<boolean> {
    return this.embeddingService.isAvailable();
  }

  /**
   * Index a DreamNode for search
   */
  async indexNode(node: DreamNodeInfo): Promise<VectorData> {
    // Read README content
    const readmePath = path.join(node.path, 'README.md');
    let textContent = node.title;

    if (fs.existsSync(readmePath)) {
      const readmeContent = fs.readFileSync(readmePath, 'utf-8');
      textContent = `${node.title}\n${readmeContent}`;
    }

    // Generate embedding using InterBrain's OllamaEmbeddingService
    const embedding = await this.embeddingService.processLongText(textContent);

    const vectorData: VectorData = {
      nodeId: node.uuid,
      contentHash: this.hashContent(textContent),
      embedding,
      lastIndexed: Date.now(),
      metadata: {
        title: node.title,
        type: node.type,
        wordCount: textContent.split(/\s+/).length
      }
    };

    this.vectorCache.set(node.uuid, vectorData);
    return vectorData;
  }

  /**
   * Index all DreamNodes
   */
  async indexAllNodes(): Promise<{ indexed: number; errors: number }> {
    const nodes = await discoverAllDreamNodes();
    let indexed = 0;
    let errors = 0;

    for (const node of nodes) {
      try {
        await this.indexNode(node);
        indexed++;
      } catch (error) {
        console.error(`Failed to index ${node.title}:`, error);
        errors++;
      }
    }

    return { indexed, errors };
  }

  /**
   * Search for nodes by semantic similarity
   * Uses InterBrain's VectorUtils.cosineSimilarity
   */
  async searchByText(
    query: string,
    options: { maxResults?: number; threshold?: number } = {}
  ): Promise<SearchResult[]> {
    const { maxResults = 10, threshold = 0.5 } = options;

    // Ensure all nodes are indexed
    if (this.vectorCache.size === 0) {
      await this.indexAllNodes();
    }

    // Generate query embedding
    const queryEmbedding = await this.embeddingService.processLongText(query);

    // Get all nodes once (already deduplicated by UUID)
    const allNodes = await discoverAllDreamNodes();
    const nodesByUUID = new Map(allNodes.map(n => [n.uuid, n]));

    // Calculate similarities - iterate over cache to avoid duplicates
    const results: SearchResult[] = [];

    for (const [uuid, vectorData] of this.vectorCache.entries()) {
      const node = nodesByUUID.get(uuid);
      if (!node) continue;

      const score = VectorUtils.cosineSimilarity(queryEmbedding, vectorData.embedding);

      if (score >= threshold) {
        results.push({
          node,
          score,
          snippet: this.generateSnippet(node)
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, maxResults);
  }

  /**
   * Generate snippet for search result
   */
  private generateSnippet(node: DreamNodeInfo): string {
    const readmePath = path.join(node.path, 'README.md');

    if (fs.existsSync(readmePath)) {
      const content = fs.readFileSync(readmePath, 'utf-8');
      const cleaned = content.replace(/^#.*\n/gm, '').trim();
      if (cleaned.length <= 150) return cleaned;
      return cleaned.substring(0, 147) + '...';
    }

    return '';
  }

  /**
   * Simple hash function for content
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }
}
