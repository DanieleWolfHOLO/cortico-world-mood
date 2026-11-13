// 集成测试：不经过 GUI，用假宿主把 MoodWorld 的钩子真跑一遍。
//
// 覆盖那些只能在运行时验证的东西：onRunPhase 的分支、pushEvent 的 deliver 标志、
// onTurnEnded 的回收、busy 判定、touch 上限、nudge 的触发条件。
//
// 跑法：node --import tsx test/integration.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { MoodWorld } = await import('../src/world.ts');
const { DEFAULTS, scene } = await import('../src/config.ts');

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failed += 1;
};

// ---------------------------------------------------------------- 假宿主
const pushed = [];
const host = {
  pushEvent: async (e, opts) => {
    pushed.push({ event: e, opts: opts ?? {} });
    return { ...e, cursor: pushed.length, origin: 'external' };
  },
  store: {},
  modelFacts: {},
  blob: () => null,
  reportUsage: () => {},
  drainPendingEvents: async () => [],
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
};

const dir = mkdtempSync(join(tmpdir(), 'mood-it-'));
const mk = () => new MoodWorld({ dataDir: dir, cfg: { ...DEFAULTS, enabled: true } });

const phase = (state, running = []) => ({
  state, running, enteredAt: new Date().toISOString(),
});

