import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EventEnvelope,
  RunPhase,
  ToolDef,
  ToolSpec,
  World,
  WorldHost,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import {
  DEFAULTS,
  ID,
  STEP,
  W,
  W_MAX,
  cleanSection,
  cleanState,
  clamp01,
  emptyState,
  num,
  scene,
  type MoodSection,
  type MoodState,
  type MoodTriple,
} from './config.ts';

const PROMPT_PATH = fileURLToPath(new URL('../assets/prompt.md', import.meta.url));
const PANEL = 'mood';
/** 第二个面板：把原理和函数关系摊开给看的人 —— 这也是「不碰 persona」的旁证。 */
const PANEL_HOW = 'how';
const SAVE_NAME = 'mood-state.json';
const TICK_MS = 30_000;
/** 两条情境事件之间至少隔这么久，防阈值附近震荡时刷屏。 */
const NOTICE_COOLDOWN_MS = 90_000;

const fmt = (v: number): string => v.toFixed(2);
const sgn = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(2);

/** 工具声明。实例的 tools() 从这里取描述，只补 handler；describe 导出同一份。 */
export const MOOD_TOOLS: readonly ToolSpec[] = [
  {
    name: 'mood_peek',
    description:
      '读自己此刻的劲头（A）、绷紧（T）、黏人（C），都是 0–1。想知道自己为什么状态不对时用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    tags: ['read', 'snapshot'],
  },
  {
    name: 'mood_trace',
    description: '读最近几次状态变化：原因、权重、各自变化量。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 40, description: '要几条，默认 8' },
      },
      additionalProperties: false,
    },
    tags: ['read'],
  },
  {
    name: 'mood_touch',
    description:
      '主动小幅调整自己：劲头（A）、绷紧（T）、黏人（C），每项 ±0.15 以内，正数加、负数减。'
      + '气氛明显变化时先调再回话；没变化别乱调。必须给理由。',
    parameters: {
      type: 'object',
      properties: {
        A: { type: 'number', description: '劲头增减，±0.15 以内' },
        T: { type: 'number', description: '绷紧增减，±0.15 以内' },
        C: { type: 'number', description: '黏人增减，±0.15 以内' },
        reason: { type: 'string', description: '为什么这样调整，一句话' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    tags: ['write'],
  },
];

/**
 * 情绪世界。
 *
 * 三条硬约束，缺一条这套东西就退化成装饰：
 *
 * 1. **数值永不进入上下文。** 状态变化走 `pushEvent(..., { deliver: false })`：
 *    落库、有 cursor、可审计，但不投递。想读数值只能主动调 `mood_peek`。
 *    理由：一个可被完整读取的状态会降级成「提示」，模型可以选择忽略或表演它。
 *
 * 2. **三个维度各有独立出口，互不混用。** A 只走「举止」，T 只走「空气」，
 *    C 只走「距离」+ 主动开口的频率。任何一格若由两个维度共同决定，
 *    外部就分辨不出是哪个在动。
 *
 * 3. **不碰 persona。** 这里没有一句人格、语气或说话方式。它只改变她所处的房间。
 */
export class MoodWorld implements World {
  readonly id = ID;
  private host: WorldHost | null = null;
  private cfg: MoodSection;
  private state: MoodState;
  private readonly savePath: string;
  private lastPhase = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 模型正在生成或工具正在跑时为 true：此时不插话。 */
  private busy = false;
  private lastNudgeAt = 0;
  /** 上一条 nudge 发出的时刻；0 表示没有待结算的试探。 */
  private nudgeAt = 0;
  /** nudge 发出时的 lastActiveAt。用它判断之后有没有人动 —— 比时间先后可靠，不受毫秒精度影响。 */
  private nudgeMark = '';
  /** 上一次推情境事件的时刻；用作防抖。 */
  private lastNoticeAt = 0;

  constructor(opts: { dataDir: string; cfg: MoodSection }) {
    this.cfg = cleanSection(opts.cfg);
    this.state = emptyState();
    this.savePath = join(opts.dataDir, SAVE_NAME);
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    if (existsSync(this.savePath)) {
      try {
        this.state = cleanState(JSON.parse(readFileSync(this.savePath, 'utf8')));
      } catch {
        /* 存档坏了就从头开始，不阻塞挂载 */
      }
    }
    this.decay();
    // 停机期间攒下的「安静」不该在重启后立刻兑现：nudge 计时从此刻重新开始。
    this.lastNudgeAt = Date.now();
    this.nudgeAt = 0;
    this.nudgeMark = '';
    if (this.cfg.enabled) this.startTicking();
    host.log.info('情绪世界已加载', {
      A: fmt(this.state.A),
      T: fmt(this.state.T),
      C: fmt(this.state.C),
      updatedAt: this.state.updatedAt,
    });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.decay();
    this.save();
    this.host = null;
  }

  // ---------------------------------------------------------------- 动力学

  /**
   * 按真实经过时间向基线收敛。
   *
   * 注意是「向基线」不是「向 0」：情绪围绕一个设定点波动，事件把它推离，然后回到原位。
   * 朝 0 衰减的后果是每聊一轮净跌一点 —— 回升永远追不上下一次的回落，越聊越没劲。
   */
  private decay(): void {
    const now = Date.now();
    const then = Date.parse(this.state.updatedAt);
    if (Number.isNaN(then)) return;
    if (now < then) {
      // 时钟回拨：别让状态冻住。承认这个时刻，从这里重新计。
      this.state.updatedAt = new Date(now).toISOString();
      return;
    }
    if (now === then) return;
    const minutes = (now - then) / 60_000;
    const toward = (v: number, base: number, hl: number): number =>
      base + (v - base) * Math.pow(0.5, minutes / hl);
    this.state.A = clamp01(toward(this.state.A, this.cfg.baselineA, this.cfg.halfLifeA));
    this.state.T = clamp01(toward(this.state.T, this.cfg.baselineT, this.cfg.halfLifeT));
    this.state.C = clamp01(toward(this.state.C, this.cfg.baselineC, this.cfg.halfLifeC));
    this.state.updatedAt = new Date(now).toISOString();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.savePath), { recursive: true });
      writeFileSync(this.savePath, JSON.stringify(this.state, null, 2));
    } catch {
      /* 落盘失败不影响运行 */
    }
  }

  /**
   * 单值推进一步。`dir` 取 +1 / 0 / −1 表示方向，`w` 是事件权重。
   * 幅度随「剩余空间」缩放：往上走看还有多少到 1，往下走看还有多少到 0。
   * 这就是饱和，不需要额外的夹紧规则。
   */
  private apply(v: number, dir: number, w: number): number {
    if (dir === 0) return v;
    const room = dir > 0 ? 1 - v : v;
    const step = STEP * (Math.min(w, W_MAX) / W_MAX) * room;
    return clamp01(v + dir * step);
  }

  private shift(reason: string, dir: Partial<MoodTriple>, w: number): void {
    if (!this.cfg.enabled) return;
    this.decay();

    const before: MoodTriple = { A: this.state.A, T: this.state.T, C: this.state.C };
    this.state.A = this.apply(before.A, dir.A ?? 0, w);
    this.state.T = this.apply(before.T, dir.T ?? 0, w);
    this.state.C = this.apply(before.C, dir.C ?? 0, w);

    const at = new Date().toISOString();
    this.state.updatedAt = at;
    const after: MoodTriple = { A: this.state.A, T: this.state.T, C: this.state.C };

    this.state.trace.push({
      at,
      reason,
      w,
      d: { A: after.A - before.A, T: after.T - before.T, C: after.C - before.C },
      after,
    });
    while (this.state.trace.length > this.cfg.maxTrace) this.state.trace.shift();
    this.save();

    const host = this.host;
    if (!host) return;

    // 数值只落库，永不投递。正文留空，避免任何数值经正文进入上下文。
    void host
      .pushEvent(
        { type: 'mood.shift', ts: at, source: ID, text: '', meta: { reason, w, before, after } },
        { deliver: false },
      )
      .catch(() => {});

    this.noticeIfCrossed(before, after, at);
  }

  /** 某个值跨越阈值时，发一条**只写情境、不写数值**的可投递事件。 */
  private noticeIfCrossed(before: MoodTriple, after: MoodTriple, at: string): void {
    const n = this.cfg.noticeAt;
    const up = (v: number): boolean => v >= n;
    const crossed =
      up(before.T) !== up(after.T)
      || up(before.C) !== up(after.C)
      || up(before.A) !== up(after.A);
    if (!crossed) return;

    // 防抖：值在阈值附近来回抖动时，别把同一件事反复推给模型。
    const now = Date.now();
    if (now - this.lastNoticeAt < NOTICE_COOLDOWN_MS) return;
    this.lastNoticeAt = now;

    const s = scene(after.A, after.T, after.C);
    const host = this.host;
    if (!host) return;
    void host
      .pushEvent(
        {
          type: 'mood.scene',
          ts: at,
          source: ID,
          text: `${s.bearing}。${s.air}。${s.distance}。`,
          tags: ['snapshot'],
          meta: { kind: 'scene' },
        },
        { trigger: 'piggyback' },
      )
      .catch(() => {});
  }

  // ------------------------------------------------------------ 主动性（C 的通道）

  private startTicking(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /**
   * 主动开口的频率只由 C 决定：C 高则间隔短，C 低则拉长。
   * 这是 C 的第二条独立通道，也是「她今天黏不黏人」最直观的那一面。
   * A 和 T 都不参与这个计算。
   */
  private tick(): void {
    if (!this.cfg.enabled) return;
    if (this.busy) return;

    const now = Date.now();

    // 先结算上一次试探：之后有没有人动过。这是整条负反馈的来源。
    if (this.nudgeAt > 0) {
      if (this.state.lastActiveAt !== this.nudgeMark) {
        // 有人回应了，试探有回音。
        this.nudgeAt = 0;
      } else if (now - this.nudgeAt > this.cfg.nudgeIdleMs) {
        // 过了窗口还是没人动 —— 黏人往下掉，下次开口自然更晚。
        this.nudgeAt = 0;
        this.shift('试探没有回音', { C: -1 }, W.unanswered);
        return;
      }
    }

    const idle = now - Date.parse(this.state.lastActiveAt);
    if (Number.isNaN(idle) || idle < this.cfg.nudgeIdleMs) return;

    this.decay();
    const gap = Math.max(this.cfg.nudgeFloorMs, this.cfg.nudgeBaseMs / (0.25 + this.state.C));
    if (now - this.lastNudgeAt < gap) return;

    this.lastNudgeAt = now;
    this.nudgeAt = now;
    this.nudgeMark = this.state.lastActiveAt;
    const host = this.host;
    if (!host) return;

    const s = scene(this.state.A, this.state.T, this.state.C);
    void host
      .pushEvent(
        {
          type: 'mood.nudge',
          ts: new Date().toISOString(),
          source: ID,
          text: `安静已经持续了一段时间。${s.bearing}。`,
          tags: ['snapshot'],
          // 尽力而为：整批都是 ephemeral 时，这条只在当批出现，之后从 session 移除、不留进历史。
          ephemeral: true,
          meta: { kind: 'nudge' },
        },
        { trigger: 'piggyback' },
      )
      .catch(() => {});
  }

  // ------------------------------------------------------------ 事件源（客观）

  /** 主循环状态变化。Core 在调用栈上同步调用它，只记录，不做耗时操作。 */
  onRunPhase(phase: RunPhase): void {
    // 只有完全空闲才算「不忙」：delivering / handoff / backoff 时插话都是打断。
    this.busy = phase.state !== 'idle';
    this.state.lastActiveAt = new Date().toISOString();

    if (!this.cfg.enabled) return;
    // 只按主循环状态去重，不看 running：一轮里执行五个工具不该累加五次劲头。
    const key = phase.state;
    if (key === this.lastPhase) return;
    this.lastPhase = key;

    if (phase.state === 'backoff') {
      this.shift('模型调用失败，进入退避等待', { T: 1 }, W.failure);
      return;
    }
    if (phase.state === 'tools' && phase.running.length > 0) {
      this.shift(`开始执行 ${phase.running[0] ?? '工具'}`, { A: 1 }, W.toolStart);
      return;
    }
    if (phase.state === 'model') {
      // 这里**不推**劲头。开始生成是每轮必发生的系统行为，不是情绪事件；
      // 每轮都推就成了「他一说话她就兴奋」，和对话内容无关。
      // 劲头改由她自己按气氛判断（见 assets/prompt.md）。
      return;
    }
  }

  /** 一轮自然结束：只补一点相处，劲头和绷紧交给衰减自己回基线。 */
  onTurnEnded(): void {
    this.lastPhase = '';
    this.busy = false;
    this.state.lastActiveAt = new Date().toISOString();
    if (!this.cfg.enabled) return;
    // 「一轮结束」不是情绪事件，只是时间过去了：劲头和绷紧靠衰减自己回基线。
    // 在这里额外往下压会超调 —— 从基线出发的一轮对话会净跌，越聊越没劲。
    // 相处本身会修复关系，但很小：一轮只补一点，靠多轮慢慢回来。
    this.shift('又相处了一会儿', { C: 1 }, W.care);
  }

  /** 自己推送的事件被清空，是一种「说了没人听」的信号。 */
  onEventsSettled(events: readonly EventEnvelope[], outcome: 'delivered' | 'discarded'): void {
    if (!this.cfg.enabled || outcome !== 'discarded' || events.length === 0) return;
    this.shift(`推送的 ${events.length} 条被清空`, { T: 1 }, W.discarded);
  }

  // ------------------------------------------------------------------ 工具

  tools(): ToolDef[] {
    if (!this.cfg.enabled) return [];
    return [
      { ...this.spec('mood_peek'), handler: async () => this.peek() },
      { ...this.spec('mood_trace'), handler: async (args) => this.traceOf(args) },
      { ...this.spec('mood_touch'), handler: async (args) => this.touch(args) },
    ];
  }

  private spec(name: string): ToolSpec {
    const found = MOOD_TOOLS.find((t) => t.name === name);
    if (!found) throw new Error(`missing tool spec: ${name}`);
    return found;
  }

  private peek(): { text: string } {
    this.decay();
    const s = scene(this.state.A, this.state.T, this.state.C);
    const recent = this.state.trace.slice(-3).map(
      (t) => `${t.reason}（w${t.w} · A${sgn(t.d.A)} T${sgn(t.d.T)} C${sgn(t.d.C)}）`,
    );
    return {
      text: [
        `A 唤起 ${fmt(this.state.A)}　T 张力 ${fmt(this.state.T)}　C 亲近 ${fmt(this.state.C)}`,
        `读数时刻 ${this.state.updatedAt}`,
        `举止：${s.bearing}`,
        `空气：${s.air}`,
        `距离：${s.distance}`,
        recent.length ? `最近：${recent.join('；')}` : '还没有记录到变化。',
      ].join('\n'),
    };
  }

  private traceOf(args: Record<string, unknown>): { text: string } {
    this.decay();
    const want = Math.max(1, Math.min(this.cfg.maxTrace, Math.round(num(args.count, 8))));
    const rows = this.state.trace.slice(-want);
    if (rows.length === 0) return { text: '还没有记录到变化。' };
    return {
      text: rows
        .map(
          (s) =>
            `${s.at}　w${s.w}　${s.reason}\n`
            + `　ΔA${sgn(s.d.A)} ΔT${sgn(s.d.T)} ΔC${sgn(s.d.C)}`
            + ` → A${fmt(s.after.A)} T${fmt(s.after.T)} C${fmt(s.after.C)}`,
        )
        .join('\n'),
    };
  }

  private touch(args: Record<string, unknown>): { text: string } {
    const cap = this.cfg.touchLimit;
    const cut = (v: unknown): number => Math.max(-cap, Math.min(cap, num(v, 0)));
    const reason = String(args.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '主动调整';
    if (!this.cfg.enabled) return { text: '本 World 未启用，调整没有生效。' };

    this.decay();
    const before: MoodTriple = { A: this.state.A, T: this.state.T, C: this.state.C };
    const dA = cut(args.A);
    const dT = cut(args.T);
    const dC = cut(args.C);
    // 和事件增量同一套数学：越远离边界越走得动，越靠近越难。
    // 效果是「反复安慰」有递减收益 —— 哄一次有效，哄五次基本没用了。
    const nudgeValue = (v: number, d: number): number => {
      if (d === 0) return v;
      const room = d > 0 ? 1 - v : v;
      return clamp01(v + d * room);
    };
    this.state.A = nudgeValue(before.A, dA);
    this.state.T = nudgeValue(before.T, dT);
    this.state.C = nudgeValue(before.C, dC);

    const at = new Date().toISOString();
    this.state.updatedAt = at;
    this.state.lastActiveAt = at;
    const after: MoodTriple = { A: this.state.A, T: this.state.T, C: this.state.C };
    this.state.trace.push({
      at,
      reason: `主动：${reason}`,
      w: 1,
      d: { A: after.A - before.A, T: after.T - before.T, C: after.C - before.C },
      after,
    });
    while (this.state.trace.length > this.cfg.maxTrace) this.state.trace.shift();
    this.save();

    const host = this.host;
    if (host) {
      void host
        .pushEvent(
          { type: 'mood.shift', ts: at, source: ID, text: '', meta: { reason, w: 1, before, after } },
          { deliver: false },
        )
        .catch(() => {});
    }
    this.noticeIfCrossed(before, after, at);

    return {
      text: `已调整。现在 A${fmt(this.state.A)} T${fmt(this.state.T)} C${fmt(this.state.C)}`,
    };
  }

  // -------------------------------------------------------------- 环境与面板

  /** 只返回情境变量，不返回任何数值。 */
  envPromptVars(): Record<string, string> | null {
    if (!this.cfg.enabled) return null;
    this.decay();
    const s = scene(this.state.A, this.state.T, this.state.C);
    return { bearing: s.bearing, air: s.air, distance: s.distance };
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const en = language === 'en';
    return {
      label: en ? 'Mood' : '小情绪',
      panels: [
        {
          id: PANEL,
          title: en ? 'Mood' : '小情绪',
          description: en
            ? 'Affective state derived from run events. Values stay in the event log and are never delivered to the model.'
            : '由运行事件推出的状态。数值只留在事件库里，从不投递给模型。',
        },
        {
          id: PANEL_HOW,
          title: en ? 'How it works' : '原理',
          description: en
            ? 'What the three values are, how events move them, and how they settle back to baseline.'
            : '三个值是什么、事件怎么推它们、怎么回到基线。全部是确定的算式，没有黑箱。',
        },
      ],
      promptDocs: [
        {
          key: `worlds.${ID}.prompt`,
          title: en ? 'The room right now' : '此刻的房间',
          description: en
            ? 'Three environment variables, each driven by exactly one dimension. Contains no numeric state.'
            : '三个情境变量，各由一个维度单独驱动；模板本身不含任何数值。',
          path: PROMPT_PATH,
          role: 'envPrompt',
          vars: [
            { name: 'bearing', description: '举止（只由唤起决定）', multiline: false },
            { name: 'air', description: '空气（只由张力决定）', multiline: false },
            { name: 'distance', description: '距离（只由亲近决定）', multiline: false },
          ],
        },
      ],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
    };
  }

  private async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    // 常量查询对两个面板都开放：原理页要显示真实的权重和默认值，不能和代码两套写法。
    if (method === 'constants') {
      return { step: STEP, wMax: W_MAX, weights: W, defaults: DEFAULTS };
    }
    if (panel !== PANEL) throw new Error('unknown panel');
    if (method === 'state') {
      this.decay();
      return {
        ...this.state,
        scene: scene(this.state.A, this.state.T, this.state.C),
        weights: W,
        step: STEP,
      };
    }
    if (method === 'reset') {
      this.state = emptyState();
      this.lastNudgeAt = 0;
      this.nudgeAt = 0;
      this.nudgeMark = '';
      this.save();
      return { ok: true, state: this.state };
    }
    throw new Error(`unknown method: ${method}，args=${JSON.stringify(args)}`);
  }
}
