/**
 * 包入口。
 *
 * **default 导出必须是 WorldDefinition** —— Cortico 装载扩展时读的就是它。
 * 只有具名导出会被判成「缺 id / label / defaults() / create()」。
 */
import { MOOD } from './definition.ts';

export default MOOD;

export { MOOD };
export { MoodWorld, MOOD_TOOLS } from './world.ts';
export {
  DEFAULTS,
  ID,
  STEP,
  W,
  W_MAX,
  scene,
  type MoodSection,
  type MoodState,
  type MoodTriple,
  type Scene,
} from './config.ts';
