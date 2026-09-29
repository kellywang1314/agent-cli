import type { AgentTool } from '../types.js';
import { listFilesTool } from './listFiles.js';
import { readFileTool } from './readFile.js';
import { searchTool } from './search.js';
import { applyPatchTool } from './applyPatch.js';
import { runCommandTool } from './runCommand.js';
import { getDiffTool } from './getDiff.js';
import { generateImageTool } from './generateImage.js';

export { listFilesTool, readFileTool, searchTool, applyPatchTool, runCommandTool, getDiffTool, generateImageTool };

/** 按稳定顺序创建七种内置工具的注册列表。 */
export function createBuiltinTools(): AgentTool[] {
  return [listFilesTool, readFileTool, searchTool, applyPatchTool, runCommandTool, getDiffTool, generateImageTool];
}
