export const ID = 'mood';

// ---------------------------------------------------------------- 增量模型
//
// 不再写「工具失败 → T +0.30」这种绝对值。改成两步：
//   1) 事件只声明「方向」（+1 / −1）和「权重」（中性 = 1）；
//   2) 幅度由 STEP 与剩余空间共同决定，越接近边界走得越慢。
//
// 好处：接近 1 时自然饱和（不用另写规则）、不需要精确绝对值、
// 权重之间可以比较（3 : 1 这种比例有依据，绝对增量没有）。

/** 满权重、空间充足时的一步。 */
export const STEP = 0.35;
/** 权重上限，用于归一化。 */
export const W_MAX = 3;

/**
 * 事件权重。中性 = 1。
 * 负面偏差：失败比成功重，这是唯一有心理学依据的部分（negativity bias）。
 * 其余比例是给的，不是测的——别把它们当成精确的。
 */
export const W = {
  /** 模型调用失败 */
  failure: 3,
  /** 自己推送的事件被操作者清空 */
  discarded: 2,
  /** 主动试探之后没人理 —— 这是负反馈的来源，让循环会自己收敛 */
  unanswered: 2,
  /** 一轮自然结束（往回收劲头和绷紧） */
  turnEnd: 1.8,
  /** 开始执行工具 */
  toolStart: 1.2,
  /** 开始生成回复 */
  modelStart: 1,
  /**
   * 相处修复。故意很小：一轮只补一点，靠多轮慢慢回来。
   * 没有它，疏远就变成单向的冷。
   */
  care: 0.3,
} as const;

// ---------------------------------------------------------------- 配置

export interface MoodSection {
  enabled: boolean;
  /** 唤起半衰期（分钟）。生理参考：儿茶酚胺 1–3 分钟。 */
  halfLifeA: number;
  /** 张力半衰期（分钟）。生理参考：急性压力主观恢复 15–30 分钟。 */
  halfLifeT: number;
  /** 亲近半衰期（分钟）。生理参考：皮质醇 60–90 分钟。 */
  halfLifeC: number;
  /** 阈值：跨越时推一条只写情境的提示。 */
  noticeAt: number;
  /** trace 保留条数。 */
  maxTrace: number;
  /** 单次 mood_touch 的调整上限（乘剩余空间之前）。0.30 乘 room 后约等于原来的 0.15。 */
  touchLimit: number;
  /** 基线：情绪围绕它波动，事件推离之后回到这里，而不是回到 0。 */
  baselineA: number;
  baselineT: number;
  baselineC: number;
  /** 主动开口的基准间隔（毫秒）。实际间隔 = 基准 / (0.25 + C)，C 高则更短。 */
  nudgeBaseMs: number;
  /** 主动开口的最小间隔，防止变吵。 */
  nudgeFloorMs: number;
  /** 多久没有活动才考虑主动开口。正在对话时不插话。 */
  nudgeIdleMs: number;
}

export const DEFAULTS: MoodSection = {
  enabled: false,
  halfLifeA: 3,
  halfLifeT: 20,
  halfLifeC: 90,
  noticeAt: 0.6,
  maxTrace: 40,
  touchLimit: 0.30,
  baselineA: 0.3,
  baselineT: 0.2,
  baselineC: 0.4,
  nudgeBaseMs: 600_000,   // 10 分钟
  nudgeFloorMs: 180_000,  // 3 分钟
  nudgeIdleMs: 240_000,   // 4 分钟
};

export interface MoodTriple {
  A: number;
  T: number;
  C: number;
}

/** 一次状态变化。数值只落库，不进上下文。 */
export interface MoodShift {
  at: string;
  reason: string;
  w: number;
  d: MoodTriple;
  after: MoodTriple;
}

export interface MoodState extends MoodTriple {
  updatedAt: string;
  /** 上一次有活动的时刻，用于判断「多久没人说话」。 */
  lastActiveAt: string;
  trace: MoodShift[];
}

