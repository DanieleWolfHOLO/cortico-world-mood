/**
 * 情绪面板 client。两个页签：
 *   mood —— 三条进度、她读到的三行、最近几次变化、重置
 *   how  —— 原理与算式，把「为什么她会这样」摊开给看的人
 *
 * how 里显示的权重和默认值来自服务端 `invoke('constants')`，不在这里另抄一份，
 * 免得代码改了、说明没改。
 *
 * 配色：三个值各有固定色，卡片按内容归属取一个主题色（左侧竖条 + 同色极淡底）。
 * 不做彩虹，只让每块有身份。
 *
 * 只有 DOM，不 import 任何 Node 模块。
 */
import type {
  WebUiClientBundle,
  WebUiPanel,
  WebUiPanelContext,
} from 'cortico/web/shared/client-panel.ts';
import { AUTHOR_AVATAR, AUTHOR_NAME } from './avatar.ts';

const PANEL_ID = 'mood';
const PANEL_HOW = 'how';

/** 三值 + 主题各一个色。深色模式下这些亮度都还看得见。 */
const C = {
  green: '#3f9d7c',
  orange: '#d9883f',
  red: '#c25a48',
  blue: '#3d8fd0',
  violet: '#8b6fc9',
} as const;

interface MoodTriple {
  A: number;
  T: number;
  C: number;
}

interface MoodShift {
  at: string;
  reason: string;
  w: number;
  d: MoodTriple;
  after: MoodTriple;
}

interface MoodSnapshot extends MoodTriple {
  updatedAt: string;
  lastActiveAt: string;
  trace: MoodShift[];
  scene: { bearing: string; air: string; distance: string };
  step: number;
}

interface Constants {
  step: number;
  wMax: number;
  weights: Record<string, number>;
  defaults: Record<string, number | boolean>;
}

interface RowSpec {
  key: 'A' | 'T' | 'C';
  label: string;
  en: string;
  low: string;
  high: string;
  color: string;
  hint: string;
}

const ROWS: readonly RowSpec[] = [
  {
    key: 'A', label: '劲头', en: 'arousal', low: '蔫', high: '有劲',
    color: C.orange, hint: '她这会儿有多少劲：动作快慢、反应快慢',
  },
  {
    key: 'T', label: '绷紧', en: 'tension', low: '松', high: '绷着',
    color: C.red, hint: '她绷得有多紧：出错、被打断会往上推',
  },
  {
    key: 'C', label: '黏人', en: 'closeness', low: '疏', high: '黏',
    color: C.blue, hint: '她想离多近：高的时候会主动开口',
  },
];

// ---------------------------------------------------------------- 样式基元

const MUTED = 'font-size:12px;opacity:.6;line-height:1.65';
const H3 = 'font-size:14px;font-weight:600;letter-spacing:.01em;margin:0 0 3px';
const MONO = 'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;'
  + 'border-radius:0 8px 8px 0;padding:10px 12px;line-height:1.75;'
  + 'white-space:pre-wrap;word-break:break-word;font-variant-numeric:tabular-nums';

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.setAttribute('style', style);
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * 一张卡。给 accent 时左侧加 3px 竖条、底色带该色的极淡渐变——
 * 让每块在视觉上"属于"某一类，而不是一排灰盒子。
 */
const card = (accent?: string): HTMLElement => {
  const node = el('div', 'border:1px solid rgba(127,127,127,.13);border-radius:14px;'
    + 'padding:16px 18px;margin:0 0 14px;background:rgba(127,127,127,.05)');
  if (accent) {
    node.style.borderLeft = `3px solid ${accent}`;
    node.style.background =
      `linear-gradient(92deg, ${accent}14 0%, ${accent}08 34%, rgba(127,127,127,.04) 68%)`;
  }
  return node;
};

const sectionHead = (title: string, note?: string, accent?: string): HTMLElement => {
  const box = el('div', 'margin:0 0 10px');
  const h = el('div', H3, title);
  if (accent) h.style.color = accent;
  box.append(h);
  if (note) box.append(el('div', MUTED, note));
  return box;
};

const monoBlock = (text: string, accent: string): HTMLElement =>
  el('div', `${MONO};border-left:3px solid ${accent};background:${accent}12`, text);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const clock = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const gap = Math.max(0, Date.now() - d.getTime());
  if (gap < 60_000) return `${Math.round(gap / 1000)} 秒前`;
  if (gap < 3_600_000) return `${Math.round(gap / 60_000)} 分钟前`;
  return `${Math.round(gap / 3_600_000)} 小时前`;
};

const signed = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(2);

