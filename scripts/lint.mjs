// lint.mjs —— 零依赖 lint：对 src/scripts/test 下每个 JS 文件跑 node --check
// （语法检查，ESM 感知；不执行代码）。约定：src 下逻辑模块不依赖 DOM 即可被
// node --test 直接单测，语法层是最低守卫。
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dirs = ["src", "scripts", "test"];
const files = [];
for (const d of dirs) {
  let names = [];
  try {
    names = readdirSync(d);
  } catch {
    continue; // 目录不存在则跳过
  }
  for (const f of names) {
    const p = join(d, f);
    if (/\.(js|mjs)$/.test(f) && statSync(p).isFile()) files.push(p);
  }
}

let fail = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`lint FAIL: ${f}`);
    fail++;
  }
}
console.log(fail ? `lint: ${fail}/${files.length} 个文件失败` : `lint: ${files.length} 个文件全部通过`);
process.exit(fail ? 1 : 0);