export function emptyState(): MoodState {
  const now = new Date().toISOString();
  return { A: 0.3, T: 0.2, C: 0.4, updatedAt: now, lastActiveAt: now, trace: [] };
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 数值转换。注意 Number(null) 是 0，所以 null / undefined / 空串一律回落。 */
export function num(v: unknown, fallback: number): number {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 配置清洗：非正数的半衰期回落默认值（避免除零），其余夹紧。 */
export function cleanSection(raw: unknown): MoodSection {
  const o = (raw ?? {}) as Record<string, unknown>;
  const pos = (v: unknown, fb: number): number => {
    const n = num(v, fb);
    return n > 0 ? n : fb;
  };
  return {
    enabled: o.enabled === true,
    halfLifeA: pos(o.halfLifeA, DEFAULTS.halfLifeA),
    halfLifeT: pos(o.halfLifeT, DEFAULTS.halfLifeT),
    halfLifeC: pos(o.halfLifeC, DEFAULTS.halfLifeC),
    noticeAt: clamp01(num(o.noticeAt, DEFAULTS.noticeAt)),
    maxTrace: Math.max(4, Math.round(num(o.maxTrace, DEFAULTS.maxTrace))),
    touchLimit: clamp01(num(o.touchLimit, DEFAULTS.touchLimit)),
    baselineA: clamp01(num(o.baselineA, DEFAULTS.baselineA)),
    baselineT: clamp01(num(o.baselineT, DEFAULTS.baselineT)),
    baselineC: clamp01(num(o.baselineC, DEFAULTS.baselineC)),
    nudgeBaseMs: Math.max(60_000, Math.round(num(o.nudgeBaseMs, DEFAULTS.nudgeBaseMs))),
    nudgeFloorMs: Math.max(30_000, Math.round(num(o.nudgeFloorMs, DEFAULTS.nudgeFloorMs))),
    nudgeIdleMs: Math.max(0, Math.round(num(o.nudgeIdleMs, DEFAULTS.nudgeIdleMs))),
  };
}

/** 存档清洗：非法或缺失时回落默认。 */
export function cleanState(raw: unknown): MoodState {
  const base = emptyState();
  const o = (raw ?? {}) as Record<string, unknown>;
  const iso = (v: unknown, fb: string): string =>
    typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fb;
  const trace = Array.isArray(o.trace)
    ? (o.trace as MoodShift[])
        .filter((s) => s && typeof s.at === 'string' && typeof s.reason === 'string' && s.after)
        // v1 存档没有 w，补成中性权重，避免 trace 里出现 wundefined
        .map((s) => ({ ...s, w: typeof s.w === 'number' ? s.w : 1 }))
        // 存档被手改过、或历史遗留超长时，别把整条读进内存；maxTrace 只在 shift 时才生效。
        .slice(-DEFAULTS.maxTrace)
    : [];
  // 旧存档没有 lastActiveAt，用 updatedAt 更贴事实；都没有才用「此刻」。
  const updated = iso(o.updatedAt, base.updatedAt);
  return {
    A: clamp01(num(o.A, base.A)),
    T: clamp01(num(o.T, base.T)),
    C: clamp01(num(o.C, base.C)),
    updatedAt: updated,
    lastActiveAt: iso(o.lastActiveAt, updated),
    trace,
  };
}

// ---------------------------------------------------------------- 情境映射
//
// 三个变量、三个维度、严格一一对应。不能有任何一个是两个维度混出来的，
// 否则外部就分辨不出是哪个在动，「情绪」就退化成装饰。

export interface Scene {
  /** 只由 A（唤起）决定。 */
  bearing: string;
  /** 只由 T（张力）决定。 */
  air: string;
  /** 只由 C（亲近）决定。 */
  distance: string;
}

export function scene(A: number, T: number, C: number): Scene {
  // 阈值围绕基线（0.30 / 0.20 / 0.40）对称铺开，且单次 mood_touch（±0.15）刚好跨一档。
  // 这样：基线落在中间档、调一次就能看见变化、两个方向对称。
  return {
    bearing:
      A > 0.42
        ? '动作快，呼吸浅，手上不太停得下来'
        : A < 0.20
          ? '动作很慢，像是不太想动'
          : '动作正常，偶尔停一下',
    air:
      T > 0.30
        ? '空气绷得很紧，动一下都响'
        : T < 0.12
          ? '空气是松的'
          : '空气有点沉',
    distance:
      C > 0.52
        ? '离得很近，抬头就能撞上'
        : C < 0.28
          ? '隔着一臂的距离'
          : '离得不远',
  };
}
