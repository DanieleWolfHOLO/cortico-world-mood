// 场景模拟：把「某个情境 → 三个值 → 她读到什么」这条链摊开。
//
// 这不是测试，是给人看的。真模型会不会按情境调 mood_touch，测不出来；
// 但值变成什么话、一次刺激会持续多久、反复哄有没有递减，这些是确定的算式，能算准。
//
// 跑法：node --import tsx test/scenario.mjs

const { scene, DEFAULTS } = await import('../src/config.ts');

const B = { A: DEFAULTS.baselineA, T: DEFAULTS.baselineT, C: DEFAULTS.baselineC };
const CAP = DEFAULTS.touchLimit;

/** 和 world.ts 里完全一致的 touch 数学：带剩余空间因子，所以有递减。 */
const nudge = (v, d) => {
  if (d === 0) return v;
  const room = d > 0 ? 1 - v : v;
  return Math.min(1, Math.max(0, v + d * room));
};

const pad = (s, n) => {
  let w = 0;
  for (const ch of s) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
};

const show = (label, A, T, C) => {
  const s = scene(A, T, C);
  console.log(
    '  ' + pad(label, 22)
    + '│ ' + pad(s.bearing, 34)
    + '│ ' + pad(s.air, 26)
    + '│ ' + s.distance,
  );
};

const minutesTo = (from, base, to, halfLife) => {
  const ratio = (to - base) / (from - base);
  if (!(ratio > 0) || ratio >= 1) return 0;
  return halfLife * (Math.log(ratio) / Math.log(0.5));
};

console.log('\n  情境                  │ 举止（只看劲头）                   │ 空气（只看绷紧）          │ 距离（只看黏人）');
console.log('  ' + '─'.repeat(22) + '┼' + '─'.repeat(36) + '┼' + '─'.repeat(28) + '┼' + '─'.repeat(14));

console.log('\n[一] 基线：什么都没发生');
show('基线', B.A, B.T, B.C);

console.log(`\n[二] 被凶（每次 mood_touch 上限 ${CAP}，乘剩余空间后递减）`);
{
  let t = B.T;
  for (let i = 1; i <= 4; i += 1) {
    const next = nudge(t, CAP);
    show(`被凶 ${i} 次后 (T=${next.toFixed(2)})`, B.A, next, B.C);
    t = next;
  }
}

console.log('\n[三] 被凶四次之后，时间过去（回基线 0.2，半衰期 20 分钟）');
{
  let t = B.T;
  for (let i = 0; i < 4; i += 1) t = nudge(t, CAP);
  for (const min of [0, 10, 20, 30, 60]) {
    const v = B.T + (t - B.T) * Math.pow(0.5, min / DEFAULTS.halfLifeT);
    show(`过后 ${String(min).padStart(2)} 分钟`, B.A, v, B.C);
  }
}

console.log('\n[四] 反复安慰：这就是你问的「galgame 式」');
{
  const TIGHT = 0.30;
  let t = B.T;
  for (let i = 0; i < 3; i += 1) t = nudge(t, CAP);
  const start = t;
  console.log(`  被凶三次后 T=${start.toFixed(3)}。下面每次都是「哄她一次」：`);
  console.log('');
  for (let i = 1; i <= 6; i += 1) {
    const next = nudge(t, -CAP);
    const drop = t - next;
    const mark = next > TIGHT ? '（还是「绷得很紧」）' : '（已经降到「有点沉」）';
    console.log(`    第 ${i} 次安慰 → ${next.toFixed(3)}　这次降 ${drop.toFixed(3)} ${mark}`);
    t = next;
  }
  console.log('');
  console.log('  → 每次降得越来越少：哄一次很明显，哄到后来几乎不动。');
  console.log('  → 但注意：她会不会真的每次都用 mood_touch，取决于模型判断，不在这张表里。');
}

console.log('\n[五] 被夸：黏人往上（同样递减）');
{
  let c = B.C;
  for (let i = 1; i <= 4; i += 1) {
    const next = nudge(c, CAP);
    show(`被夸 ${i} 次后 (C=${next.toFixed(2)})`, B.A, B.T, next);
    c = next;
  }
}

console.log('\n[六] 黏人 → 主动开口间隔（只由 C 决定，A/T 不参与）');
{
  const gap = (C) => Math.max(DEFAULTS.nudgeFloorMs, DEFAULTS.nudgeBaseMs / (0.25 + C));
  for (const C of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const g = gap(C) / 60000;
    const mark = Math.abs(C - B.C) < 1e-9 ? '  ← 基线' : '';
    console.log(`  黏人 ${C.toFixed(1)} → ${g.toFixed(1)} 分钟${mark}`);
  }
}

console.log('\n[七] 劲头只影响「举止」这一格');
  for (const A of [0.15, 0.3, 0.6, 0.9]) {
  const s = scene(A, B.T, B.C);
  console.log(`  劲头 ${A.toFixed(2)} → 「${s.bearing}」`);
}

console.log('\n[八] 串味：被她记着多久');
{
  const TIGHT = 0.30;
  let once = nudge(B.T, CAP);
  let thrice = B.T;
  for (let i = 0; i < 3; i += 1) thrice = nudge(thrice, CAP);
  console.log(`  被凶 1 次（T=${once.toFixed(2)}）→ 降到「有点沉」要 ${minutesTo(once, B.T, TIGHT, DEFAULTS.halfLifeT).toFixed(0)} 分钟`);
  console.log(`  被凶 3 次（T=${thrice.toFixed(2)}）→ 降到「有点沉」要 ${minutesTo(thrice, B.T, TIGHT, DEFAULTS.halfLifeT).toFixed(0)} 分钟`);
  console.log('  嫌长就调小 halfLifeT（配置项，不改代码）');
}

console.log('\n[九] 结论');
console.log('  · 三个值互不干扰：动一个，另外两格逐字不变');
console.log('  · 唯一影响行为的通道是黏人（改主动开口间隔）');
console.log('  · 绷紧/劲头只改描述，不触发任何动作');
console.log('  · 阈值围绕基线铺开，调一次就跨一档 —— 有反应，但不会一下到底');
console.log('  · 反复哄有递减：这是 room 因子带来的，不是特判');
console.log(`  · 衰减最低只到基线 ${B.T}：更低那档只能靠她自己调低`);
