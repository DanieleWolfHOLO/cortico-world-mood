# cortico-world-mood

给 Cortico / Coopanion 用的情绪 World。

**它不碰 persona。** 不写人格、不改说话方式、不注入语气。
它只做一件事——**改变她睁眼看到的房间，以及她多久想开口一次。**

## 安装

需要一个装了 `cortico` 0.2.x 的 Coopanion 部署（`world` 契约 v6，0.2.8 和 0.2.15 都验过一致）。

**从 npm：**

```powershell
npm i cortico-world-mood
```

**手动（不用 npm）：**

1. 解包到 `data\extensions\vendor\cortico-world-mood\`
2. `data\extensions\package.json` 的 `dependencies` 加 `"cortico-world-mood": "link:vendor/cortico-world-mood"`
3. `data\extensions\world-owners.json` 加 `"mood": "cortico-world-mood"`
4. `data\home\companion\config.json` 的 `worlds` 段加 `"mood": { "enabled": true }`
5. 在 `data\extensions\node_modules\` 里建一个 junction 指向 vendor 目录
6. **完全退出 Coopanion（含托盘）再启动**

第 5 步在 Windows 上：

```powershell
New-Item -ItemType Junction -Path '...\extensions\node_modules\cortico-world-mood' `
  -Target '...\extensions\vendor\cortico-world-mood'
```

装好后「设置 → 桌宠 / 世界」里会出现 **❤ 小情绪**，点进去有两个页签：当前值和原理。

**改 UI 之后必须改版本号。** Cortico 给扩展资源加了 `Cache-Control: immutable`，URL 里带版本，版本不变浏览器永远用缓存——连 Ctrl+F5 都绕不过。会看到「面板产物中没有 xxx / 可用面板：yyy」，那不是代码坏了，是加载到了旧 bundle。

---

## 三条硬约束

缺一条，这套东西就退化成装饰。

### 一、数值永不进入上下文

| 通道 | 内容 | 模型能否读到 |
|---|---|---|
| `pushEvent(..., { deliver: false })` | A / T / C 的数值 | **不能**。落库、有 cursor、可审计，但不投递 |
| `tools()` — `mood_peek` / `mood_trace` | 数值 | **只有主动调用才读得到** |
| `envPromptVars()` | 情境（举止 / 空气 / 距离） | 能读，但**不含任何数值** |

理由：一个可被模型完整读取的状态会降级成「提示」——模型可以选择忽略它、表演它、
或者拿它当题材。要让它真起作用，就必须让它读不到；但你又要能查，所以数值走事件库。

### 二、三个维度各有独立出口，互不混用

| 维度 | 出口 |
|---|---|
| `A` 唤起 | 举止（`bearing`） |
| `T` 张力 | 空气（`air`） |
| `C` 亲近 | 距离（`distance`）+ **主动开口的频率** |

任何一格若由两个维度共同决定，外部就分辨不出是哪个在动。
这条是「它是不是装饰」的分界线，`test/manual.mjs` 里有专门的串扰检查。

### 三、不碰 persona

这里没有一句人格、语气或说话方式。Coopanion 的插件不该改用户的 bot。

## 增量模型：权重 + 归一化

不写 `T +0.30` 这种绝对值。事件只声明**方向**和**权重**：

```
增量 = STEP × (w / W_MAX) × 剩余空间
```

`剩余空间` 往上走看还有多少到 1，往下走看还有多少到 0 —— **饱和是数学自带的，不用额外规则**。

| 事件 | 方向 | 权重 |
|---|---|---|
| 模型调用失败 | `T +1` | 3 |
| 推送被清空 | `T +1` | 2 |
| 一轮结束 | `A −1, T −1` | 1.8 |
| 开始执行工具 | `A +1` | 1.2 |
| 开始生成 | `A +1` | 1 |

**只有 3 : 1 那个比例有依据（负面偏差），其余是给的。** 但至少权重之间可以比较，
绝对值之间不能。

## 衰减：按真实时间，不按轮次

| 值 | 半衰期 | 生理参照 |
|---|---|---|
| `A` | 3 分钟 | 儿茶酚胺 1–3 分钟 |
| `T` | 20 分钟 | 急性压力主观恢复 |
| `C` | 90 分钟 | 皮质醇 60–90 分钟 |

桌宠常驻，所以墙钟时间是真时间。无状态会话里做不到——那里只能用轮次，
会和生理数据差两个数量级。

## 主动性

