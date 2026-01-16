/**
 * Standalone Adapter for InterBrain Services
 *
 * Provides standalone implementations of InterBrain services
 * without requiring Obsidian's Plugin or App context.
 */

import * as fs from 'fs';
import * as path from 'path';
import { UDDFile, SupermoduleEntry, DreamNodeInfo, VectorData, SearchResult } from '../types.js';
import { discoverAllDreamNodes, findDreamNode, getDreamNodeFromPath } from './vault-discovery.js';
import { simpleGit, SimpleGit } from 'simple-git';
import { randomUUID } from 'crypto';

/**
 * Standalone UDD Service - mirrors InterBrain's UDDService
 * Uses Node.js fs directly (no Obsidian dependency)
 */
export class UDDService {
  /**
   * Read and parse a .udd file
   */
  static readUDD(dreamNodePath: string): UDDFile {
    const uddPath = path.join(dreamNodePath, '.udd');

    try {
      const content = fs.readFileSync(uddPath, 'utf-8');
      const udd = JSON.parse(content) as UDDFile;

      if (!udd.uuid || !udd.title || !udd.type) {
        throw new Error(`Invalid .udd file: missing required fields in ${uddPath}`);
      }

      // Ensure arrays exist
      udd.submodules = udd.submodules || [];
      udd.supermodules = udd.supermodules || [];

      return udd;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to read .udd file from ${dreamNodePath}: ${errorMessage}`);
    }
  }

  /**
   * Write a UDD object to a .udd file
   */
  static writeUDD(dreamNodePath: string, udd: UDDFile): void {
    const uddPath = path.join(dreamNodePath, '.udd');

    try {
      const content = JSON.stringify(udd, null, 2);
      fs.writeFileSync(uddPath, content, 'utf-8');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to write .udd file to ${dreamNodePath}: ${errorMessage}`);
    }
  }

  /**
   * Create a new .udd file
   */
  static createUDD(dreamNodePath: string, data: {
    uuid: string;
    title: string;
    type: 'dream' | 'dreamer';
    dreamTalk?: string;
    radicleId?: string;
  }): void {
    const udd: UDDFile = {
      uuid: data.uuid,
      title: data.title,
      type: data.type,
      dreamTalk: data.dreamTalk || '',
      submodules: [],
      supermodules: [],
      radicleId: data.radicleId
    };
    this.writeUDD(dreamNodePath, udd);
  }

  /**
   * Update metadata in a .udd file
   */
  static updateUDD(dreamNodePath: string, updates: Partial<UDDFile>): void {
    const udd = this.readUDD(dreamNodePath);

    // Apply updates (only allow certain fields to be updated)
    if (updates.title !== undefined) udd.title = updates.title;
    if (updates.type !== undefined) udd.type = updates.type;
    if (updates.dreamTalk !== undefined) udd.dreamTalk = updates.dreamTalk;
    if (updates.email !== undefined) udd.email = updates.email;
    if (updates.phone !== undefined) udd.phone = updates.phone;
    if (updates.radicleId !== undefined) udd.radicleId = updates.radicleId;
    if (updates.did !== undefined) udd.did = updates.did;
    if (updates.githubRepoUrl !== undefined) udd.githubRepoUrl = updates.githubRepoUrl;
    if (updates.githubPagesUrl !== undefined) udd.githubPagesUrl = updates.githubPagesUrl;

    this.writeUDD(dreamNodePath, udd);
  }

  /**
   * Add a submodule relationship
   */
  static addSubmodule(dreamNodePath: string, childRadicleId: string): boolean {
    const udd = this.readUDD(dreamNodePath);

    if (udd.submodules.includes(childRadicleId)) {
      return false;
    }

    udd.submodules.push(childRadicleId);
    this.writeUDD(dreamNodePath, udd);
    return true;
  }

  /**
   * Remove a submodule relationship
   */
  static removeSubmodule(dreamNodePath: string, childRadicleId: string): boolean {
    const udd = this.readUDD(dreamNodePath);

    const index = udd.submodules.indexOf(childRadicleId);
    if (index === -1) {
      return false;
    }

    udd.submodules.splice(index, 1);
    this.writeUDD(dreamNodePath, udd);
    return true;
  }

  /**
   * Add a supermodule entry
   */
  static addSupermoduleEntry(dreamNodePath: string, entry: SupermoduleEntry): boolean {
    const udd = this.readUDD(dreamNodePath);

    const exists = udd.supermodules.some(existing =>
      typeof existing === 'string'
        ? existing === entry.radicleId
        : existing.radicleId === entry.radicleId
    );

    if (exists) {
      return false;
    }

    udd.supermodules.push(entry);
    this.writeUDD(dreamNodePath, udd);
    return true;
  }

  /**
   * Remove a supermodule relationship
   */
  static removeSupermodule(dreamNodePath: string, radicleId: string): boolean {
    const udd = this.readUDD(dreamNodePath);

    const index = udd.supermodules.findIndex(entry =>
      typeof entry === 'string' ? entry === radicleId : entry.radicleId === radicleId
    );

    if (index === -1) {
      return false;
    }

    udd.supermodules.splice(index, 1);
    this.writeUDD(dreamNodePath, udd);
    return true;
  }

  /**
   * Check if .udd file exists
   */
  static uddExists(dreamNodePath: string): boolean {
    const uddPath = path.join(dreamNodePath, '.udd');
    return fs.existsSync(uddPath);
  }
}

