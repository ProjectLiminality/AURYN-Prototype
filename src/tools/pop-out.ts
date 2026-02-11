/**
 * Pop-Out to Sovereign MCP Tool
 *
 * Promotes a local file inside a DreamNode to its own sovereign DreamNode.
 * The file is moved to the new DreamNode, which is then imported back as a submodule.
 * DreamSong references are updated to point into the submodule.
 *
 * This is how knowledge gardens grow — not in size, but in interconnectedness.
 */

import { DreamNodeService, SubmoduleService, UDDService, DEFAULT_VAULT_PATH, commitAllChanges } from '../services/standalone-adapter.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';

const execAsync = promisify(exec);

/**
 * Tool: pop_out_to_sovereign
 * Promote a local file to its own sovereign DreamNode with submodule replacement
 */
export async function popOutToSovereign(args: {
  parent_identifier: string;
  file_path: string;
  dreamnode_name: string;
  dreamnode_type?: 'dream' | 'dreamer';
  context_branch?: boolean;
}): Promise<{
  success: boolean;
  sovereign_node?: {
    uuid: string;
    title: string;
    path: string;
    radicleId?: string;
  };
  submodule_name?: string;
  context_branch_name?: string;
  dreamsong_updated?: boolean;
  error?: string;
}> {
  try {
    // 1. Find the parent DreamNode
    const parent = await DreamNodeService.getDreamNode(args.parent_identifier);
    if (!parent) {
      return {
        success: false,
        error: `Parent DreamNode not found: ${args.parent_identifier}`
      };
    }

    // 2. Resolve and validate the file path
    // file_path can be relative to the parent DreamNode or absolute
    const absoluteFilePath = path.isAbsolute(args.file_path)
      ? args.file_path
      : path.join(parent.path, args.file_path);

    if (!fsSync.existsSync(absoluteFilePath)) {
      return {
        success: false,
        error: `File not found: ${absoluteFilePath}`
      };
    }

    const fileName = path.basename(absoluteFilePath);
    const fileRelativeToParent = path.relative(parent.path, absoluteFilePath);

    // 3. Check that the file is directly inside the parent (not in a submodule)
    if (fileRelativeToParent.startsWith('..')) {
      return {
        success: false,
        error: `File is not inside the parent DreamNode: ${absoluteFilePath}`
      };
    }

    // 4. Create the sovereign DreamNode at vault root
    const nodeType = args.dreamnode_type || 'dream';
    const newNode = await DreamNodeService.createDreamNode(
      parent.vaultPath,
      args.dreamnode_name,
      nodeType
    );

    // 5. Move the file into the new DreamNode
    const destPath = path.join(newNode.path, fileName);
    await fs.copyFile(absoluteFilePath, destPath);

    // 6. Update the new DreamNode's .udd with dreamTalk
    const udd = await UDDService.readUDD(newNode.path);
    udd.dreamTalk = fileName;
    await UDDService.writeUDD(newNode.path, udd);

    // 7. Commit the file addition to the sovereign DreamNode
    await commitAllChanges(newNode.path, `Add ${fileName} as DreamTalk from pop-out`);

    // 8. Remove the original file from the parent (git rm)
    try {
      await execAsync(`git rm -f "${fileRelativeToParent}"`, { cwd: parent.path });
    } catch {
      // If git rm fails (file might not be tracked), just delete it
      await fs.unlink(absoluteFilePath);
    }

    // 9. Commit the removal before adding submodule
    try {
      await commitAllChanges(parent.path, `Remove ${fileName} (popping out to sovereign DreamNode)`);
    } catch {
      // May fail if nothing to commit (git rm already staged)
    }

    // 10. Add the new DreamNode as a submodule of the parent
    const submoduleName = args.dreamnode_name;
    const subResult = await SubmoduleService.addSubmodule(
      parent.path,
      newNode.path,
      submoduleName
    );

    if (!subResult.success) {
      return {
        success: false,
        error: `Failed to add submodule: ${subResult.error}. Sovereign DreamNode was created at ${newNode.path} but not linked.`
      };
    }

    // 11. Update DreamSong.canvas if it exists
    let dreamsongUpdated = false;
    const canvasPath = path.join(parent.path, 'DreamSong.canvas');
    if (fsSync.existsSync(canvasPath)) {
      const canvasContent = await fs.readFile(canvasPath, 'utf-8');

      // The DreamSong references files relative to the vault, not the DreamNode
      // e.g., "SpringLaunch/Website.png" needs to become "SpringLaunch/Website/Website.png"
      const parentDirName = path.basename(parent.path);
      const oldRef = `${parentDirName}/${fileRelativeToParent}`;
      const newRef = `${parentDirName}/${submoduleName}/${fileName}`;

      if (canvasContent.includes(oldRef)) {
        const updatedCanvas = canvasContent.split(oldRef).join(newRef);
        await fs.writeFile(canvasPath, updatedCanvas, 'utf-8');
        dreamsongUpdated = true;
        await commitAllChanges(parent.path, `Update DreamSong: ${fileName} now references submodule`);
      }
    }

    // 12. Create context branch in the submodule clone if requested
    let contextBranchName: string | undefined;
    const createBranch = args.context_branch !== false; // default true
    if (createBranch) {
      const submodulePath = path.join(parent.path, submoduleName);
      // Derive branch name from parent title, kebab-case
      contextBranchName = parent.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      try {
        await execAsync(`git checkout -b "${contextBranchName}"`, { cwd: submodulePath });
        // Commit the submodule to parent at this new branch
        await commitAllChanges(parent.path, `Set submodule ${submoduleName} to context branch: ${contextBranchName}`);
      } catch (branchError) {
        // Non-fatal — branch creation is a convenience
        contextBranchName = undefined;
        console.error('Context branch creation failed (non-fatal):', branchError);
      }
    }

    return {
      success: true,
      sovereign_node: {
        uuid: newNode.uuid,
        title: newNode.title,
        path: newNode.path,
        radicleId: newNode.radicleId
      },
      submodule_name: submoduleName,
      context_branch_name: contextBranchName,
      dreamsong_updated: dreamsongUpdated
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
export const popOutTools = {
  pop_out_to_sovereign: {
    name: 'pop_out_to_sovereign',
    description: 'Promote a local file inside a DreamNode to its own sovereign DreamNode. The file becomes the new DreamNode\'s DreamTalk, the original is replaced by a submodule import, and DreamSong references are updated. Creates a context branch in the submodule clone by default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        parent_identifier: {
          type: 'string',
          description: 'UUID or title of the parent DreamNode containing the file'
        },
        file_path: {
          type: 'string',
          description: 'Path to the file to pop out (relative to parent DreamNode, or absolute)'
        },
        dreamnode_name: {
          type: 'string',
          description: 'Name/title for the new sovereign DreamNode'
        },
        dreamnode_type: {
          type: 'string',
          enum: ['dream', 'dreamer'],
          description: 'Type of DreamNode (default: dream)'
        },
        context_branch: {
          type: 'boolean',
          description: 'Create a context branch in the submodule clone named after the parent (default: true)'
        }
      },
      required: ['parent_identifier', 'file_path', 'dreamnode_name']
    },
    handler: popOutToSovereign
  }
};
