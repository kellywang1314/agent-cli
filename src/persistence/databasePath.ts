import path from 'node:path';

/** 解析数据库路径，显式配置相对当前目录，默认使用 macOS 用户数据目录。 */
export function resolveDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = process.env.HOME ?? '',
  currentDirectory = process.cwd(),
): string {
  const configured = env.AGENT_CLI_DB_PATH?.trim();
  if (configured) return path.resolve(currentDirectory, configured);
  if (!homeDirectory) throw new Error('无法确定用户目录，请配置 AGENT_CLI_DB_PATH');
  return path.join(homeDirectory, 'Library', 'Application Support', 'agent-cli', 'agent.db');
}
