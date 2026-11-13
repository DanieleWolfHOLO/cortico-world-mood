import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { DEFAULTS, type MoodSection } from './config.ts';
import { MOOD_TOOLS, MoodWorld } from './world.ts';

export const MOOD: WorldDefinition<MoodSection> = {
  id: 'mood',
  label: 'Mood',
  defaults: () => ({ ...DEFAULTS }),
  create: (ctx) => new MoodWorld({ dataDir: ctx.dataDir, cfg: ctx.cfg }),
  describe: {
    tools: describeTools(MOOD_TOOLS, {
      mood_peek: {
        zh: '读自己此刻的唤起、张力、亲近三个值，以及眼前的举止、空气和距离。',
        en: 'Reads current arousal, tension and closeness, plus bearing, air and distance.',
      },
      mood_trace: {
        zh: '读最近几次状态变化的原因、权重和前后值。',
        en: 'Reads recent state changes with reason, weight and before/after values.',
      },
      mood_touch: {
        zh: '主动小幅调整自己的状态，用于表达自己。',
        en: 'Nudges own state slightly, for self-expression.',
      },
    }),
    events: [
      {
        type: 'mood.shift',
        description: {
          zh: '一次状态变化。只落库、不投递，数值永不进入模型上下文。',
          en: 'One state change. Archived only, never delivered, so the values never reach the model context.',
        },
      },
      {
        type: 'mood.scene',
        description: {
          zh: '某个值跨越阈值时推送的情境描述，正文不含数值。',
          en: 'A situation notice pushed when a value crosses a threshold. Contains no numbers.',
        },
        trigger: 'piggyback',
        tags: ['snapshot'],
      },
      {
        type: 'mood.nudge',
        description: {
          zh: '安静久了之后、由亲近度决定频率的主动提示；只描述环境，不替她说话。',
          en: 'A silence nudge whose frequency is governed by closeness alone. Describes the room; never speaks for her.',
        },
        trigger: 'piggyback',
        tags: ['snapshot'],
      },
    ],
  },
};
