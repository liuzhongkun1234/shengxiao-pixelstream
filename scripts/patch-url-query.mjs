import fs from 'fs';
const a = '    engineUrl.search = `token=${encodeURIComponent(this.config.engineToken || "")}`;';
const b = [
  '    engineUrl.searchParams.set("token", this.config.engineToken || "");',
  '    engineUrl.searchParams.set("project", request.projectId);',
  '    engineUrl.searchParams.set("instance", request.instanceId);',
].join('\n');
for (const p of [
  'F:/shuzhiLuanShengHouDuan/xiangShuLiu/vendor/server/src/execue/process-manager.js',
  'C:/Users/Administrator/AppData/Roaming/圣效像素流/server/src/execue/process-manager.js',
]) {
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('searchParams.set("project"')) {
    console.log('already', p);
    continue;
  }
  if (!s.includes(a)) {
    console.log('NOT FOUND', p);
    continue;
  }
  s = s.replace(a, b);
  fs.writeFileSync(p, s);
  console.log('patched', p);
}
