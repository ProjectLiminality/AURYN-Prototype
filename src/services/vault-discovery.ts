/**
 * Vault Discovery Service
 *
 * Discovers Obsidian vaults and scans for DreamNodes (.udd files).
 * Follows the pattern from InterBrain's Alfred plugin.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VaultInfo, DreamNodeInfo, UDDFile } from '../types.js';

/**
 * Get all configured Obsidian vaults from Obsidian's config
 */
export function discoverObsidianVaults(): VaultInfo[] {
  const obsidianConfigPath = path.join(
    os.homedir(),
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

    for (const vaultId of Object.keys(config.vaults)) {
      const vaultData = config.vaults[vaultId];
      if (vaultData.path && typeof vaultData.path === 'string') {
        // Verify vault exists
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
 * Scan a vault for DreamNodes (directories containing .udd files)
 * Scans up to maxDepth levels deep
 */
export function scanVaultForDreamNodes(
  vaultPath: string,
  maxDepth: number = 2
): DreamNodeInfo[] {
  const dreamNodes: DreamNodeInfo[] = [];

  function scanDirectory(dirPath: string, currentDepth: number): void {
    if (currentDepth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // Skip hidden directories and common non-DreamNode paths
        if (entry.name.startsWith('.') ||
            entry.name === 'node_modules' ||
            entry.name === '.obsidian' ||
            entry.name === '.git') {
          continue;
        }

        const fullPath = path.join(dirPath, entry.name);
        const uddPath = path.join(fullPath, '.udd');

        // Check if this directory is a DreamNode
        if (fs.existsSync(uddPath)) {
          try {
            const uddContent = fs.readFileSync(uddPath, 'utf-8');
            const udd: UDDFile = JSON.parse(uddContent);

            // Validate required fields
            if (udd.uuid && udd.title && udd.type) {
              dreamNodes.push({
                uuid: udd.uuid,
                title: udd.title,
                type: udd.type,
                path: fullPath,
                vaultPath: vaultPath,
                radicleId: udd.radicleId,
                submodules: udd.submodules || [],
                supermodules: udd.supermodules || []
              });
            }
          } catch (parseError) {
            console.warn(`Failed to parse .udd at ${uddPath}:`, parseError);
          }
        }

        // Recurse into subdirectories
        scanDirectory(fullPath, currentDepth + 1);
      }
    } catch (error) {
      // Silently skip directories we can't read
    }
  }

  scanDirectory(vaultPath, 0);
  return dreamNodes;
}

/**
 * Discover all DreamNodes across all Obsidian vaults
 */
export function discoverAllDreamNodes(): DreamNodeInfo[] {
  const vaults = discoverObsidianVaults();
  const allDreamNodes: DreamNodeInfo[] = [];

  for (const vault of vaults) {
    const dreamNodes = scanVaultForDreamNodes(vault.path);
    allDreamNodes.push(...dreamNodes);
  }

  return allDreamNodes;
}

/**
 * Find a DreamNode by UUID or title
 */
export function findDreamNode(identifier: string): DreamNodeInfo | null {
  const allNodes = discoverAllDreamNodes();

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
 * Get DreamNode info from a specific path
 */
export function getDreamNodeFromPath(nodePath: string): DreamNodeInfo | null {
  const uddPath = path.join(nodePath, '.udd');

  if (!fs.existsSync(uddPath)) {
    return null;
  }

  try {
    const uddContent = fs.readFileSync(uddPath, 'utf-8');
    const udd: UDDFile = JSON.parse(uddContent);

    if (!udd.uuid || !udd.title || !udd.type) {
      return null;
    }

    // Determine vault path by finding the vault root
    const vaults = discoverObsidianVaults();
    let vaultPath = '';
    for (const vault of vaults) {
      if (nodePath.startsWith(vault.path)) {
        vaultPath = vault.path;
        break;
      }
    }

    return {
      uuid: udd.uuid,
      title: udd.title,
      type: udd.type,
      path: nodePath,
      vaultPath: vaultPath || path.dirname(nodePath),
      radicleId: udd.radicleId,
      submodules: udd.submodules || [],
      supermodules: udd.supermodules || []
    };
  } catch (error) {
    console.error(`Failed to read DreamNode at ${nodePath}:`, error);
    return null;
  }
}
