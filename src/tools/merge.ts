/**
 * Merge DreamNodes MCP Tool
 *
 * Two modes:
 *
 * 1. **Standard merge** — Two independent DreamNodes (A + B) become a new entity C
 *    with new UUID, new Radicle ID, merge-ancestry.json tracking lineage.
 *    Ghost forks preserved for backpropagation.
 *
 * 2. **Absorb merge** — B is a submodule of A. A absorbs B: the submodule is
 *    dissolved, B's history merges into A, A keeps its UUID and Radicle ID.
 *    B's sovereign directory is deleted and its Radicle repo is removed.
 *    External references (parents, liminal web, DreamSongs) are updated.
 *    This is the inverse of pop-out-to-sovereign.
 *
 * Auto-detected: if B appears in A's .gitmodules, it's an absorb merge.
 */

import {
  findDreamNode,
  discoverAllDreamNodes,
  isGitRepo,
  commitAllChanges,
  initRadicle,
  sanitizeTitleToPascalCase,
  UDDService,
  LiminalWebService,
  SubmoduleService,
  MergeAncestryService,
  type DreamNodeInfo,
  type UDDFile,
  type MergeAncestryFile,
  type SupermoduleEntry,
} from '../services/standalone-adapter.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(exec);

/**
 * Helper: check if a git working tree is clean
 */
async function isCleanWorkingTree(repoPath: string): Promise<boolean> {
  const { stdout } = await execAsync('git status --porcelain', { cwd: repoPath });
  return stdout.trim() === '';
}

/**
 * Helper: get list of conflicted files during a merge
 */