try {
  // ============================================================ 1. 失败分支
  console.log('\n[1] onRunPhase → backoff（档 2 的核心）');
  const w = mk();
  await w.start(host);
  const t0 = w.state.T;
  pushed.length = 0;

  w.onRunPhase(phase('backoff'));

  check('绷紧(T) 被推高', w.state.T > t0, `${t0.toFixed(3)} → ${w.state.T.toFixed(3)}`);
  const backoffEvent = pushed.find((p) => p.event.type === 'mood.shift');
  check('产生了 mood.shift 事件', !!backoffEvent);
  check('**事件是 deliver:false**（永不投递）', backoffEvent?.opts?.deliver === false,
    JSON.stringify(backoffEvent?.opts));
  check('正文为空字符串（数值不经正文泄漏）', backoffEvent?.event?.text === '');
  check('数值在 meta 里', !!backoffEvent?.event?.meta?.after);
  check('权重是 3（失败最重）', backoffEvent?.event?.meta?.w === 3);
  check('trace 记下了原因',
    w.state.trace.some((s) => s.reason.includes('模型调用失败')),
    w.state.trace.at(-1)?.reason);

  // ============================================================ 2. 其它分支
  console.log('\n[2] onRunPhase → model / tools，以及 busy 判定');
  await w.stop();
  const w2 = mk();
  await w2.start(host);
  const a0 = w2.state.A;

  w2.onRunPhase(phase('model'));
  // 有意如此：开始生成不是情绪事件，不再推劲头（否则一说话她就兴奋）。
  check('model → 劲头(A) 不变（开始生成不是情绪事件）',
    Math.abs(w2.state.A - a0) < 1e-9, `${a0.toFixed(3)} → ${w2.state.A.toFixed(3)}`);
  check('model 时 busy 为 true', w2.busy === true);

  w2.onRunPhase(phase('tools', ['mood_peek']));
  check('tools 时 busy 为 true', w2.busy === true);

  w2.onRunPhase(phase('idle'));
  check('idle 时 busy 为 false（只有完全空闲才允许插话）', w2.busy === false);

  w2.onRunPhase(phase('delivering'));
  check('delivering 时 busy 为 true（旧版这里会误判成空闲）', w2.busy === true);

  // ============================================================ 3. 一轮结束
  // 注意：这是 Daniele 报的现象修完之后的行为 —— 一轮结束**不压**劲头和绷紧，
  // 只补一点相处。A/T 交给衰减回基线。压了会超调，越聊越没劲。
  console.log('\n[3] onTurnEnded 只补相处，不压劲头/绷紧');
  await w2.stop();
  const w3 = mk();
  await w3.start(host);
  w3.state.A = 0.6;
  w3.state.T = 0.5;
  w3.state.C = 0.4;
  w3.onTurnEnded();
  check('劲头不被额外压', w3.state.A >= 0.6 - 0.01, `0.600 → ${w3.state.A.toFixed(3)}`);
  check('绷紧不被额外压', w3.state.T >= 0.5 - 0.01, `0.500 → ${w3.state.T.toFixed(3)}`);
  check('黏人上升（相处修复）', w3.state.C > 0.4, `0.400 → ${w3.state.C.toFixed(3)}`);

  // ============================================================ 4. touch 上限
  console.log('\n[4] mood_touch 的上限');
  await w3.stop();
  const w4 = mk();
  await w4.start(host);
  w4.state.C = 0.5;
  const r = w4.touch({ C: 5, reason: '测试上限' });
  // 容差 1e-3 而不是 1e-9：touch 开头会先 decay()，几毫秒的经过时间让起点略低于 0.5。
  check('单次增量受剩余空间约束（0.5 处 ±0.30 的 room 后约 0.15）', Math.abs(w4.state.C - 0.65) < 1e-3,
    `0.5 → ${w4.state.C.toFixed(4)}（期望 ≈0.650）`);
  check('回执里报了新值', typeof r.text === 'string' && r.text.includes('0.65'), r.text);

  // ============================================================ 5. nudge（伪造时间）
  console.log('\n[5] nudge 的触发条件（C 的独立通道）');
  await w4.stop();
  pushed.length = 0;
  const w5 = mk();
  await w5.start(host);

  // 刚启动、刚活动过 → 不该推
  w5.busy = false;
  w5.tick();
  check('刚启动不推', pushed.every((p) => p.event.type !== 'mood.nudge'));

  // 伪造：5 分钟没活动 + nudge 计时清零很久
  w5.state.lastActiveAt = new Date(Date.now() - 5 * 60_000).toISOString();
  w5.lastNudgeAt = 0;
  w5.state.C = 1;
  pushed.length = 0;
  w5.tick();
  const nudge = pushed.find((p) => p.event.type === 'mood.nudge');
  check('空闲够久 + C 高 → 推出 nudge', !!nudge);
  check('nudge 正文只写环境，不写数值',
    !!nudge && !/[0-9]/.test(nudge.event.text), nudge?.event.text);
  check('nudge 带 snapshot 标签', nudge?.event.tags?.includes('snapshot'));
  check('nudge 标了 ephemeral（尽力不留在历史里）', nudge?.event.ephemeral === true);

  // 忙的时候不推
  pushed.length = 0;
  w5.busy = true;
  w5.lastNudgeAt = 0;
  w5.tick();
  check('忙的时候不插话', pushed.every((p) => p.event.type !== 'mood.nudge'));

  // ============================================================ 6. 环境变量
  console.log('\n[6] envPromptVars 只给情境');
  w5.busy = false;
  w5.state.A = 0.9;
  w5.state.T = 0.9;
  w5.state.C = 0.1;
  const vars = w5.envPromptVars();
  check('返回三个变量', vars && Object.keys(vars).length === 3, JSON.stringify(Object.keys(vars ?? {})));
  check('三个键分别是 bearing/air/distance',
    !!vars && 'bearing' in vars && 'air' in vars && 'distance' in vars);
  check('**整段文字零数字**', !!vars && !/[0-9]/.test(JSON.stringify(vars)), JSON.stringify(vars));
  const sc = scene(0.9, 0.9, 0.1);
  check('bearing 跟随 A、air 跟随 T、distance 跟随 C',
    vars?.bearing === sc.bearing && vars?.air === sc.air && vars?.distance === sc.distance);

  // ============================================================ 7. 面板 invoke
  console.log('\n[7] 面板读到的 state');
  const st = await w5.invoke('mood', 'state', []);
  check('state 里带 A/T/C', typeof st.A === 'number' && typeof st.T === 'number' && typeof st.C === 'number');
  check('state 里带 scene 三行', !!st.scene?.bearing && !!st.scene?.air && !!st.scene?.distance);
  check('state 里带 trace', Array.isArray(st.trace));

  await w5.stop();

  // ============================================================ 8. 负反馈
  console.log('\n[8] 负反馈：试探没有回音 → 黏人下降');
  pushed.length = 0;
  const w6 = mk();
  await w6.start(host);
  w6.busy = false;
  w6.state.C = 0.6;

  // 先制造一次 nudge
  w6.state.lastActiveAt = new Date(Date.now() - 5 * 60_000).toISOString();
  w6.lastNudgeAt = 0;
  w6.tick();
  check('先推出了一条 nudge', pushed.some((p) => p.event.type === 'mood.nudge'));
  check('nudgeAt 已记录', w6.nudgeAt > 0);

  // A：之后有人动过 → 只结算、不惩罚
  const cBeforeAnswer = w6.state.C;
  w6.state.lastActiveAt = new Date().toISOString();
  w6.tick();
  check('有回音 → 黏人不降', Math.abs(w6.state.C - cBeforeAnswer) < 0.02,
    `${cBeforeAnswer.toFixed(3)} → ${w6.state.C.toFixed(3)}`);
  check('有回音 → 试探被清掉', w6.nudgeAt === 0);

  // B：之后一直没人动，且已过窗口 → 惩罚
  w6.state.C = 0.6;
  w6.nudgeAt = Date.now() - (w6.cfg.nudgeIdleMs + 2_000);
  w6.state.lastActiveAt = new Date(Date.now() - (w6.cfg.nudgeIdleMs + 9_000)).toISOString();
  // 关键：伪造"nudge 发出时就是这个 lastActiveAt"，否则会被判成之后有人动过
  w6.nudgeMark = w6.state.lastActiveAt;
  w6.lastNudgeAt = 0;
  w6.busy = false;
  const cBefore = w6.state.C;
  w6.tick();
  check('无回音 → 黏人下降', w6.state.C < cBefore, `${cBefore.toFixed(3)} → ${w6.state.C.toFixed(3)}`);
  check('trace 记下「试探没有回音」',
    w6.state.trace.some((s) => s.reason.includes('试探没有回音')),
    w6.state.trace.at(-1)?.reason);
  check('惩罚权重是 unanswered(2)',
    w6.state.trace.filter((s) => s.reason.includes('试探没有回音')).at(-1)?.w === 2);

  // ============================================================ 9. 相处修复
  console.log('\n[9] 相处修复：一轮结束把黏人补一点点');
  w6.state.C = 0.4;
  const c0 = w6.state.C;
  w6.onTurnEnded();
  const grew = w6.state.C - c0;
  check('黏人上升', grew > 0, `0.400 → ${w6.state.C.toFixed(4)}`);
  check('**补得很小**（一轮 < 0.05，靠多轮慢慢回来）', grew < 0.05, `+${grew.toFixed(4)}`);
  check('单靠一轮补不回一次失望',
    grew < Math.abs(0.6 * (0.35 * (2 / 3))),
    `修复 +${grew.toFixed(4)} vs 失望约 −${(0.6 * 0.35 * 2 / 3).toFixed(4)}`);

  await w6.stop();

  // ============================================================ 10. 压缩后仍在的机制
  // 压缩只许删解释、挪位置，不许删信息。这一节专门盯住"删了会导致行为改变"的部分。
  console.log('\n[10] 压缩不得损失的机制');
  const { readFileSync } = await import('node:fs');
  const promptMd = readFileSync(new URL('../assets/prompt.md', import.meta.url), 'utf8');
  check('保留「不是你自己的状态」（防止她把情境当成自我描述）',
    promptMd.includes('不是你自己的状态'));
  check('保留「要不要因它变，由你定」（防止她把它当指令执行）',
    promptMd.includes('要不要因它变'));
  check('三个占位符都在', ['{{bearing}}', '{{air}}', '{{distance}}'].every((k) => promptMd.includes(k)));
  check('提到 mood_peek 与 mood_touch（给工具一个使用场景）',
    promptMd.includes('mood_peek') && promptMd.includes('mood_touch'));
  check('给了黏人的两个方向',
    promptMd.includes('被亲近') && promptMd.includes('被冷落'));
  check('给了绷紧的场景：被指责/被挑剔时往上',
    promptMd.includes('被指责') && promptMd.includes('被挑剔'));
  check('给了绷紧的回落：对方说开之后往下',
    promptMd.includes('把话说开'));
  check('给了劲头的场景：气氛沉下来时往下',
    promptMd.includes('气氛沉'));
  check('点明了歧义：他在自责不是在怪她',
    promptMd.includes('不是在怪你'));
  check('点明了：被叫一声就回话不算有劲',
    promptMd.includes('不叫有劲') || promptMd.includes('不用调'));
  // 验语义特征，不验精确字面：措辞会变，但「调一点再回话」这个动作顺序必须稳。
  check('引导是「先调再回话」而不是「可以调」（后者太软，模型会当可选）',
    promptMd.includes('再回话') && promptMd.includes('先用'));
  check('劝住了乱调（没变化就别调）',
    promptMd.includes('别乱调'));
  check('标注了不用说出来（防止她在回答里报数字）',
    promptMd.includes('不用说出口'));
  check('模板里不含数字（情境不许泄漏数值）', !/[0-9]/.test(promptMd));

  const { MOOD_TOOLS: TOOLS } = await import('../src/world.ts');
  const touch = TOOLS.find((t) => t.name === 'mood_touch');
  check('mood_touch 仍要求 reason', JSON.stringify(touch.parameters.required) === '["reason"]');
  check('mood_touch 仍有 A/T/C/reason 四个参数',
    ['A', 'T', 'C', 'reason'].every((k) => k in touch.parameters.properties));
  check('mood_touch 仍声明每次上限（±0.15）', touch.description.includes('0.15'));
  check('mood_touch 仍是 write 标签', touch.tags.includes('write'));
  const peek = TOOLS.find((t) => t.name === 'mood_peek');
  check('mood_peek 仍带 snapshot 标签', peek.tags.includes('snapshot'));
  check('三个工具都还在', TOOLS.length === 3);

  // ============================================================ 11. 基线
  console.log('\n[11] 衰减朝基线，不是朝 0');
  const w7 = mk();
  await w7.start(host);
  const B = { A: w7.cfg.baselineA, T: w7.cfg.baselineT, C: w7.cfg.baselineC };

  w7.state.A = 0.9;
  w7.state.updatedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  w7.decay();
  check('A 远高于基线 → 落回基线附近', Math.abs(w7.state.A - B.A) < 0.05,
    `0.900 → ${w7.state.A.toFixed(3)}（基线 ${B.A}）`);

  w7.state.T = 0;
  w7.state.updatedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  w7.decay();
  check('T 低于基线 → 升回基线附近', Math.abs(w7.state.T - B.T) < 0.05,
    `0.000 → ${w7.state.T.toFixed(3)}（基线 ${B.T}）`);

  await w7.stop();

  // 这是 Daniele 报的那个现象：抱了抱，劲头涨了又被压回去，净跌。
  console.log('\n[11b] 一轮对话不该净跌（Daniele 报的现象）');
  const w8 = mk();
  await w8.start(host);
  w8.state.A = B.A;
  const aBefore = w8.state.A;
  w8.onRunPhase(phase('model'));
  const aAfterModel = w8.state.A;
  w8.onTurnEnded();
  const aAfterEnd = w8.state.A;
  w8.state.updatedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  w8.decay();
  const aFinal = w8.state.A;

  check('开始生成不再推劲头', Math.abs(aAfterModel - aBefore) < 1e-9,
    `${aBefore.toFixed(3)} → ${aAfterModel.toFixed(3)}`);
  // onTurnEnded 里的 shift 会触发一次 decay，A 会有微秒级的回落，所以留 0.01 容差
  check('一轮结束不再额外压劲头', aAfterEnd >= aAfterModel - 0.01, `${aAfterModel.toFixed(4)} → ${aAfterEnd.toFixed(4)}`);
  check('**五分钟后不低于起点**', aFinal >= aBefore - 0.005,
    `${aBefore.toFixed(3)} → ${aFinal.toFixed(3)}（净 ${aFinal >= aBefore ? '+' : ''}${(aFinal - aBefore).toFixed(4)}）`);
  await w8.stop();

  // ============================================================ 12. 自查修掉的三处
  console.log('\n[12] 自查修的三处');

  // 12a：一轮里执行多个工具，不该累加多次劲头
  {
    const w9 = mk();
    await w9.start(host);
    w9.state.A = B.A;
    const before = w9.state.A;
    for (const t of ['mood_peek', 'mood_trace', 'mood_touch', 'x', 'y']) {
      w9.onRunPhase(phase('tools', [t]));
    }
    const after = w9.state.A;
    check('一轮五个工具只计一次劲头', after - before < 0.15,
      `${before.toFixed(3)} → ${after.toFixed(3)}（若累加五次会到 0.67 左右）`);
    await w9.stop();
  }

  // 12b：时钟回拨不该把状态冻住
  {
    const w10 = mk();
    await w10.start(host);
    w10.state.A = 0.9;
    w10.state.updatedAt = new Date(Date.now() + 3_600_000).toISOString(); // 未来一小时
    const stuck = w10.state.updatedAt;
    w10.decay();
    check('时钟回拨后 updatedAt 被拉回现在（不会冻住）',
      w10.state.updatedAt !== stuck, `仍在未来: ${w10.state.updatedAt === stuck}`);
    const t1 = w10.state.updatedAt;
    w10.state.updatedAt = new Date(Date.now() - 60_000).toISOString();
    w10.decay();
    // 只验值降了，别比较时间戳 —— 两次调用可能落在同一毫秒。
    check('拉回后能正常衰减', w10.state.A < 0.9, `0.900 → A=${w10.state.A.toFixed(3)}`);
    await w10.stop();
  }

  // 12c：超长 trace 不该整条读进内存
  {
    const { cleanState } = await import('../src/config.ts');
    const longTrace = Array.from({ length: 500 }, (_, i) => ({
      at: new Date(Date.now() - i * 1000).toISOString(),
      reason: `旧记录 ${i}`,
      w: 1,
      d: { A: 0, T: 0, C: 0 },
      after: { A: 0.5, T: 0.5, C: 0.5 },
    }));
    const cleaned = cleanState({
      A: 0.5, T: 0.5, C: 0.5,
      updatedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      trace: longTrace,
    });
    check('超长 trace 被截断到 maxTrace', cleaned.trace.length <= 40,
      `500 条 → ${cleaned.trace.length} 条`);
  }

  // 12d：一条轮次里的 model → tools → model 应该各计一次（因为 state 变了）
  {
    const w11 = mk();
    await w11.start(host);
    w11.state.A = B.A;
    const a0 = w11.state.A;
    w11.onRunPhase(phase('model'));
    w11.onRunPhase(phase('tools', ['x']));
    w11.onRunPhase(phase('model'));
    check('model 不推劲头，只有 tools 推一次', Math.abs(w11.state.A - a0) < 0.2 && w11.state.A > a0,
      `${a0.toFixed(3)} → ${w11.state.A.toFixed(3)}`);
    await w11.stop();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '集成测试全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
