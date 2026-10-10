// 电脑状态采集：CPU / 内存 / 显存。全部异步，不阻塞主进程（避免界面卡顿）。
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { SystemMetrics } from '../shared/types';

let lastCpu = cpuTimes();
let gpuName: string | null = null;

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const value of Object.values(c.times)) total += value;
    idle += c.times.idle;
  }
  return { idle, total };
}

/** 查询 NVIDIA 显存（nvidia-smi 不在 PATH 时返回 null，界面自动隐藏显存一行） */
function queryGpu(): Promise<{ used: number; total: number; name: string } | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (val: { used: number; total: number; name: string } | null): void => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };
    try {
      const child = spawn('nvidia-smi', ['--query-gpu=memory.used,memory.total,name', '--format=csv,noheader,nounits'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.stdout?.on('data', (b: Buffer) => (out += b.toString()));
      child.on('error', () => finish(null));
      child.on('close', () => {
        const line = out.trim().split(/\r?\n/)[0] ?? '';
        const m = /^(\d+)\s*,\s*(\d+)\s*,\s*(.+)$/.exec(line);
        if (!m) return finish(null);
        finish({ used: Number(m[1]) / 1024, total: Number(m[2]) / 1024, name: m[3].trim() });
      });
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(null);
      }, 4000).unref?.();
    } catch {
      finish(null);
    }
  });
}

export async function collectMetrics(): Promise<SystemMetrics> {
  const now = cpuTimes();
  const idleDelta = now.idle - lastCpu.idle;
  const totalDelta = now.total - lastCpu.total;
  lastCpu = now;
  const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;

  const memTotalGB = os.totalmem() / 1024 ** 3;
  const memUsedGB = (os.totalmem() - os.freemem()) / 1024 ** 3;

  const gpu = await queryGpu();
  if (gpu) gpuName = gpu.name;

  return {
    ts: Date.now(),
    cpuPercent: Math.round(cpuPercent),
    memUsedGB: Math.round(memUsedGB * 10) / 10,
    memTotalGB: Math.round(memTotalGB * 10) / 10,
    gpuUsedGB: gpu ? Math.round(gpu.used * 10) / 10 : null,
    gpuTotalGB: gpu ? Math.round(gpu.total * 10) / 10 : null,
    gpuName,
  };
}
