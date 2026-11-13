// 手工验证脚本。不依赖 cortico，只测 config.ts 里的纯函数与增量数学。
// 跑法：node --experimental-strip-types test/manual.mjs
// 目的：在没有 pnpm / typecheck 的机器上，至少把能验的部分验掉。

const m = await import('../src/config.ts');
const { scene, STEP, W, W_MAX, clamp01, cleanState, cleanSection, DEFAULTS } = m;

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failed += 1;
};

// ---------------------------------------------------------------- 1. 三通道分离
console.log('\n[1] 三个维度各有独立出口');
const base = scene(0.5, 0.5, 0.5);
const fields = ['bearing', 'air', 'distance'];
for (const [i, dim] of ['A', 'T', 'C'].entries()) {
  let otherSame = true;
  for (const v of [0.02, 0.5, 0.98]) {
    const args = [0.5, 0.5, 0.5];
    args[i] = v;
    const s = scene(...args);
    fields.forEach((f, j) => {
      if (j !== i && s[f] !== base[f]) otherSame = false;
    });
  }
  check(`${dim} 只影响 ${fields[i]}，不影响另外两个`, otherSame);
}
const low = scene(0.05, 0.05, 0.05);
const high = scene(0.95, 0.95, 0.95);
check('三个维度都在动时三格全变', fields.every((f) => low[f] !== high[f]));
check('情境文本零数字泄漏', !/[0-9]/.test(JSON.stringify([low, high, base])));

// ---------------------------------------------------------------- 2. 增量数学
console.log('\n[2] 权重 + 归一化增量');
const apply = (v, dir, w) => {
  if (dir === 0) return v;
  const room = dir > 0 ? 1 - v : v;
  return clamp01(v + dir * STEP * (Math.min(w, W_MAX) / W_MAX) * room);
};

let t = 0.2;
const seq = [];
for (let i = 0; i < 8; i += 1) {
  const next = apply(t, 1, W.failure);
  seq.push(next - t);
  t = next;
}
check('连续上升永不越过 1', t <= 1 && t > 0.9, `8 次失败后 T=${t.toFixed(4)}`);
check('增量单调递减（饱和）', seq.every((d, i) => i === 0 || d < seq[i - 1]),
  `首 ${seq[0].toFixed(4)} → 末 ${seq[7].toFixed(5)}`);

let a = 0.4;
for (let i = 0; i < 20; i += 1) a = apply(a, -1, W.turnEnd);
check('连续下降永不越过 0', a >= 0 && a < 0.01, `20 次回收后 A=${a.toFixed(6)}`);

const ratio = (v, w) => apply(v, 1, w) - v;
const r3 = ratio(0.2, W.failure);
const r1 = ratio(0.2, W.modelStart);
check('权重 3:1 的幅度比是 3:1', Math.abs(r3 / r1 - 3) < 1e-9,
  `${r3.toFixed(4)} / ${r1.toFixed(4)} = ${(r3 / r1).toFixed(3)}`);
check('权重超过 W_MAX 时被夹住', apply(0.2, 1, 99) === apply(0.2, 1, W_MAX));

// ---------------------------------------------------------------- 3. 兼容与容错
console.log('\n[3] 存档兼容与容错');
const v1 = {
  A: 0.55, T: 0.7, C: 0.3,
  updatedAt: '2026-11-12T03:00:00.000Z',
  trace: [{
    at: '2026-11-12T03:00:00.000Z',
    reason: '模型调用失败，进入退避等待',
    d: { A: 0, T: 0.3, C: 0 },
    after: { A: 0.55, T: 0.7, C: 0.3 },
  }],
};
const c1 = cleanState(v1);
check('v1 存档缺 w 时补成 1', c1.trace[0].w === 1);
check('v1 存档缺 lastActiveAt 时回落到 updatedAt',
  c1.lastActiveAt === v1.updatedAt, c1.lastActiveAt);

const broken = cleanState({ A: 'x', T: null, updatedAt: 'nope', trace: 'bad' });
check('坏存档回落默认值', broken.A === 0.3 && broken.T === 0.2 && broken.C === 0.4);
check('坏存档 trace 归零', Array.isArray(broken.trace) && broken.trace.length === 0);

const sec = cleanSection({ halfLifeA: -5, halfLifeT: 0, noticeAt: 9, maxTrace: 1, nudgeBaseMs: 1 });
check('负数半衰期回落默认', sec.halfLifeA === DEFAULTS.halfLifeA && sec.halfLifeT === DEFAULTS.halfLifeT);
check('noticeAt 夹到 1', sec.noticeAt === 1);
check('maxTrace 下限 4', sec.maxTrace === 4);
check('nudgeBaseMs 下限 60s', sec.nudgeBaseMs === 60000);

// ---------------------------------------------------------------- 4. nudge 间隔
console.log('\n[4] 主动开口间隔只由 C 决定');
const gap = (C, cfg = DEFAULTS) => Math.max(cfg.nudgeFloorMs, cfg.nudgeBaseMs / (0.25 + C));
const min = (ms) => `${(ms / 60000).toFixed(1)} 分钟`;
for (const C of [0, 0.2, 0.5, 0.8, 1]) {
  console.log(`    C=${C.toFixed(1)} → ${min(gap(C))}`);
}
check('C 越高间隔越短', gap(1) < gap(0.5) && gap(0.5) < gap(0));
check('间隔不低于 floor', gap(1) >= DEFAULTS.nudgeFloorMs);

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
