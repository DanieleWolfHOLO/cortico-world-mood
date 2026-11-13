/**
 * 从 src/definition.ts 生成 describe.json（扩展市场/控制台读的那份清单）。
 *
 * 用 Cortico 自己的 exportDescribe，定义是唯一来源 —— 不另抄一份 SUMMARY，
 * 否则加事件时漏写，check 会因为「describe.json 与代码不一致」判失败。
 *
 * exportDescribe 内部会做干装载：真的构造 World 并 start 一遍，所以这一步
 * 同时是第二级验证（check:extension 的前半）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/build-describe.mjs
 *   node --experimental-strip-types scripts/build-describe.mjs --check
 *
 * 注意：本 World 在 start() 里起了 setInterval，干装载之后必须强制退出，
 * 否则事件循环不会空。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { exportDescribe } from 'cortico/extensions/describe-export.ts';
import { MOOD } from '../src/definition.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'describe.json');
const check = process.argv.includes('--check');

// 干装载要一个临时部署目录；用完就删，不在包里留东西。
const scratchDir = mkdtempSync(join(tmpdir(), 'cortico-describe-mood-'));
let describe;
try {
  describe = await exportDescribe('world', MOOD, { packageDir: ROOT, scratchDir });
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}

if (!describe) {
  console.error('definition 没有 describe，无法生成自描述。');
  process.exit(1);
}

if (check) {
  let current;
  try {
    current = JSON.parse(readFileSync(OUT, 'utf8'));
  } catch (err) {
    console.error(`读不到 ${OUT}：${err.message}`);
    process.exit(1);
  }
  if (!isDeepStrictEqual(current, describe)) {
    console.error('describe.json 与源码不一致；跑一次不带 --check 的重写。');
    process.exit(1);
  }
  console.log(`describe.json 与源码一致：${describe.tools.length} 个工具，${describe.events.length} 个事件。`);
} else {
  writeFileSync(OUT, `${JSON.stringify(describe, null, 2)}\n`);
  console.log(
    `已写 describe.json：${describe.tools.length} 个工具，${describe.events.length} 个事件，${describe.prompts?.length ?? 0} 段提示词。`,
  );
}

// 干装载留下的定时器不归这里收，直接退出。
process.exit(0);