async function getConflictedFiles(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git diff --name-only --diff-filter=U', { cwd: repoPath });
    return stdout.trim().split('\n').filter(f => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Helper: safely execute git show for a merge stage, returns empty string on failure
 */
async function gitShowStage(repoPath: string, stage: number, filePath: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git show :${stage}:${filePath}`, { cwd: repoPath });
    return stdout;
  } catch {
    return '';
  }
}

/**
 * Helper: deduplicate submodule/supermodule lists by Radicle ID, falling back to raw value
 */
function deduplicateByRadicleId(listA: string[], listB: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of [...listA, ...listB]) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function deduplicateSupermodules(
  listA: (string | SupermoduleEntry)[],
  listB: (string | SupermoduleEntry)[]
): (string | SupermoduleEntry)[] {
  const seen = new Set<string>();
  const result: (string | SupermoduleEntry)[] = [];
  for (const item of [...listA, ...listB]) {
    const key = typeof item === 'string' ? item : item.radicleId;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

/**
 * Helper: find submodule entry in parent's .gitmodules by child's sovereign path (URL).
 * Returns the submodule name and path if found.
 */
function findSubmoduleByUrl(
  parentPath: string,
  childSovereignPath: string
): { name: string; subPath: string } | null {
  const gitmodulesPath = path.join(parentPath, '.gitmodules');
  if (!fs.existsSync(gitmodulesPath)) return null;

  const content = fs.readFileSync(gitmodulesPath, 'utf-8');
  const regex = /\[submodule "([^"]+)"\]\s*\n\s*path\s*=\s*([^\n]+)\n\s*url\s*=\s*([^\n]+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    const subPath = match[2].trim();
    const url = match[3].trim();
    if (url === childSovereignPath) return { name, subPath };
  }
  return null;
}

interface MergeResult {
  success: boolean;
  is_absorb?: boolean;
  merged_node?: {
    uuid: string;
    title: string;
    type: 'dream' | 'dreamer';
    path: string;
    radicleId?: string;
  };
  ancestors?: Array<{
    uuid: string;
    title: string;
    role: 'primary' | 'secondary' | 'absorber' | 'absorbed';
  }>;
  had_conflicts: boolean;
  conflict_files: string[];
  references_updated: {
    liminal_web: number;
    submodule_parents: number;
    dreamsong_canvases: number;
    supermodule_children: number;
  };
  ghost_forks_preserved: string[];
  absorbed_radicle_removed?: boolean;
  error?: string;
}

/**
 * Tool: merge_dreamnodes
 * Merge two DreamNodes into one sovereign entity, preserving both git histories.
 */
export async function mergeDreamNodes(args: {
  node_a_identifier: string;
  node_b_identifier: string;
  merged_name?: string;
  merged_type?: 'dream' | 'dreamer';
  dreamtalk_source?: 'a' | 'b';
  confirm: boolean;
}): Promise<MergeResult> {
  const hadConflicts = false;
  const conflictFiles: string[] = [];
  const refsUpdated = {
    liminal_web: 0,
    submodule_parents: 0,
    dreamsong_canvases: 0,
    supermodule_children: 0,
  };
  const ghostForks: string[] = [];

  try {
    // ========================================================================
    // Phase 1 — Validate
    // ========================================================================
    if (!args.confirm) {
      return {
        success: false,
        had_conflicts: false,
        conflict_files: [],
        references_updated: refsUpdated,
        ghost_forks_preserved: [],
        error: 'Merge requires confirmation. Set confirm: true to proceed.',
      };
    }

    const nodeA = await findDreamNode(args.node_a_identifier);
    if (!nodeA) {
      return {
        success: false,
        had_conflicts: false,
        conflict_files: [],
        references_updated: refsUpdated,
        ghost_forks_preserved: [],
        error: `Node A not found: ${args.node_a_identifier}`,
      };
    }

    const nodeB = await findDreamNode(args.node_b_identifier);
    if (!nodeB) {
      return {
        success: false,
        had_conflicts: false,
        conflict_files: [],
        references_updated: refsUpdated,
        ghost_forks_preserved: [],
        error: `Node B not found: ${args.node_b_identifier}`,
      };
    }

    if (nodeA.uuid === nodeB.uuid) {
      return {
        success: false,
        had_conflicts: false,
        conflict_files: [],
        references_updated: refsUpdated,
        ghost_forks_preserved: [],
        error: 'Cannot merge a DreamNode with itself.',
      };
    }

    if (nodeA.vaultPath !== nodeB.vaultPath) {
      return {
        success: false,
        had_conflicts: false,
        conflict_files: [],
        references_updated: refsUpdated,
        ghost_forks_preserved: [],
        error: `Both nodes must be in the same vault. A is in ${nodeA.vaultPath}, B is in ${nodeB.vaultPath}.`,
      };
    }

    if (!isGitRepo(nodeA.path) || !isGitRepo(nodeB.path)) {
      return {
        success: false,
        had_conflicts: false,
        conflict_files: [],
        references_updated: refsUpdated,
        ghost_forks_preserved: [],
        error: 'Both DreamNodes must be git repositories.',
      };
    }

    if (!(await isCleanWorkingTree(nodeA.path))) {
      return {
        success: false,
        had_conflicts: false,
        conflict_files: [],
        references_updated: refsUpdated,
        ghost_forks_preserved: [],
        error: `Node A (${nodeA.title}) has uncommitted changes. Commit or stash before merging.`,
      };
    }

    if (!(await isCleanWorkingTree(nodeB.path))) {
      return {
        success: false,
        had_conflicts: false,
        conflict_files: [],
        references_updated: refsUpdated,
        ghost_forks_preserved: [],
        error: `Node B (${nodeB.title}) has uncommitted changes. Commit or stash before merging.`,
      };
    }

    const uddA = await UDDService.readUDD(nodeA.path);
    const uddB = await UDDService.readUDD(nodeB.path);

    const mergedName = args.merged_name || uddA.title;
    const mergedType = args.merged_type || uddA.type;
    const mergedDirName = sanitizeTitleToPascalCase(mergedName);
    const mergedPath = path.join(nodeA.vaultPath, mergedDirName);

    // ========================================================================
    // Absorb detection — is B a submodule of A?
    // ========================================================================
    const absorbInfo = findSubmoduleByUrl(nodeA.path, nodeB.path);
    const isAbsorb = absorbInfo !== null;

    // For absorb merges, A survives in place — directory name unchanged
    const finalPath = isAbsorb ? nodeA.path : mergedPath;
    const finalDirName = isAbsorb ? path.basename(nodeA.path) : mergedDirName;

    // Check directory collision (only for standard merge — absorb reuses A's path)
    if (!isAbsorb && fs.existsSync(mergedPath)) {
      if (mergedPath !== nodeA.path && mergedPath !== nodeB.path) {
        return {
          success: false,
          had_conflicts: false,
          conflict_files: [],
          references_updated: refsUpdated,
          ghost_forks_preserved: [],
          error: `Directory already exists: ${mergedPath}. Choose a different name.`,
        };
      }
    }

    // ========================================================================
    // Phase 2 — Create working copy from A's history
    // ========================================================================
    const tempDir = path.join(nodeA.vaultPath, `.merge-temp-${Date.now()}`);
    await execAsync(`git clone "${nodeA.path}" "${tempDir}"`);
    await execAsync('git remote remove origin', { cwd: tempDir });

    // Absorb: dissolve B's submodule before merging B's history
    if (isAbsorb && absorbInfo) {
      // Resolve actual indexed path (may differ in case from .gitmodules on macOS)
      let actualSubPath = absorbInfo.subPath;
      try {
        const { stdout: lsFiles } = await execAsync('git ls-files --stage', { cwd: tempDir });
        for (const line of lsFiles.split('\n')) {
          if (!line.startsWith('160000')) continue;
          const parts = line.split('\t');
          if (parts.length >= 2) {
            const indexedPath = parts[1].trim();
            if (indexedPath.toLowerCase() === absorbInfo.subPath.toLowerCase()) {
              actualSubPath = indexedPath;
              break;
            }
          }
        }
      } catch { /* use .gitmodules path as fallback */ }

      try {
        await execAsync(`git submodule deinit -f "${actualSubPath}"`, { cwd: tempDir });
      } catch {
        // May fail if submodule not initialized in clone — that's OK
      }
      await execAsync(`git rm -f "${actualSubPath}"`, { cwd: tempDir });

      // Clean up .git/modules cache
      const gitModulesCache = path.join(tempDir, '.git', 'modules', absorbInfo.name);
      if (fs.existsSync(gitModulesCache)) {
        fs.rmSync(gitModulesCache, { recursive: true, force: true });
      }

      // If .gitmodules is now empty, remove it
      const tempGitmodules = path.join(tempDir, '.gitmodules');
      if (fs.existsSync(tempGitmodules)) {
        const gmContent = fs.readFileSync(tempGitmodules, 'utf-8').trim();
        if (gmContent === '') {
          fs.rmSync(tempGitmodules);
          try { await execAsync('git rm -f .gitmodules', { cwd: tempDir }); } catch { /* already gone */ }
        }
      }

      await commitAllChanges(tempDir, `Dissolve submodule ${nodeB.title} for absorption`);
    }

    // ========================================================================
    // Phase 3 — Merge B's history
    // ========================================================================
    await execAsync(`git remote add ancestor-b "${nodeB.path}"`, { cwd: tempDir });
    await execAsync('git fetch ancestor-b', { cwd: tempDir });

    let mergeHadConflicts = false;
    try {
      await execAsync('git merge ancestor-b/main --allow-unrelated-histories --no-commit', { cwd: tempDir });
    } catch {
      // Merge conflicts — expected for unrelated histories with overlapping files
      mergeHadConflicts = true;
    }

    // Resolve conflicts
    const conflicted = await getConflictedFiles(tempDir);
    if (conflicted.length > 0) {
      for (const file of conflicted) {
        if (file === '.udd') {
          // .udd will be completely overwritten in Phase 4
          await execAsync('git checkout --ours .udd', { cwd: tempDir });
        } else if (file === 'README.md') {
          // Concatenate both READMEs
          const oursReadme = await gitShowStage(tempDir, 2, 'README.md');
          const theirsReadme = await gitShowStage(tempDir, 3, 'README.md');
          const combinedReadme = `${oursReadme}\n\n---\n\n# Merged from: ${uddB.title}\n\n${theirsReadme}`;
          fs.writeFileSync(path.join(tempDir, 'README.md'), combinedReadme, 'utf-8');
          await execAsync('git add README.md', { cwd: tempDir });
        } else if (file === 'liminal-web.json') {
          // Union both liminal web relationship lists (deduplicated)
          let linksA: string[] = [];
          let linksB: string[] = [];
          try {
            const contentA = await gitShowStage(tempDir, 2, 'liminal-web.json');
            if (contentA) linksA = (JSON.parse(contentA) as { relationships: string[] }).relationships || [];
          } catch { /* empty */ }
          try {
            const contentB = await gitShowStage(tempDir, 3, 'liminal-web.json');
            if (contentB) linksB = (JSON.parse(contentB) as { relationships: string[] }).relationships || [];
          } catch { /* empty */ }
          const unionLinks = [...new Set([...linksA, ...linksB])];
          fs.writeFileSync(
            path.join(tempDir, 'liminal-web.json'),
            JSON.stringify({ relationships: unionLinks }, null, 2),
            'utf-8'
          );
          await execAsync('git add -f liminal-web.json', { cwd: tempDir });
        } else {
          // Same-name files: keep A's version, rename B's with suffix
          const bContent = await gitShowStage(tempDir, 3, file);
          if (bContent) {
            const ext = path.extname(file);
            const base = file.slice(0, -ext.length || undefined);
            const bSuffix = sanitizeTitleToPascalCase(uddB.title);
            const renamedFile = `${base}_from_${bSuffix}${ext}`;
            fs.writeFileSync(path.join(tempDir, renamedFile), bContent, 'utf-8');
          }
          // Keep ours for the original filename
          await execAsync(`git checkout --ours "${file}"`, { cwd: tempDir });
          conflictFiles.push(file);
        }
      }
      // Stage everything
      await execAsync('git add -A', { cwd: tempDir });
    }

    await execAsync('git remote remove ancestor-b', { cwd: tempDir });

    // Always merge liminal-web.json from both sources (regardless of git conflict status).
    // Read from original nodes to get the authoritative lists, then write the union.
    {
      const linksA = await LiminalWebService.readLinks(nodeA.path);
      const linksB = await LiminalWebService.readLinks(nodeB.path);
      const unionLinks = [...new Set([...linksA, ...linksB])];
      if (unionLinks.length > 0) {
        fs.writeFileSync(
          path.join(tempDir, 'liminal-web.json'),
          JSON.stringify({ relationships: unionLinks }, null, 2),
          'utf-8'
        );
        await execAsync('git add -f liminal-web.json', { cwd: tempDir });
      }
    }

    // ========================================================================
    // Phase 4 — Set up identity
    // ========================================================================

    // Read raw .udd from both ancestors (preserves extra fields like email, DID, etc.)
    let rawA: Record<string, unknown> = {};
    let rawB: Record<string, unknown> = {};
    try {
      rawA = JSON.parse(fs.readFileSync(path.join(nodeA.path, '.udd'), 'utf-8'));
    } catch { /* empty */ }
    try {
      rawB = JSON.parse(fs.readFileSync(path.join(nodeB.path, '.udd'), 'utf-8'));
    } catch { /* empty */ }

    let finalUuid: string;
    let mergedUddRaw: Record<string, unknown>;

    if (isAbsorb) {
      // ---- Absorb: A keeps its identity, B dissolves ----
      finalUuid = nodeA.uuid;

      // Remove B's RID from A's submodule list (B is no longer a separate entity)
      const absorbedSubmodules = (uddA.submodules || []).filter(s => s !== uddB.radicleId);

      // A's supermodules stay the same; B's self-reference to A is irrelevant
      // B's supermodule references to OTHER nodes will be handled in Phase 6
      mergedUddRaw = {
        ...rawA,
        title: mergedName,
        type: mergedType,
        submodules: absorbedSubmodules,
        // Keep A's radicleId, dreamTalk, supermodules, uuid — no changes
      };

      // Update DreamSong.canvas self-references: submodulePath/X → X
      if (absorbInfo) {
        const canvasFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('.canvas'));
        for (const cf of canvasFiles) {
          const cfPath = path.join(tempDir, cf);
          let content = fs.readFileSync(cfPath, 'utf-8');
          const subPathPrefix = absorbInfo.subPath + '/';
          if (content.includes(subPathPrefix)) {
            content = content.split(subPathPrefix).join('');
            fs.writeFileSync(cfPath, content, 'utf-8');
          }
        }
      }
    } else {
      // ---- Standard merge: new entity C ----
      finalUuid = randomUUID();

      // Deduplicate submodules and supermodules from both ancestors
      const mergedSubmodules = deduplicateByRadicleId(uddA.submodules, uddB.submodules);
      const mergedSupermodules = deduplicateSupermodules(uddA.supermodules, uddB.supermodules);

      // Determine DreamTalk source
      const dreamtalkSource = args.dreamtalk_source || 'a';
      const primaryDreamTalk = dreamtalkSource === 'a' ? uddA.dreamTalk : uddB.dreamTalk;
      const secondaryDreamTalk = dreamtalkSource === 'a' ? uddB.dreamTalk : uddA.dreamTalk;

      // If both have DreamTalk and they're different, preserve the non-canonical one
      if (primaryDreamTalk && secondaryDreamTalk && primaryDreamTalk !== secondaryDreamTalk) {
        const secondarySource = dreamtalkSource === 'a' ? nodeB.path : nodeA.path;
        const secondaryFullPath = path.join(secondarySource, secondaryDreamTalk);
        if (fs.existsSync(secondaryFullPath)) {
          const ext = path.extname(secondaryDreamTalk);
          const base = secondaryDreamTalk.slice(0, -ext.length || undefined);
          const suffix = dreamtalkSource === 'a'
            ? sanitizeTitleToPascalCase(uddB.title)
            : sanitizeTitleToPascalCase(uddA.title);
          const renamedDreamTalk = `${base}_from_${suffix}${ext}`;
          const destPath = path.join(tempDir, renamedDreamTalk);
          // Only copy if not already present from the merge
          if (!fs.existsSync(destPath)) {
            fs.copyFileSync(secondaryFullPath, destPath);
          }
        }
      }

      mergedUddRaw = {
        ...rawB,
        ...rawA,
        // Canonical fields always overwrite
        uuid: finalUuid,
        title: mergedName,
        type: mergedType,
        dreamTalk: primaryDreamTalk || '',
        submodules: mergedSubmodules,
        supermodules: mergedSupermodules,
      };
      // Remove stale radicleId — Phase 5 sets the new one
      delete mergedUddRaw.radicleId;
    }

    fs.writeFileSync(path.join(tempDir, '.udd'), JSON.stringify(mergedUddRaw, null, 2), 'utf-8');

    // Write merge-ancestry.json
    const ancestry: MergeAncestryFile = {
      mergedAt: new Date().toISOString(),
      ancestors: [
        {
          uuid: nodeA.uuid,
          title: nodeA.title,
          radicleId: nodeA.radicleId || null,
          type: nodeA.type,
          lastKnownPath: nodeA.path,
          mergeRole: isAbsorb ? 'primary' : 'primary',
        },
        {
          uuid: nodeB.uuid,
          title: nodeB.title,
          radicleId: nodeB.radicleId || null,
          type: nodeB.type,
          lastKnownPath: nodeB.path,
          mergeRole: isAbsorb ? 'secondary' : 'secondary',
        },
      ],
      mergeCommit: '',
      mergedBy: 'auryn',
    };
    if (isAbsorb) {
      (ancestry as unknown as Record<string, unknown>).mergeType = 'absorb';
    }
    MergeAncestryService.write(tempDir, ancestry);

    // Birth certificate commit
    const commitMsg = isAbsorb
      ? `Absorb ${nodeB.title} into ${nodeA.title}`
      : `Merge DreamNodes: ${nodeA.title} + ${nodeB.title} → ${mergedName}`;
    await commitAllChanges(tempDir, commitMsg);

    // Capture merge commit hash and update ancestry
    const { stdout: mergeHash } = await execAsync('git rev-parse HEAD', { cwd: tempDir });
    ancestry.mergeCommit = mergeHash.trim();
    MergeAncestryService.write(tempDir, ancestry);
    await commitAllChanges(tempDir, 'Record merge commit hash in ancestry');

    // ========================================================================
    // Phase 5 — Radicle
    // ========================================================================
    let radicleId: string | null = null;
    let absorbedRadicleRemoved = false;

    if (isAbsorb) {
      // Absorb: A keeps its Radicle ID. Try to remove B's Radicle repo.
      radicleId = uddA.radicleId || null;

      if (uddB.radicleId) {
        try {
          await execAsync(`rad rm ${uddB.radicleId}`, { cwd: tempDir });
          absorbedRadicleRemoved = true;
        } catch {
          // Non-fatal — if B has peers/followers, rad rm may fail.
          // Ghost fork persists naturally in ~/.radicle/storage/
          ghostForks.push(uddB.radicleId);
        }
      }
    } else {
      // Standard merge: new Radicle repo for C
      radicleId = await initRadicle(tempDir, mergedDirName, `Merged DreamNode: ${mergedName}`);
      if (radicleId) {
        const uddRaw = JSON.parse(fs.readFileSync(path.join(tempDir, '.udd'), 'utf-8'));
        uddRaw.radicleId = radicleId;
        fs.writeFileSync(path.join(tempDir, '.udd'), JSON.stringify(uddRaw, null, 2), 'utf-8');
        await commitAllChanges(tempDir, 'Add Radicle ID to merged DreamNode');
      }

      // Track ghost forks for backpropagation
      if (nodeA.radicleId) ghostForks.push(nodeA.radicleId);
      if (nodeB.radicleId) ghostForks.push(nodeB.radicleId);
    }

    // ========================================================================
    // Phase 6 — Update cross-vault references
    // ========================================================================
    const allNodes = await discoverAllDreamNodes();
    const nodeADirName = path.basename(nodeA.path);
    const nodeBDirName = path.basename(nodeB.path);

    if (isAbsorb) {
      // ---- Absorb: only replace B's refs with A's (A survives unchanged) ----

      // 6a. Liminal web: replace B's UUID with A's UUID in all Dreamer nodes
      for (const node of allNodes) {
        if (node.type !== 'dreamer') continue;
        if (node.uuid === nodeA.uuid || node.uuid === nodeB.uuid) continue;

        const links = await LiminalWebService.readLinks(node.path);
        const hasB = links.includes(nodeB.uuid);

        if (hasB) {
          const newLinks = links.filter(uuid => uuid !== nodeB.uuid);
          // Only add A's UUID if not already present
          if (!newLinks.includes(nodeA.uuid)) {
            newLinks.push(nodeA.uuid);
          }
          await LiminalWebService.writeLinks(node.path, newLinks);
          try {
            await commitAllChanges(node.path, `Update liminal web: ${nodeB.title} absorbed into ${mergedName}`);
          } catch { /* nothing changed */ }
          refsUpdated.liminal_web++;
        }
      }

      // 6b. Submodule parents: nodes that import B as submodule → replace with A
      // (A importing B is already dissolved in Phase 2; this handles OTHER parents like ThePrinceOfEgypt)
      // Tracked here, actual submodule swap happens in Phase 7 after move.
      for (const node of allNodes) {
        if (node.uuid === nodeA.uuid || node.uuid === nodeB.uuid) continue;

        const bSubInNode = findSubmoduleByUrl(node.path, nodeB.path);
        if (bSubInNode) {
          refsUpdated.submodule_parents++;
        }
      }

      // 6c. DreamSong canvases: replace B's dir name with A's in other nodes
      for (const node of allNodes) {
        if (node.uuid === nodeA.uuid || node.uuid === nodeB.uuid) continue;

        const canvasPath = path.join(node.path, 'DreamSong.canvas');
        if (!fs.existsSync(canvasPath)) continue;

        let canvasContent = fs.readFileSync(canvasPath, 'utf-8');
        if (canvasContent.includes(nodeBDirName)) {
          canvasContent = canvasContent.split(nodeBDirName).join(nodeADirName);
          fs.writeFileSync(canvasPath, canvasContent, 'utf-8');
          try {
            await commitAllChanges(node.path, `Update DreamSong: ${nodeB.title} absorbed into ${mergedName}`);
          } catch { /* nothing changed */ }
          refsUpdated.dreamsong_canvases++;
        }
      }

      // 6d. Supermodule children: replace B's RID with A's RID in .udd.supermodules[]
      if (uddA.radicleId) {
        for (const node of allNodes) {
          if (node.uuid === nodeA.uuid || node.uuid === nodeB.uuid) continue;

          try {
            const udd = await UDDService.readUDD(node.path);
            let changed = false;
            const newSupermodules: (string | SupermoduleEntry)[] = [];

            for (const entry of udd.supermodules) {
              const entryRid = typeof entry === 'string' ? entry : entry.radicleId;
              if (uddB.radicleId && entryRid === uddB.radicleId) {
                // Replace B's entry with A's (if not already present)
                const aAlready = newSupermodules.some(e =>
                  (typeof e === 'string' ? e : e.radicleId) === uddA.radicleId
                );
                if (!aAlready) {
                  if (typeof entry === 'string') {
                    newSupermodules.push(uddA.radicleId);
                  } else {
                    newSupermodules.push({
                      ...entry,
                      radicleId: uddA.radicleId,
                      title: mergedName,
                    });
                  }
                }
                changed = true;
              } else {
                newSupermodules.push(entry);
              }
            }

            if (changed) {
              udd.supermodules = newSupermodules;
              await UDDService.writeUDD(node.path, udd);
              try {
                await commitAllChanges(node.path, `Update supermodule ref: ${nodeB.title} → ${mergedName}`);
              } catch { /* non-fatal */ }
              refsUpdated.supermodule_children++;
            }
          } catch { /* skip */ }
        }
      }
    } else {
      // ---- Standard merge: replace both A and B refs with C ----

      // 6a. Liminal web: replace A/B UUIDs with C's UUID in all Dreamer nodes
      for (const node of allNodes) {
        if (node.type !== 'dreamer') continue;
        if (node.uuid === nodeA.uuid || node.uuid === nodeB.uuid) continue;

        const links = await LiminalWebService.readLinks(node.path);
        const hasA = links.includes(nodeA.uuid);
        const hasB = links.includes(nodeB.uuid);

        if (hasA || hasB) {
          const newLinks = links.filter(uuid => uuid !== nodeA.uuid && uuid !== nodeB.uuid);
          if (!newLinks.includes(finalUuid)) {
            newLinks.push(finalUuid);
          }
          await LiminalWebService.writeLinks(node.path, newLinks);
          try {
            await commitAllChanges(node.path, `Update liminal web: ${nodeA.title}/${nodeB.title} → ${mergedName}`);
          } catch { /* nothing changed */ }
          refsUpdated.liminal_web++;
        }
      }

      // 6b. Submodule parents: find nodes that import A or B as submodules
      for (const node of allNodes) {
        if (node.uuid === nodeA.uuid || node.uuid === nodeB.uuid) continue;

        const gitmodulesPath = path.join(node.path, '.gitmodules');
        if (!fs.existsSync(gitmodulesPath)) continue;

        const gitmodulesContent = fs.readFileSync(gitmodulesPath, 'utf-8');
        const referencesA = gitmodulesContent.includes(nodeA.path);
        const referencesB = gitmodulesContent.includes(nodeB.path);

        if (!referencesA && !referencesB) continue;

        // Find submodule names that reference A or B
        const submoduleNames: string[] = [];
        const regex = /\[submodule "([^"]+)"\]\s*\n\s*path\s*=\s*([^\n]+)\n\s*url\s*=\s*([^\n]+)/g;
        let match;
        while ((match = regex.exec(gitmodulesContent)) !== null) {
          const name = match[1];
          const url = match[3].trim();
          if (url === nodeA.path || url === nodeB.path) {
            submoduleNames.push(name);
          }
        }

        // Remove old submodules and add the merged one
        for (const subName of submoduleNames) {
          try {
            await SubmoduleService.removeSubmodule(node.path, subName);
          } catch { /* non-fatal */ }
        }

        if (submoduleNames.length > 0) {
          refsUpdated.submodule_parents++;
        }
      }

      // 6c. DreamSong canvases: string-replace directory names
      for (const node of allNodes) {
        if (node.uuid === nodeA.uuid || node.uuid === nodeB.uuid) continue;

        const canvasPath = path.join(node.path, 'DreamSong.canvas');
        if (!fs.existsSync(canvasPath)) continue;

        let canvasContent = fs.readFileSync(canvasPath, 'utf-8');
        let changed = false;

        if (canvasContent.includes(nodeADirName)) {
          canvasContent = canvasContent.split(nodeADirName).join(mergedDirName);
          changed = true;
        }
        if (canvasContent.includes(nodeBDirName)) {
          canvasContent = canvasContent.split(nodeBDirName).join(mergedDirName);
          changed = true;
        }

        if (changed) {
          fs.writeFileSync(canvasPath, canvasContent, 'utf-8');
          try {
            await commitAllChanges(node.path, `Update DreamSong: references merged node ${mergedName}`);
          } catch { /* nothing changed */ }
          refsUpdated.dreamsong_canvases++;
        }
      }

      // 6d. Supermodule children: update .udd.supermodules[] replacing A/B Radicle IDs with C's
      if (radicleId) {
        for (const node of allNodes) {
          if (node.uuid === nodeA.uuid || node.uuid === nodeB.uuid) continue;

          try {
            const udd = await UDDService.readUDD(node.path);
            let changed = false;
            const newSupermodules: (string | SupermoduleEntry)[] = [];

            for (const entry of udd.supermodules) {
              if (typeof entry === 'string') {
                if ((nodeA.radicleId && entry === nodeA.radicleId) ||
                    (nodeB.radicleId && entry === nodeB.radicleId)) {
                  if (!newSupermodules.some(e => typeof e === 'string' ? e === radicleId : e.radicleId === radicleId)) {
                    newSupermodules.push(radicleId);
                  }
                  changed = true;
                } else {
                  newSupermodules.push(entry);
                }
              } else {
                if ((nodeA.radicleId && entry.radicleId === nodeA.radicleId) ||
                    (nodeB.radicleId && entry.radicleId === nodeB.radicleId)) {
                  if (!newSupermodules.some(e => typeof e === 'object' && 'radicleId' in e && e.radicleId === radicleId)) {
                    newSupermodules.push({
                      ...entry,
                      radicleId: radicleId,
                      title: mergedName,
                    });
                  }
                  changed = true;
                } else {
                  newSupermodules.push(entry);
                }
              }
            }

            if (changed) {
              udd.supermodules = newSupermodules;
              await UDDService.writeUDD(node.path, udd);
              try {
                await commitAllChanges(node.path, `Update supermodule ref: ${mergedName}`);
              } catch { /* non-fatal */ }
              refsUpdated.supermodule_children++;
            }
          } catch { /* skip */ }
        }
      }
    }

    // ========================================================================
    // Phase 7 — Clean up: filesystem moves and submodule re-wiring
    // ========================================================================

    if (isAbsorb) {
      // ---- Absorb: A is replaced by temp, B is deleted ----

      // Step 1: Replace A's directory with the merged temp
      fs.rmSync(nodeA.path, { recursive: true, force: true });
      fs.renameSync(tempDir, finalPath);

      // Step 2: Swap submodules in parents that had B → now reference A
      if (refsUpdated.submodule_parents > 0) {
        // Re-discover nodes (A is now at finalPath with merged content)
        const refreshedNodes = await discoverAllDreamNodes();
        for (const node of refreshedNodes) {
          if (node.uuid === nodeA.uuid || node.uuid === nodeB.uuid) continue;

          const bSubInNode = findSubmoduleByUrl(node.path, nodeB.path);
          if (!bSubInNode) continue;

          // Remove B's submodule
          try {
            await SubmoduleService.removeSubmodule(node.path, bSubInNode.subPath);
          } catch {
            // Non-fatal — try manual cleanup
            try {
              await execAsync(`git rm -f "${bSubInNode.subPath}"`, { cwd: node.path });
              await commitAllChanges(node.path, `Remove submodule: ${bSubInNode.subPath}`);
            } catch { /* last resort failed */ }
          }

          // Add A as submodule instead
          const subResult = await SubmoduleService.addSubmodule(
            node.path,
            finalPath,
            finalDirName
          );
          if (!subResult.success) {
            console.error(`Failed to add ${mergedName} as submodule to ${node.title}: ${subResult.error}`);
          }

          // Update .udd.submodules: replace B's RID with A's RID
          try {
            const udd = await UDDService.readUDD(node.path);
            udd.submodules = udd.submodules.filter(s => s !== uddB.radicleId);
            if (uddA.radicleId && !udd.submodules.includes(uddA.radicleId)) {
              udd.submodules.push(uddA.radicleId);
            }
            await UDDService.writeUDD(node.path, udd);
            await commitAllChanges(node.path, `Update .udd: ${nodeB.title} → ${mergedName} (absorb)`);
          } catch { /* non-fatal */ }
        }
      }

      // Step 3: Delete B's sovereign directory
      if (fs.existsSync(nodeB.path)) {
        fs.rmSync(nodeB.path, { recursive: true, force: true });
      }
    } else {
      // ---- Standard merge: remove A and B, move temp to final ----

      // Remove originals (DO NOT rad rm — ghost forks persist for backpropagation)
      fs.rmSync(nodeA.path, { recursive: true, force: true });
      fs.rmSync(nodeB.path, { recursive: true, force: true });

      // Move temp dir to final merged location
      fs.renameSync(tempDir, mergedPath);

      // Re-add submodules for parents that had A or B
      if (refsUpdated.submodule_parents > 0) {
        const finalNodes = await discoverAllDreamNodes();
        for (const node of finalNodes) {
          if (node.uuid === finalUuid) continue;
          try {
            const udd = await UDDService.readUDD(node.path);
            const hasOldSubRef = udd.submodules.some(s =>
              (nodeA.radicleId && s === nodeA.radicleId) ||
              (nodeB.radicleId && s === nodeB.radicleId)
            );
            if (hasOldSubRef) {
              udd.submodules = udd.submodules.filter(s =>
                s !== nodeA.radicleId && s !== nodeB.radicleId
              );
              if (radicleId && !udd.submodules.includes(radicleId)) {
                udd.submodules.push(radicleId);
              }
              await UDDService.writeUDD(node.path, udd);

              const subResult = await SubmoduleService.addSubmodule(
                node.path,
                mergedPath,
                mergedDirName
              );
              if (!subResult.success) {
                console.error(`Failed to re-add submodule to ${node.title}: ${subResult.error}`);
              }
            }
          } catch { /* skip */ }
        }
      }
    }

    // ========================================================================
    // Phase 8 — Return result
    // ========================================================================
    return {
      success: true,
      is_absorb: isAbsorb,
      merged_node: {
        uuid: finalUuid,
        title: mergedName,
        type: mergedType,
        path: finalPath,
        radicleId: radicleId || undefined,
      },
      ancestors: isAbsorb
        ? [
            { uuid: nodeA.uuid, title: nodeA.title, role: 'absorber' as const },
            { uuid: nodeB.uuid, title: nodeB.title, role: 'absorbed' as const },
          ]
        : [
            { uuid: nodeA.uuid, title: nodeA.title, role: 'primary' as const },
            { uuid: nodeB.uuid, title: nodeB.title, role: 'secondary' as const },
          ],
      had_conflicts: mergeHadConflicts || conflictFiles.length > 0,
      conflict_files: conflictFiles,
      references_updated: refsUpdated,
      ghost_forks_preserved: ghostForks,
      absorbed_radicle_removed: isAbsorb ? absorbedRadicleRemoved : undefined,
    };
  } catch (error) {
    // Attempt cleanup of temp dir if it exists
    const tempPattern = path.join(
      (await findDreamNode(args.node_a_identifier))?.vaultPath || '',
      '.merge-temp-*'
    );
    // Best-effort cleanup — don't let cleanup errors mask the real error
    try {
      const vaultPath = (await findDreamNode(args.node_a_identifier))?.vaultPath;
      if (vaultPath) {
        const entries = fs.readdirSync(vaultPath);
        for (const entry of entries) {
          if (entry.startsWith('.merge-temp-')) {
            fs.rmSync(path.join(vaultPath, entry), { recursive: true, force: true });
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }

    return {
      success: false,
      had_conflicts: false,
      conflict_files: [],
      references_updated: refsUpdated,
      ghost_forks_preserved: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Export tool definitions for MCP registration
 */
export const mergeTools = {
  merge_dreamnodes: {
    name: 'merge_dreamnodes',
    description: 'Merge two DreamNodes into one sovereign entity, preserving both git histories. Two modes: (1) Standard merge — A + B become new entity C with new UUID/Radicle. Ghost forks preserved for backpropagation. (2) Absorb merge — auto-detected when B is a submodule of A. A absorbs B: submodule dissolved, B\'s history merged in, A keeps its UUID and Radicle ID. B\'s sovereign directory deleted, B\'s Radicle repo removed. All cross-vault references updated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        node_a_identifier: {
          type: 'string',
          description: 'UUID or title of the primary ancestor (its history becomes mainline)',
        },
        node_b_identifier: {
          type: 'string',
          description: 'UUID or title of the secondary ancestor (merged into primary)',
        },
        merged_name: {
          type: 'string',
          description: 'Name for the merged DreamNode (defaults to A\'s title)',
        },
        merged_type: {
          type: 'string',
          enum: ['dream', 'dreamer'],
          description: 'Type of the merged DreamNode (defaults to A\'s type)',
        },
        dreamtalk_source: {
          type: 'string',
          enum: ['a', 'b'],
          description: 'Which ancestor\'s DreamTalk becomes canonical (default: a). The other is preserved with a suffix.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to confirm the merge. This is a destructive operation that removes both original nodes.',
        },
      },
      required: ['node_a_identifier', 'node_b_identifier', 'confirm'],
    },
    handler: mergeDreamNodes,
  },
};
