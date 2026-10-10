// 启动诊断：把启动过程与未捕获异常写入日志文件（打包后看不到控制台，靠它定位问题）
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOG = join(tmpdir(), 'shengxiao-boot.log');

export function boot(msg: string): void {
  try {
    mkdirSync(tmpdir(), { recursive: true });
    appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch {
    /* 日志写不进去也不能影响主流程 */
  }
}

boot('--- module loaded ---');

process.on('uncaughtException', (e) => boot(`uncaughtException: ${e?.stack ?? String(e)}`));
process.on('unhandledRejection', (e) => boot(`unhandledRejection: ${(e as Error)?.stack ?? String(e)}`));