`C` 决定主动开口频率：`间隔 = max(nudgeFloorMs, nudgeBaseMs / (0.25 + C))`。

C=1 约 8 分钟，C=0 约 40 分钟。另有两道闸门：模型正在生成或工具正在跑时不插话；
对话后 4 分钟内不插话。推出去的正文只说环境，**从不替她说话**。

## 工具

- **`mood_peek`** — 三个值 + 三行情境。带 `snapshot` 标签，交接时只保留最后一次。
- **`mood_trace`** — 最近 N 次变化：原因、权重、各自变化量、变完的值。
- **`mood_touch`** — 主动小幅调整（每项最多 ±0.15），必须给理由。这是她的主体性。

## 配置

```json
{
  "worlds": {
    "mood": {
      "enabled": true,
      "halfLifeA": 3, "halfLifeT": 20, "halfLifeC": 90,
      "noticeAt": 0.6, "maxTrace": 40, "touchLimit": 0.15,
      "nudgeBaseMs": 600000, "nudgeFloorMs": 180000, "nudgeIdleMs": 240000
    }
  }
}
```

## 状态文件

`<dataDir>/mood-state.json`。删掉就从头开始（A .3 / T .2 / C .4）。存档坏了自动回落。
v1 存档（没有 `w` / `lastActiveAt`）会被自动补全。

## 零安装验证

这台机器上没装 `git` / `pnpm`，但依赖不需要安装：`node_modules/` 里四个 **junction**
指向 `cortico-world-bili-video-pro/node_modules`（cortico 0.2.8 / typescript / tsx / @types），
零字节复制。所以下面三条都能直接跑：

```bash
npm run typecheck      # 真 tsc，不是语法检查
npm run test:manual    # 19 项纯函数与增量数学检查
npm run check:describe # 干装载 + describe.json 一致性
npm run verify         # 上面三条串起来
```

**发布时这些东西都不进包**：`files` 只收 `src` / `assets` / `dist` / `describe.json` /
`README.md` / `package.json`。用户装上就能跑，只需要 Node。

## 已验证 / 未验证

**已验证（本机实跑）**
- `tsc -p .`：**0 error**
- `test/manual.mjs`：19 项全通过（含三通道串扰、饱和单调性、权重比 3:3、v1 存档兼容）
- `build-describe.mjs`：**干装载成功**，`describe.json` 与源码一致（3 工具 / 3 事件 / 1 段提示词）

**未验证**
1. `tick()` 的定时器只在干装载里起过一次，**没有真实空闲期跑过**。
2. `deliver: false` 按契约实现，**没在运行实例上看过"模型确实读不到"**。
3. nudge 的 10 / 3 / 4 分钟**是拍的**，只能装上去试。
4. 没有 `webUiClient`：面板声明在，`dist/webui.js` 未构建。
5. `check:extension` 的完整流程（扩展市场标签词表）需要网络，未跑。

## 第三级验证（只有开发者能看）

装进实例，故意让模型调用失败一次，看她在接下来几分钟有没有变紧，
再调 `mood_trace` 对一条 `w3` 的记录。


## 改 UI 之后必须 bump 版本

Cortico 给扩展 bundle 的响应头是：

```
Cache-Control: public, max-age=31536000, immutable
```

URL 形如 `/assets/extensions/cortico-world-mood/<版本>/webui.js`。**版本不变，浏览器就永远用缓存的那一份** —— `immutable` 连 Ctrl+F5 都能挡住。

所以改完 `src/webui/client.ts` 重建之后：

1. 把 `package.json` 的 `version` 加一位（0.3.0 → 0.3.1）
2. 重新部署
3. 重启 Coo

否则会看到「面板产物中没有 xxx / 可用面板：yyy」这种错 —— 那是加载到了旧 bundle，不是代码坏了。

判断方法：直接请求 `/assets/extensions/<包名>/<当前版本>/webui.js`，看返回内容里有没有新加的东西。服务端对旧版本 URL 会继续 200，对新版本 404 直到重启。

## 源图

制作用到的原图（头像、图标的原始尺寸版本）不在包里，避免带着 100 KB 用不上的东西发布。
需要改图时从 `..\cortico-world-mood-assets\` 取：`avatar.jpg`（1080×1080 原图）、`icon-src.png`（像素心原图）。
改完头像：用 Python + Pillow 裁切压缩后重新生成 `src/webui/avatar.ts`；改完图标：生成 128×128 透明 PNG 存成 `assets/icon.png`。

