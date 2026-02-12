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
// TITLE SANITIZATION (mirrored from InterBrain title-sanitization.ts)
// ============================================================================

/**
 * Sanitize human-readable title to PascalCase for file system and Radicle
 *
 * Examples:
 * - "Financial Support Papa" → "FinancialSupportPapa"
 * - "Mind-Body Connection" → "MindBodyConnection"
 * - "Café Philosophy" → "CafePhilosophy"
 */
function sanitizeTitleToPascalCase(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[\s\-_.]+/)
    .filter(word => word.length > 0)
    .map(word => {
      const cleaned = word.replace(/[^a-zA-Z0-9]/g, '');
      if (cleaned.length === 0) return '';
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
    })
    .filter(word => word.length > 0)
    .join('')
    .substring(0, 100);
}

// ============================================================================
// DEFAULT CONFIGURATION
// ============================================================================

/**
 * Default vault path for DreamNode creation
 * RealDealVault is the primary active vault
 */
export const DEFAULT_VAULT_PATH = '/Users/davidrug/RealDealVault';

// ============================================================================
// LOCAL TYPE DEFINITIONS
// Mirrors InterBrain types for standalone use
// ============================================================================

export interface SupermoduleEntry {
  /** Radicle ID of the parent DreamNode */
  radicleId: string;
  /** Display title of the parent DreamNode */
  title: string;
  /** Commit hash in the parent repo when this was added as submodule */
  atCommit: string;
  /** Timestamp when this relationship was recorded */
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

  static async addSubmodule(dreamNodePath: string, childUuid: string): Promise<void> {
    const udd = await this.readUDD(dreamNodePath);
    if (!udd.submodules.includes(childUuid)) {
      udd.submodules.push(childUuid);
      await this.writeUDD(dreamNodePath, udd);
    }
  }

