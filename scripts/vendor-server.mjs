// 一次性脚本：把内置服务器源码收进项目 vendor/server（配置脱敏为模板）
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'D:\\UEXiangMuShangHaiRuiNian\\UEPixelStreamingManager-6.1.0-beta.154-win-x64\\PeerStreamSource';
const DEST = process.argv[2];

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

// 只收必需部分：源码、前端、配置、包描述、依赖（ws）
for (const item of ['src', 'public', 'package.json', 'node_modules']) {
  cpSync(join(SRC, item), join(DEST, item), { recursive: true });
}
for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md']) {
  if (existsSync(join(SRC, f))) cpSync(join(SRC, f), join(DEST, f));
}

// 配置：清空项目与白名单（由启动器在运行时按用户选择的 exe 自动登记）
mkdirSync(join(DEST, 'config'), { recursive: true });
const signal = JSON.parse(readFileSync(join(SRC, 'config', 'signal.json'), 'utf8'));
signal.projects = [];
signal.session = { ...(signal.session ?? {}), lastPlayerExitPolicy: 'idle', idleInstanceSeconds: 1800 };
// 保留 STUN/TURN 原值：启动器按「局域网模式」决定是否清空
writeFileSync(join(DEST, 'config', 'signal.json'), JSON.stringify(signal, null, 2), 'utf8');

const execue = JSON.parse(readFileSync(join(SRC, 'config', 'execue.json'), 'utf8'));
execue.allowedProjects = [];
writeFileSync(join(DEST, 'config', 'execue.json'), JSON.stringify(execue, null, 2), 'utf8');

console.log('vendor/server ready ->', DEST);