/** 把三个数翻成人话。阈值贴着基线设，别把「正常」说成「有劲」。 */
const summarize = (A: number, T: number, C: number): string => {
  const a = A > 0.55 ? '挺有劲' : A < 0.2 ? '有点蔫' : '精神正常';
  const t = T > 0.5 ? '绷着' : T < 0.12 ? '很松' : '不紧不松';
  const c = C > 0.6 ? '想靠近' : C < 0.22 ? '有点疏' : '不远不近';
  return `${a}、${t}、${c}`;
};

/** 制作者署名。两个面板都放在最下面，作为整页的收尾。 */
const signature = (): HTMLElement => {
  const box = el('div', 'display:flex;align-items:center;gap:12px;'
    + 'padding:16px 16px 14px;margin-top:6px;border-radius:14px;'
    + 'border:1px solid rgba(127,127,127,.1);'
    + `background:linear-gradient(92deg, ${C.green}12, ${C.blue}0c 55%, rgba(127,127,127,.03))`);

  const img = document.createElement('img');
  img.src = AUTHOR_AVATAR;
  img.alt = AUTHOR_NAME;
  img.setAttribute('style', 'width:44px;height:44px;border-radius:50%;object-fit:cover;'
    + `border:1.5px solid ${C.green}66;flex:none;display:block`);

  const txt = el('div', 'line-height:1.4;min-width:0');
  txt.append(
    el('div', 'font-size:13.5px;font-weight:600;letter-spacing:.01em', AUTHOR_NAME),
    el('div', `font-size:11px;color:${C.green};opacity:.9;margin-top:1px`,
      '制作 · cortico-world-mood'),
  );

  box.append(img, txt);
  return box;
};

// ---------------------------------------------------------------------------
// mood
// ---------------------------------------------------------------------------