  static async addSupermoduleEntry(dreamNodePath: string, entry: SupermoduleEntry): Promise<void> {
    const udd = await this.readUDD(dreamNodePath);
    const exists = udd.supermodules.some(s =>
      typeof s === 'object' && 'radicleId' in s && s.radicleId === entry.radicleId
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

/**
 * Initialize Radicle for a git repository
 * Returns the Radicle ID (RID) on success, null on failure
 */
export async function initRadicle(dirPath: string, name: string, description?: string): Promise<string | null> {
  try {
    // Check if rad CLI is available
    await execAsync('which rad');

    // Initialize Radicle repository
    // --private flag ensures it's not immediately public
    // --default-branch main is required (Radicle doesn't auto-detect)
    // Use RAD_PASSPHRASE env var to avoid interactive prompt
    const descArg = description ? `--description "${description.replace(/"/g, '\\"')}"` : '';
    const { stdout } = await execAsync(
      `RAD_PASSPHRASE="" rad init --name "${name.replace(/"/g, '\\"')}" ${descArg} --private --default-branch main`,
      { cwd: dirPath }
    );

    // Extract RID from output (format: "rad:z...")
    const ridMatch = stdout.match(/rad:[a-zA-Z0-9]+/);
    if (ridMatch) {
      return ridMatch[0];
    }

    // If no RID in output, try to get it from rad inspect
    const { stdout: inspectOut } = await execAsync('rad inspect', { cwd: dirPath });
    const inspectMatch = inspectOut.match(/rad:[a-zA-Z0-9]+/);
    return inspectMatch ? inspectMatch[0] : null;
  } catch (error) {
    // Radicle not available or init failed - non-fatal
    console.error('Radicle init failed (non-fatal):', error);
    return null;
  }
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
/**
 * Path to DreamNode template (relative to AURYN)
 * Template contains: udd, README.md, LICENSE, .gitattributes, hooks/
 */
const DREAMNODE_TEMPLATE_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'InterBrain',
  'src',
  'features',
  'dreamnode',
  'DreamNode-template'
);

export class DreamNodeService {
  /**
   * Create a new DreamNode with git repository and Radicle initialization
   * Uses the InterBrain DreamNode-template for proper initialization
   *
   * Process:
   * 1. Create directory and initialize git with template
   * 2. Replace placeholders in template files
   * 3. Move template files from .git/ to working directory
   * 4. Initial commit
   * 5. Initialize Radicle and update .udd with radicleId
   * 6. Commit the Radicle ID update
   */
  static async createDreamNode(
    parentPath: string,
    name: string,
    type: 'dream' | 'dreamer'
  ): Promise<DreamNodeInfo> {
    const dirName = sanitizeTitleToPascalCase(name);
    const nodePath = path.join(parentPath, dirName);
    const uuid = randomUUID();

    // Create directory
    fs.mkdirSync(nodePath, { recursive: true });

    // Initialize git repository with template
    await execAsync(`git init --template="${DREAMNODE_TEMPLATE_PATH}" "${nodePath}"`);

    // Make hooks executable
    const hooksDir = path.join(nodePath, '.git', 'hooks');
    if (fs.existsSync(path.join(hooksDir, 'pre-commit'))) {
      await execAsync(`chmod +x "${path.join(hooksDir, 'pre-commit')}"`);
    }
    if (fs.existsSync(path.join(hooksDir, 'post-commit'))) {
      await execAsync(`chmod +x "${path.join(hooksDir, 'post-commit')}"`);
    }

    // Replace placeholders in template files (still in .git/ directory)
    const gitDir = path.join(nodePath, '.git');

    // Replace in udd file
    const uddSource = path.join(gitDir, 'udd');
    if (fs.existsSync(uddSource)) {
      let uddContent = fs.readFileSync(uddSource, 'utf-8');
      uddContent = uddContent
        .replace('TEMPLATE_UUID_PLACEHOLDER', uuid)
        .replace('TEMPLATE_TITLE_PLACEHOLDER', name)
        .replace('"type": "dream"', `"type": "${type}"`)
        .replace('TEMPLATE_DREAMTALK_PLACEHOLDER', '')
        .replace('TEMPLATE_RADICLE_ID_PLACEHOLDER', '');
      fs.writeFileSync(uddSource, uddContent);
    }

    // Replace in README.md
    const readmeSource = path.join(gitDir, 'README.md');
    if (fs.existsSync(readmeSource)) {
      let readmeContent = fs.readFileSync(readmeSource, 'utf-8');
      readmeContent = readmeContent.replace('{{title}}', name);
      fs.writeFileSync(readmeSource, readmeContent);
    }

    // Move template files from .git/ to working directory
    // .udd
    const uddDest = path.join(nodePath, '.udd');
    if (fs.existsSync(uddSource)) {
      fs.renameSync(uddSource, uddDest);
    }

    // README.md
    const readmeDest = path.join(nodePath, 'README.md');
    if (fs.existsSync(readmeSource)) {
      fs.renameSync(readmeSource, readmeDest);
    }

    // LICENSE
    const licenseSource = path.join(gitDir, 'LICENSE');
    const licenseDest = path.join(nodePath, 'LICENSE');
    if (fs.existsSync(licenseSource)) {
      fs.renameSync(licenseSource, licenseDest);
    }

    // Initial commit
    await commitAllChanges(nodePath, `Initialize DreamNode: ${name}`);

    // Initialize Radicle (after initial commit exists)
    const radicleId = await initRadicle(nodePath, dirName, `DreamNode: ${name}`);

    // Update .udd with radicleId if available
    if (radicleId) {
      const udd = await UDDService.readUDD(nodePath);
      udd.radicleId = radicleId;
      await UDDService.writeUDD(nodePath, udd);
      await commitAllChanges(nodePath, 'Add Radicle ID to DreamNode');
    }

    // Read final UDD to return accurate data
    const finalUdd = await UDDService.readUDD(nodePath);

    return {
      uuid: finalUdd.uuid,
      title: finalUdd.title,
      type: finalUdd.type,
      path: nodePath,
      vaultPath: parentPath,
      radicleId: finalUdd.radicleId,
      submodules: finalUdd.submodules || [],
      supermodules: finalUdd.supermodules || []
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

// ============================================================================
// LIMINAL WEB SERVICE
// Reads/writes liminal-web.json files inside Dreamer nodes
// ============================================================================

export class LiminalWebService {
  static async readLinks(dreamerPath: string): Promise<string[]> {
    const filePath = path.join(dreamerPath, 'liminal-web.json');
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as { relationships: string[] };
      return data.relationships || [];
    } catch {
      return [];
    }
  }

  static async writeLinks(dreamerPath: string, links: string[]): Promise<void> {
    const filePath = path.join(dreamerPath, 'liminal-web.json');
    fs.writeFileSync(filePath, JSON.stringify({ relationships: links }, null, 2), 'utf-8');
  }

  static async addLink(dreamerPath: string, targetUuid: string): Promise<boolean> {
    const links = await this.readLinks(dreamerPath);
    if (links.includes(targetUuid)) return false;
    links.push(targetUuid);
    await this.writeLinks(dreamerPath, links);
    return true;
  }

  static async removeLink(dreamerPath: string, targetUuid: string): Promise<boolean> {
    const links = await this.readLinks(dreamerPath);
    const index = links.indexOf(targetUuid);
    if (index === -1) return false;
    links.splice(index, 1);
    await this.writeLinks(dreamerPath, links);
    return true;
  }
}

/**
 * Standalone Submodule Service
 * Uses InterBrain's git-utils for git operations
 *
 * Relationship tracking uses Radicle IDs (matching InterBrain's submodule-manager-service):
 * - Parent's .udd.submodules[] stores child's Radicle ID
 * - Child's .udd.supermodules[] stores parent's Radicle ID with metadata
 */
export class SubmoduleService {
  /**
   * Add a DreamNode as a git submodule
   * Updates bidirectional relationships using Radicle IDs
   */
  static async addSubmodule(
    parentPath: string,
    childPath: string,
    submoduleName?: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Verify both are git repos
      if (!isGitRepo(parentPath)) {
        return { success: false, error: 'Parent is not a git repository' };
      }
      if (!isGitRepo(childPath)) {
        return { success: false, error: 'Child is not a git repository' };
      }

      // Get submodule name
      const name = submoduleName || path.basename(childPath);

      // Read UDD files for both parent and child
      const childUDD = await UDDService.readUDD(childPath);
      const parentUDD = await UDDService.readUDD(parentPath);

      // Verify both have Radicle IDs (required for proper relationship tracking)
      if (!childUDD.radicleId) {
        return { success: false, error: `Child DreamNode "${childUDD.title}" has no Radicle ID. Run 'rad init' first.` };
      }
      if (!parentUDD.radicleId) {
        return { success: false, error: `Parent DreamNode "${parentUDD.title}" has no Radicle ID. Run 'rad init' first.` };
      }

      // Add git submodule using absolute path (relative paths can conflict with Radicle remote helper)
      // The absolute path works for local submodules and avoids rad:// URL interpretation
      await execAsync(`git submodule add --force "${childPath}" "${name}"`, { cwd: parentPath });

      // Update parent's .udd with child's Radicle ID (matches InterBrain's submodule-manager-service)
      await UDDService.addSubmodule(parentPath, childUDD.radicleId);

      // Update child's .udd with parent's Radicle ID as supermodule
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: parentPath });
      await UDDService.addSupermoduleEntry(childPath, {
        radicleId: parentUDD.radicleId,
        title: parentUDD.title,
        atCommit: stdout.trim(),
        addedAt: Date.now()
      });

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

// ============================================================================
// FUZZY TEXT SEARCH SERVICE
// Mirrors Alfred plugin's alfredMatcher logic for name-based DreamNode matching.
// Runs without Ollama — pure string matching with Levenshtein fallback.
// ============================================================================

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function levenshteinDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);

  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost  // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

export class FuzzySearchService {
  /**
   * Build a match string from a DreamNode, mirroring Alfred's alfredMatcher:
   * strip special chars, split camelCase, collapse whitespace.
   */
  buildMatchString(node: DreamNodeInfo): string {
    const folderName = path.basename(node.path);
    const raw = `${node.title} ${folderName}`;

    return raw
      // Split camelCase: "InterBrain" → "Inter Brain"
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      // Strip special chars except spaces
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Extract search terms from input text.
   * Returns individual words plus n-grams (2-4 words) to catch multi-word DreamNode titles.
   */
  extractSearchTerms(text: string): string[] {
    const words = text
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(w => w.length > 1);

    const terms = new Set<string>();

    // Individual words (3+ chars to avoid noise)
    for (const w of words) {
      if (w.length >= 3) terms.add(w);
    }

    // N-grams (2-4 words) to match multi-word titles
    for (let n = 2; n <= 4 && n <= words.length; n++) {
      for (let i = 0; i <= words.length - n; i++) {
        terms.add(words.slice(i, i + n).join(' '));
      }
    }

    return Array.from(terms);
  }

  /**
   * Score a single search term against a DreamNode.
   * Tiered scoring: exact title > exact folder > prefix > word-boundary > substring > Levenshtein.
   */
  scoreTerm(term: string, node: DreamNodeInfo, matchString: string): number {
    const termLower = term.toLowerCase();
    const titleLower = node.title.toLowerCase();
    const folderLower = path.basename(node.path).toLowerCase();
    const matchLower = matchString.toLowerCase();

    // Exact title match
    if (titleLower === termLower) return 1.0;

    // Exact folder name match
    if (folderLower === termLower) return 0.9;

    // Title starts with term
    if (titleLower.startsWith(termLower)) return 0.85;

    // Word-boundary match in match string (higher for longer terms)
    const wordBoundaryRe = new RegExp(`\\b${escapeRegex(termLower)}`, 'i');
    if (wordBoundaryRe.test(matchString)) {
      const lengthBonus = Math.min(termLower.length / 12, 0.3);
      return 0.5 + lengthBonus;
    }

    // Plain substring in match string
    if (matchLower.includes(termLower)) {
      const lengthBonus = Math.min(termLower.length / 15, 0.3);
      return 0.3 + lengthBonus;
    }

    // Levenshtein for misspellings (only for terms 4+ chars, distance ≤ 2)
    if (termLower.length >= 4) {
      const distTitle = levenshteinDistance(termLower, titleLower);
      const distFolder = levenshteinDistance(termLower, folderLower);
      const minDist = Math.min(distTitle, distFolder);

      if (minDist <= 1) return 0.5;
      if (minDist <= 2) return 0.35;

      // Also check against individual words in match string
      const matchWords = matchLower.split(' ');
      for (const mw of matchWords) {
        if (mw.length >= 3) {
          const d = levenshteinDistance(termLower, mw);
          if (d <= 1) return 0.45;
          if (d <= 2) return 0.3;
        }
      }
    }

    return 0;
  }

  /**
   * Search all DreamNodes by fuzzy text matching.
   * Returns SearchResult[] (same interface as SemanticSearchService.searchByText).
   */
  async searchByText(
    text: string,
    options: { maxResults?: number; threshold?: number } = {}
  ): Promise<SearchResult[]> {
    const { maxResults = 10, threshold = 0.25 } = options;

    const allNodes = await discoverAllDreamNodes();
    const terms = this.extractSearchTerms(text);

    if (terms.length === 0) return [];

    const results: SearchResult[] = [];

    for (const node of allNodes) {
      const matchString = this.buildMatchString(node);
      let bestScore = 0;

      for (const term of terms) {
        const score = this.scoreTerm(term, node, matchString);
        if (score > bestScore) bestScore = score;
      }

      if (bestScore >= threshold) {
        results.push({ node, score: bestScore });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }
}