/**
 * Standalone DreamNode Service - handles creation and management
 */
export class DreamNodeService {
  /**
   * Create a new DreamNode with git repository
   */
  static async createDreamNode(
    parentPath: string,
    name: string,
    type: 'dream' | 'dreamer'
  ): Promise<DreamNodeInfo> {
    const nodePath = path.join(parentPath, name);

    // Create directory
    fs.mkdirSync(nodePath, { recursive: true });

    // Initialize git repository
    const git: SimpleGit = simpleGit(nodePath);
    await git.init();

    // Generate UUID
    const uuid = randomUUID();

    // Create .udd file
    UDDService.createUDD(nodePath, {
      uuid,
      title: name,
      type
    });

    // Create README.md
    const readmeContent = `# ${name}\n\n`;
    fs.writeFileSync(path.join(nodePath, 'README.md'), readmeContent, 'utf-8');

    // Initial commit
    await git.add(['.udd', 'README.md']);
    await git.commit('Initialize DreamNode');

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
    if (!UDDService.uddExists(nodePath)) {
      throw new Error(`Not a DreamNode: ${nodePath}`);
    }

    fs.rmSync(nodePath, { recursive: true, force: true });
  }

  /**
   * List all DreamNodes
   */
  static listDreamNodes(options?: {
    typeFilter?: 'dream' | 'dreamer';
    namePattern?: string;
  }): DreamNodeInfo[] {
    let nodes = discoverAllDreamNodes();

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
  static getDreamNode(identifier: string): DreamNodeInfo | null {
    return findDreamNode(identifier);
  }

  /**
   * Update a DreamNode's metadata
   */
  static updateDreamNode(
    identifier: string,
    updates: { title?: string; type?: 'dream' | 'dreamer' }
  ): DreamNodeInfo | null {
    const node = findDreamNode(identifier);
    if (!node) return null;

    UDDService.updateUDD(node.path, updates);

    // Return updated info
    return getDreamNodeFromPath(node.path);
  }
}

/**
 * Standalone Submodule Service - handles git submodule operations
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
    try {
      const git: SimpleGit = simpleGit(parentPath);

      // Verify both are git repos
      const parentIsRepo = await git.checkIsRepo();
      if (!parentIsRepo) {
        return { success: false, error: 'Parent is not a git repository' };
      }

      const childGit: SimpleGit = simpleGit(childPath);
      const childIsRepo = await childGit.checkIsRepo();
      if (!childIsRepo) {
        return { success: false, error: 'Child is not a git repository' };
      }

      // Get submodule name
      const name = submoduleName || path.basename(childPath);

      // Get child's radicle ID if available
      const childUDD = UDDService.readUDD(childPath);
      const parentUDD = UDDService.readUDD(parentPath);

      // Add git submodule (using relative path for portability)
      const relativePath = path.relative(parentPath, childPath);
      await git.submoduleAdd(relativePath, name);

      // Update parent's .udd with child's radicleId (if available)
      if (childUDD.radicleId) {
        UDDService.addSubmodule(parentPath, childUDD.radicleId);
      }

      // Update child's .udd with parent's radicleId (if available)
      if (parentUDD.radicleId) {
        UDDService.addSupermoduleEntry(childPath, {
          radicleId: parentUDD.radicleId,
          title: parentUDD.title,
          atCommit: (await git.revparse(['HEAD'])).trim(),
          addedAt: Date.now()
        });
      }

      // Commit the change
      await git.add(['.gitmodules', name, '.udd']);
      await git.commit(`Add submodule: ${name}`);

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
    try {
      const git: SimpleGit = simpleGit(parentPath);

      // Deinitialize submodule
      await git.raw(['submodule', 'deinit', '-f', submoduleName]);

      // Remove from git
      await git.rm(['-f', submoduleName]);

      // Remove directory if still exists
      const submodulePath = path.join(parentPath, submoduleName);
      if (fs.existsSync(submodulePath)) {
        fs.rmSync(submodulePath, { recursive: true, force: true });
      }

      // Update .udd to remove the relationship
      // Note: We'd need the radicleId to properly remove, skipping for now

      // Commit the change
      await git.add(['.gitmodules', '.udd']);
      await git.commit(`Remove submodule: ${submoduleName}`);

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
    try {
      const git: SimpleGit = simpleGit(parentPath);
      const status = await git.subModule(['status']);

      if (!status.trim()) {
        return [];
      }

      // Parse submodule status output
      const lines = status.split('\n').filter(line => line.trim());
      const names: string[] = [];

      for (const line of lines) {
        // Format: " hash path (branch)" or "+hash path (branch)"
        const match = line.match(/^[\s+-]\w+\s+(.+?)(?:\s+\(.+\))?$/);
        if (match) {
          names.push(path.basename(match[1]));
        }
      }

      return names;
    } catch (error) {
      console.error('Failed to list submodules:', error);
      return [];
    }
  }
}

/**
 * Standalone Embedding Service - uses Ollama for vector embeddings
 */
export class EmbeddingService {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string = 'http://localhost:11434', model: string = 'nomic-embed-text') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  /**
   * Check if Ollama is available
   */
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