const mountMood = async (ctx: WebUiPanelContext): Promise<void> => {
  ctx.root.append(el('div', `${MUTED};margin:0 0 14px`,
    '这三条数值只留在事件库里，从不投递给模型。她能看到的是下面那三行描述——用环境的口吻写，不是数字。'));

  // 一句话概括：三个数合起来到底是什么感觉
  const summary = el('div', 'font-size:15.5px;font-weight:600;letter-spacing:.01em;'
    + 'margin:0 0 14px', '—');
  ctx.root.append(summary);

  // ---- 三条进度（本身三色，不再加卡片主题色） ----
  const barsHost = el('div', 'border:1px solid rgba(127,127,127,.13);border-radius:14px;'
    + 'padding:18px;margin:0 0 14px;background:rgba(127,127,127,.05)');
  const bars: Record<string, { fill: HTMLElement; value: HTMLElement }> = {};

  for (const row of ROWS) {
    const wrap = el('div', 'margin:0 0 20px');
    if (row === ROWS[ROWS.length - 1]) wrap.style.marginBottom = '0';

    const head = el('div', 'display:flex;align-items:baseline;gap:8px;margin-bottom:1px');
    head.append(
      el('span', `font-size:14px;font-weight:600;color:${row.color}`, row.label),
      el('span', 'font-size:11px;opacity:.4;letter-spacing:.02em', `${row.key} · ${row.en}`),
    );
    const value = el('span', 'margin-left:auto;font-size:20px;font-weight:600;'
      + `font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:${row.color}`, '—');
    head.append(value);

    const hint = el('div', `${MUTED};font-size:11px;margin-bottom:7px`, row.hint);

    const track = el('div', 'position:relative;height:11px;border-radius:6px;'
      + `overflow:hidden;background:${row.color}1f`);
    const fill = el('div', 'position:absolute;left:0;top:0;bottom:0;width:0%;'
      + `background:linear-gradient(90deg,${row.color}dd,${row.color});`
      + 'border-radius:6px;transition:width .5s cubic-bezier(.4,0,.2,1)');
    track.append(fill);

    const foot = el('div', 'display:flex;justify-content:space-between;'
      + 'font-size:11px;opacity:.45;margin-top:5px');
    foot.append(el('span', '', row.low), el('span', '', row.high));

    wrap.append(head, hint, track, foot);
    barsHost.append(wrap);
    bars[row.key] = { fill, value };
  }
  ctx.root.append(barsHost);

  // ---- 她读到的三行（绿：环境描述） ----
  const sceneCard = card(C.green);
  sceneCard.append(sectionHead('她读到的三行',
    '这三行会写进她的提示词。写的是她自己，但用环境的口吻——这样她不会把它当成一条命令去执行。',
    C.green));
  const sceneBody = el('div', 'font-size:13px;line-height:1.95;white-space:pre-line', '—');
  sceneCard.append(sceneBody);
  ctx.root.append(sceneCard);

  // ---- 最近变化（紫：历史记录） ----
  const traceCard = card(C.violet);
  traceCard.append(sectionHead('最近变化', '只落库，不进上下文。用来对「她为什么忽然变了」。', C.violet));
  const traceBody = el('div', 'font-size:12px;line-height:1.75;white-space:pre-line;'
    + 'font-variant-numeric:tabular-nums;max-height:210px;overflow:auto', '—');
  traceCard.append(traceBody);
  ctx.root.append(traceCard);

  const foot = el('div', 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;'
    + 'font-size:11px;margin:0 0 4px');
  const stamp = el('span', 'opacity:.5', '—');
  const reset = el('button', 'font:inherit;font-size:11px;padding:5px 14px;border-radius:8px;'
    + `border:1px solid ${C.red}55;color:${C.red};background:${C.red}0f;cursor:pointer;`
    + 'transition:background .15s,opacity .15s;opacity:.85', '重置到初始值');
  reset.addEventListener('mouseenter', () => {
    reset.style.opacity = '1';
    reset.style.background = `${C.red}1f`;
  });
  reset.addEventListener('mouseleave', () => {
    reset.style.opacity = '.85';
    reset.style.background = `${C.red}0f`;
  });
  reset.addEventListener('click', () => {
    reset.setAttribute('disabled', 'true');
    reset.textContent = '重置中…';
    void ctx
      .invoke('reset')
      .then(() => refresh())
      .catch((err: unknown) => {
        reset.textContent = `失败：${err instanceof Error ? err.message : String(err)}`;
      })
      .finally(() => {
        reset.removeAttribute('disabled');
        setTimeout(() => { reset.textContent = '重置到初始值'; }, 1200);
      });
  }, { signal: ctx.signal });
  foot.append(stamp, reset);
  ctx.root.append(foot);

  ctx.root.append(signature());

  const render = (s: MoodSnapshot): void => {
    summary.textContent = summarize(s.A, s.T, s.C);
    for (const row of ROWS) {
      const v = clamp01(s[row.key]);
      const b = bars[row.key];
      if (!b) continue;
      b.fill.style.width = `${(v * 100).toFixed(1)}%`;
      b.value.textContent = v.toFixed(3);
    }

    sceneBody.textContent = [
      `举止：${s.scene.bearing}`,
      `空气：${s.scene.air}`,
      `距离：${s.scene.distance}`,
    ].join('\n');

    const rows = s.trace.slice(-8).reverse();
    traceBody.textContent = rows.length === 0
      ? '还没有记录到变化。'
      : rows
          .map(
            (t) =>
              `${clock(t.at)}　权重 ${t.w}　${t.reason}\n`
              + `　　劲头 ${signed(t.d.A)}　绷紧 ${signed(t.d.T)}　黏人 ${signed(t.d.C)}`,
          )
          .join('\n\n');

    stamp.textContent = `更新 ${clock(s.updatedAt)}　·　上次活动 ${clock(s.lastActiveAt)}`;
  };

  let lastError = '';
  const refresh = async (): Promise<void> => {
    try {
      const state = await ctx.invoke<MoodSnapshot>('state');
      lastError = '';
      render(state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== lastError) {
        lastError = msg;
        traceBody.textContent = `读取失败：${msg}`;
      }
    }
  };

  await refresh();
  ctx.interval(() => { void refresh(); }, 2000);
};

// ---------------------------------------------------------------------------
// how —— 原理
// ---------------------------------------------------------------------------

