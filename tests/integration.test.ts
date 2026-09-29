import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { AgentLoop } from '../src/agent/AgentLoop.js';
import { loadConfig } from '../src/config/loadConfig.js';
import { AidpProvider } from '../src/providers/AidpProvider.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import type { PermissionRequest } from '../src/tools/types.js';

it('本地 HTTP 网关贯通真实读取、补丁确认、Shell 执行与最终回答', async () => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-integration-')));
  const requests: Record<string, unknown>[] = [];
  const approvals: PermissionRequest[] = [];
  const calls = [
    { name: 'readFile', arguments: JSON.stringify({ path: 'note.txt' }) },
    { name: 'applyPatch', arguments: JSON.stringify({ patch: '--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-old\n+new\n' }) },
    { name: 'runCommand', arguments: JSON.stringify({ command: 'cat note.txt' }) },
  ];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const index = requests.length - 1;
    const call = calls[index];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = call
      ? { tool_calls: [{ index: 0, id: `tool-${index}`, type: 'function', function: call }] }
      : { content: '修改和检查已完成' };
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  try {
    await writeFile(path.join(workspace, 'note.txt'), 'old\n');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无端口');
    const provider = new AidpProvider(loadConfig({ apiKey: 'test-key', chatUrl: `http://127.0.0.1:${address.port}/chat` }, {}));
    const agent = new AgentLoop(provider, new ToolRegistry(), { systemPrompt: 'test', maxRounds: 5 });
    const result = await agent.run('把 old 改为 new 并检查', {
      workspace, provider, signal: new AbortController().signal,
      /** 测试收集每次真实副作用前的确认请求。 */
      confirm: async (request) => { approvals.push(request); return true; },
    });
    expect(result).toBe('修改和检查已完成');
    expect(await readFile(path.join(workspace, 'note.txt'), 'utf8')).toBe('new\n');
    expect(approvals.map((request) => request.title)).toEqual(['应用补丁：note.txt', '执行 Shell 命令']);
    expect(requests).toHaveLength(4);
    expect(requests[0].tools).toHaveLength(7);
    expect(JSON.stringify(requests[3].messages)).toContain('new\\\\n');
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
