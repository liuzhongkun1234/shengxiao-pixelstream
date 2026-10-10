// 项目与设置的 JSON 持久化（存于 Electron userData 目录）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, type Project, type Settings } from '../shared/types';
import { detectEngine } from './detect';

interface Persisted {
  projects: Project[];
  settings: Settings;
  /** 上次启动过的项目（用于「打开程序自动后台启动」） */
  lastProjectId?: string | null;
}

export class Store {
  private file: string;
  private data: Persisted;

  constructor(userDataDir: string) {
    mkdirSync(userDataDir, { recursive: true });
    this.file = join(userDataDir, 'config.json');
    this.data = this.load();
  }

  private load(): Persisted {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Persisted>;
        return {
          projects: Array.isArray(raw.projects) ? raw.projects : [],
          settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
          lastProjectId: typeof raw.lastProjectId === 'string' ? raw.lastProjectId : null,
        };
      }
    } catch {
      /* 配置损坏时回退默认 */
    }
    return { projects: [], settings: { ...DEFAULT_SETTINGS }, lastProjectId: null };
  }

  getLastProjectId(): string | null {
    const id = this.data.lastProjectId;
    if (!id) return null;
    return this.data.projects.some((p) => p.id === id) ? id : null;
  }

  setLastProjectId(id: string | null): void {
    this.data.lastProjectId = id;
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('save config failed:', e);
    }
  }

  listProjects(): Project[] {
    return [...this.data.projects].sort((a, b) => b.createdAt - a.createdAt);
  }

  getProject(id: string): Project | undefined {
    return this.data.projects.find((p) => p.id === id);
  }

  addProject(exePath: string): Project {
    const existing = this.data.projects.find((p) => p.exePath.toLowerCase() === exePath.toLowerCase());
    if (existing) return existing;
    const name = basenameSafe(exePath);
    const project: Project = {
      id: randomUUID(),
      name,
      exePath,
      engine: detectEngine(exePath),
      createdAt: Date.now(),
    };
    this.data.projects.push(project);
    this.save();
    return project;
  }

  removeProject(id: string): Project[] {
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    this.save();
    return this.listProjects();
  }

  updateProject(id: string, patch: Partial<Project>): Project[] {
    const p = this.getProject(id);
    if (p) {
      Object.assign(p, patch, { id: p.id });
      if (patch.exePath && patch.exePath !== p.exePath) {
        p.engine = detectEngine(patch.exePath);
      }
      this.save();
    }
    return this.listProjects();
  }

  getSettings(): Settings {
    return { ...this.data.settings };
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.getSettings();
  }
}

function basenameSafe(p: string): string {
  const parts = p.split(/[\\/]/);
  const last = parts[parts.length - 1] || p;
  return last.replace(/\.exe$/i, '') || '未命名项目';
}