const mountHow = async (ctx: WebUiPanelContext): Promise<void> => {
  let c: Constants | null = null;
  try {
    c = await ctx.invoke<Constants>('constants');
  } catch {
    c = null;
  }

  const d = (c?.defaults ?? {}) as Record<string, number>;
  const step = c?.step ?? 0.35;
  const wMax = c?.wMax ?? 3;
  const weights = c?.weights ?? {};

  const num2 = (v: unknown, fb: number): string =>
    typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : fb.toFixed(2);

  ctx.root.append(el('div', `${MUTED};margin:0 0 14px`,
    '这一页是全部机制。没有训练出来的权重，没有黑箱——每一次变化都能用下面的算式复算出来。'
    + '所有数字都可以在配置里改。'));

  // 三个值（三色）
  const baseCard = card(C.green);
  baseCard.append(sectionHead('三个值', undefined, C.green));
  const baseTable = el('div', 'font-size:12.5px;line-height:2.05;white-space:pre-wrap;'
    + 'font-variant-numeric:tabular-nums', [
    `劲头 A    基线 ${num2(d.baselineA, 0.3)}   半衰期 ${num2(d.halfLifeA, 3)} 分钟     动作快慢、反应快慢`,
    `绷紧 T    基线 ${num2(d.baselineT, 0.2)}   半衰期 ${num2(d.halfLifeT, 20)} 分钟    出错、被打断会往上推`,
    `黏人 C    基线 ${num2(d.baselineC, 0.4)}   半衰期 ${num2(d.halfLifeC, 90)} 分钟   决定她多久想主动开口`,
  ].join('\n'));
  baseCard.append(baseTable);
  baseCard.append(el('div', `${MUTED};margin-top:10px`,
    '三者互不干扰：劲头只走「举止」，绷紧只走「空气」，黏人只走「距离」和开口频率。'
    + '任何一格若由两个值共同决定，外面就分不出是哪个在动。'));
  ctx.root.append(baseCard);

  // 增量（橙）
  const growCard = card(C.orange);
  growCard.append(sectionHead('事件怎么推', undefined, C.orange));
  growCard.append(monoBlock(
    `增量 = STEP × (权重 / ${wMax}) × 剩余空间\n\n`
    + `STEP = ${step.toFixed(2)}　（权重拉满、空间充足时的一步）\n`
    + `剩余空间：往上走看还有多少到 1，往下走看还有多少到 0`, C.orange));
  growCard.append(el('div', `${MUTED};margin:10px 0 12px`,
    '所以越接近边界，一次推得越少——饱和是算式自带的，不是另外夹出来的。'));
  const wRows = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.padEnd(14)}${String(v).padStart(5)}`);
  growCard.append(monoBlock(`${'权重'.padEnd(14)}${'值'.padStart(5)}\n` + wRows.join('\n'), C.orange));
  ctx.root.append(growCard);

  // 衰减（蓝）
  const decayCard = card(C.blue);
  decayCard.append(sectionHead('怎么回到基线', undefined, C.blue));
  decayCard.append(monoBlock(`v' = 基线 + (v − 基线) × 0.5^(经过分钟 / 半衰期)`, C.blue));
  decayCard.append(el('div', `${MUTED};margin-top:10px`,
    '高于基线会落回，低于基线会涨回。注意是朝基线、不是朝 0——朝 0 的话每一轮都会净跌，'
    + '越聊越没劲，因为回升永远追不上下一次的回落。'));
  ctx.root.append(decayCard);

  // 主动开口（蓝）
  const nudgeCard = card(C.blue);
  nudgeCard.append(sectionHead('主动开口', undefined, C.blue));
  const baseMin = Number(d.nudgeBaseMs ?? 600000) / 60000;
  const floorMin = Number(d.nudgeFloorMs ?? 180000) / 60000;
  const idleMin = Number(d.nudgeIdleMs ?? 240000) / 60000;
  nudgeCard.append(monoBlock(
    `间隔 = max(${floorMin.toFixed(0)} 分钟, ${baseMin.toFixed(0)} 分钟 ÷ (0.25 + 黏人))\n\n`
    + `黏人 1.0 → 约 ${(baseMin / 1.25).toFixed(0)} 分钟\n`
    + `黏人 0.0 → 约 ${(baseMin / 0.25).toFixed(0)} 分钟`, C.blue));
  nudgeCard.append(el('div', `${MUTED};margin-top:10px`,
    `另有两道闸门：她正在生成或执行工具时不插话；刚聊完 ${idleMin.toFixed(0)} 分钟内不插话。`));
  ctx.root.append(nudgeCard);

  // 循环（红）
  const loopCard = card(C.red);
  loopCard.append(sectionHead('试探没有回音', undefined, C.red));
  loopCard.append(el('div', `${MUTED};line-height:1.9`,
    '开口之后一段时间内没有任何活动 → 黏人掉一档。掉到低就更久才开口，于是自然「自己待会」。'
    + '而每一轮相处会把黏人补一点点（很小），所以关系会慢慢修回来。'));
  const loopStat = monoBlock('一次失望 ≈ −0.14　　一轮相处 ≈ +0.02　　约 7 轮相处抵一次失望', C.red);
  loopStat.style.marginTop = '10px';
  loopCard.append(loopStat);
  ctx.root.append(loopCard);

  // 边界（中性）
  const boundCard = card();
  boundCard.append(sectionHead('它不碰什么'));
  boundCard.append(el('div', `${MUTED};line-height:1.9`,
    '这一层没有一句人格、语气或说话方式。它只改变两件事：她看到的房间描述，和她多久想开口一次。'
    + '黏人低只意味着不主动开口——被搭话时照常回应，不会变冷。'));
  ctx.root.append(boundCard);

  ctx.root.append(signature());
};

// ---------------------------------------------------------------------------

const bundle: WebUiClientBundle = {
  panels: {
    [PANEL_ID]: { mount: mountMood },
    [PANEL_HOW]: { mount: mountHow },
  },
};
export default bundle;
