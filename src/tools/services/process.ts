import { spawn } from 'node:child_process';

export interface ProcessResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
}

/** 构造子进程环境，移除模型、Redis 凭据及可重定向 Git 的环境项。 */
export function createChildEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(
    ([key]) => !/^(AIDP|OPENAI|REDIS|GIT_)/i.test(key),
  ));
}

/** 启动独立进程组，限制输出和时间并在取消时杀死整个进程组。 */
export async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs = 30_000,
  env: NodeJS.ProcessEnv = createChildEnv(),
): Promise<ProcessResult> {
  signal.throwIfAborted();
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let processError: Error | undefined;
    /** 终止进程组，确保后台子进程不会继续运行。 */
    const killGroup = (): void => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
      }
    };
    /** 缓存有限输出，超限后继续排空管道以避免阻塞。 */
    const collect = (chunk: Buffer): void => {
      const remaining = 65536 - byteCount;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        byteCount += kept.length;
      }
    };
    /** 中断时立即停止全部子进程。 */
    const onAbort = (): void => { killGroup(); };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, Math.min(timeoutMs, 60_000));
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => { processError = error; });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) { reject(signal.reason); return; }
      if (processError) { reject(processError); return; }
      let output = new TextDecoder().decode(Buffer.concat(chunks), { stream: truncated });
      // 替换字符可能增加字节数；重新编码并丢弃边界上的残缺码点，保持线性复杂度。
      const encoded = Buffer.from(output);
      if (encoded.length > 65536) {
        output = new TextDecoder().decode(encoded.subarray(0, 65536), { stream: true });
        truncated = true;
      }
      resolve({ exitCode, output, timedOut, truncated });
    });
    if (signal.aborted) onAbort();
  });
}
