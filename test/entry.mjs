// 入口契约检查。这是被 `build-describe` 绕过的那一层：
// describe 直接把定义对象喂给 exportDescribe，验不出"包的 default 导出对不对"。
// 真装进部署时读的是 default，所以单独验一次。
//
// 跑法：node --import tsx test/entry.mjs

const mod = await import('../src/index.ts');

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failed += 1;
};

const def = mod.default;

check('入口有 default 导出', def !== undefined, def === undefined ? '（缺它就会被判成缺 id/label/defaults()/create()）' : '');

if (def) {
  check('default.id 是非空字符串', typeof def.id === 'string' && def.id.length > 0, `id=${def.id}`);
  check('default.label 是非空字符串', typeof def.label === 'string' && def.label.length > 0, `label=${def.label}`);
  check('default.defaults 是函数', typeof def.defaults === 'function');
  check('default.create 是函数', typeof def.create === 'function');
  check('default.describe 存在且有 tools/events',
    !!def.describe && Array.isArray(def.describe.tools) && Array.isArray(def.describe.events),
    def.describe ? `${def.describe.tools.length} 工具 / ${def.describe.events.length} 事件` : '');

  if (typeof def.defaults === 'function') {
    const d = def.defaults();
    check('defaults() 返回 enabled: false', d?.enabled === false, JSON.stringify(d));
    check('defaults() 每次返回新对象', def.defaults() !== d);
  }
  if (typeof def.create === 'function') {
    check('create 不抛错、能给出 World 形状', (() => {
      try {
        const w = def.create({
          id: 'mood', cfg: def.defaults(), timezone: 'Asia/Hong_Kong', botName: 'test',
          botDir: '.', packageDir: '.', dataDir: '.', repoRoot: '.',
          secret: () => '', storeSecret: () => {}, persist: () => {}, restart: async () => {},
        });
        return !!w && typeof w.start === 'function' && typeof w.stop === 'function'
          && typeof w.tools === 'function' && typeof w.envPromptVars === 'function';
      } catch { return false; }
    })());
  }
}

check('具名导出 MOOD 与 default 是同一个对象', mod.MOOD === def);

console.log(`\n${failed === 0 ? '入口契约通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