  /**
   * Generate embedding for text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: text.trim()
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.status}`);
    }

    const data = await response.json() as { embedding: number[] };
    if (!data.embedding || !Array.isArray(data.embedding)) {
      throw new Error('Invalid embedding response');
    }

    return data.embedding;
  }

  /**
   * Calculate cosine similarity between two vectors
   */
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

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (normA * normB);
  }
}

/**
 * Standalone Semantic Search Service
 */
export class SemanticSearchService {
  private embeddingService: EmbeddingService;
  private vectorCache: Map<string, VectorData> = new Map();

  constructor(embeddingService?: EmbeddingService) {
    this.embeddingService = embeddingService || new EmbeddingService();
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

    // Generate embedding
    const embedding = await this.embeddingService.generateEmbedding(textContent);

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
    const nodes = discoverAllDreamNodes();
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
    const queryEmbedding = await this.embeddingService.generateEmbedding(query);

    // Calculate similarities
    const results: SearchResult[] = [];
    const allNodes = discoverAllDreamNodes();

    for (const node of allNodes) {
      const vectorData = this.vectorCache.get(node.uuid);
      if (!vectorData) continue;

      const score = EmbeddingService.cosineSimilarity(queryEmbedding, vectorData.embedding);

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
      // Return first 150 characters
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
