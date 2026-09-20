# 方案：把 airi 的实时交互层移植进 ryza（不合并应用）

目标项目：`projects/ryza-ai-revive`（Ryza Chat v1.2.15）
参考项目：`moeru-ai/airi`（MIT）
评估日期：2026-09-18
配套阅读：[`../reports/airi-vs-ryza-ai-revive-assessment.md`](../reports/airi-vs-ryza-ai-revive-assessment.md)（先读那份，它论证了"不合并、不重写"）
相关：[`dsh-plugin-unification-design.md`](dsh-plugin-unification-design.md)（四方统合：把"莱莎世界"做成 MCP 插件给 agent 驱动）、[`../reports/ryza-vs-agentatelierr-feature-gap.md`](../reports/ryza-vs-agentatelierr-feature-gap.md)

---

## 0. 结论

**airi 的"实时交互栈"恰好是它 Vue-free 的那一层，而"你不需要的 UI/舞台"是耦合最重的那层。所以直接取前者，不要碰后者。**

airi 自己就写了一份抽取规格（`packages/provider-inference/docs/provider-inference-extraction-phase-1-spec.md`），里面明令禁止这批依赖进入 provider 层：`vue`、`vue-i18n`、`pinia`、`pinia-plugin-synced`、`@proj-airi/stage-ui`、`localStorage`、`indexedDB`、`document.cookie`。也就是说"可移植"不是我的推断，是上游的设计目标。

**必须先纠正一个前提**：airi **没有**你要的那种"打断"。

> `grep -r "barge"` 全仓 **0 匹配**。airi 的"打断"只有四种触发：**发送消息**、**按停止按钮**、**静音**、**切供应商**。麦克风检测到你说话时，角色的 TTS **不会停**（`onSpeechStart` 只是开始录音，播放继续）。它唯一做到"新语音压掉旧语音"的地方是**角色自己的主动发言**（spark 反应以 `priority:'high', behavior:'interrupt'` 开意图，压掉普通台词的 `priority:'normal', behavior:'queue'`）。

这个纠正很重要，因为它把结论反过来了：**真正的"你开口她就停"是你自己的原创工作量，airi 帮不上**——但它给的**底座**（意图优先级 + 每次播放一个 `AbortController` + `stopByIntent/Owner/All`）正是实现它需要的东西，而且它把"停 TTS"这件事的接口设计得很干净，值得照抄。

**方案一句话**：在 ryza 内新增 5 个模块（`providers.js` / `voice.js` / `turn.js` / `vision.js` / `proactive.js`），**游戏层一行不改**；实时层与游戏层之间只有两个接口——`Voice → App.say(text)` 和 `App → Turn.speak(text, {priority, behavior})`。

预期工作量：最小可用切片（语音输入 + 打断底座）**4–5 天**；完整五件套 **10–14 天**。

---

## 1. 能力盘点：airi 有什么、能不能搬

| airi 的能力 | 实现位置 | Vue-free? | 许可 | 你该怎么拿 |
|---|---|---|---|---|
| **TTS 提供商矩阵**（17 个可移植 TTS） | `packages/provider-inference/src/providers/{cloud,local}/` | ✅ 是（有抽取规格为证） | MIT | **抄描述符文件**（它们是配置对象 + 一个假 `fetch`），不需要装 airi |
| **STT 提供商矩阵**（5 个可移植 STT） | 同上，按 `tasks` 分；含 `browser-web-speech-api` | ✅ | MIT | 同上 |
| TTS/STT **调用** | `@xsai/generate-speech` / `@xsai/generate-transcription` / `@xsai/stream-transcription` | ✅ 公开 npm | **MIT** | 直接用 npm（可 esbuild 打成一个 vendor ESM） |
| **意图/播放管理器**（优先级、queue/interrupt/replace、AbortController、stopBy*） | `packages/pipelines-audio/src/{speech-pipeline.ts,managers/playback-manager.ts}` | ✅ 是（0 匹配） | MIT | **照抄语义自己写**（约 250 行），或构建后 vendor |
| **TTS 分句器**（流式长文按标点切块） | `packages/pipelines-audio/src/processors/tts-chunker.ts` | ✅ | MIT | 同上 |
| **VAD** | `@ricky0123/vad-web` + `onnxruntime-web`（airi 用 Pinia 包了一层） | 库本身 ✅ | **ISC** / MIT | 直接 npm + 自托管 worklet/模型（官方支持免打包） |
| **回声抑制（说话时禁麦）** | `apps/stage-tamagotchi/src/renderer/utils/voice-input-suppression.ts` | ❌ 在 Electron app 里 | MIT | 照抄（就一个常量 + 两个纯函数） |
| **自动发送（转写后延迟送）** | `packages/stage-layouts/src/composables/use-transcriptions.ts` | ❌ composable | MIT | 照抄行为 |
| **截屏感知** | `packages/electron-screen-capture/**`（只管选源）+ 30 行 `captureFrame` | ❌ Electron 限定 | MIT | **自己写**（`desktopCapturer` + canvas→JPEG，约 150 行） |
| **视觉接入 LLM** | `image_url` data URI 塞进消息 | ✅ 格式是标准 OpenAI | — | 自己写（格式简单） |
| **主动性（spark）** | `stores/character/orchestrator/store.ts` + `notebook.ts` + core-agent 的 spark agent | ❌ Pinia + agent | MIT | **照抄设计**，实现自己写（约 200 行） |
| **工具 / MCP** | `@modelcontextprotocol/sdk`（公开 MIT）+ `@xsai/tool` + `streamText` | 库 ✅ / 胶水 ❌ | MIT | 见 §3.6，**建议只取"按模型自动禁用 tools"这一个模式** |
| **电脑操作（computer use）** | `@auv-js/*` + `services/computer-use-mcp` | — | Apache-2.0 | ❌ **不要**：它自己的 README 写着 macOS-only |
| **记忆 / RAG** | 无 | — | — | ❌ 不存在（这正是你的强项） |
| **UI / 舞台 / 设置页** | `stage-ui` / `stage-pages` / `reka-ui` | ❌ Vue | MIT | ❌ **不要**（会毁掉你的官方 UI 一比一） |

净结果：**要拿的东西几乎都是"公开 npm + 一小段你本来就要写的胶水"**，而不是"airi 的黑箱"。

---

## 2. 架构：一条缝把实时层和游戏层分开

```
┌─────────────────── ryza 现有（不动） ───────────────────┐
│  avatar.js   场景/相机/姿态/热区/表情/口型               │
│  app.js      HUD / 面板 / 对话编排                       │
│  game.js quests.js daily.js world.js memory.js           │
│  api.js      LLM/TTS 协议 + <state> + 标签行             │
│  web/js/serve.py / desktop/main.js / AssetServer.java    │
│              /_proxy（已有契约，语音也走它）              │
└─────────────────────────▲────────────────────────────────┘
                          │  只有两个接口 ↓↑
        Voice ──transcript──▶ App.say(text)
        App  ──reply─────────▶ Turn.speak(text, {priority, behavior})

┌─────────────────── 新增：实时层（5 个模块） ─────────────┐
│  voice.js     麦克风 → VAD → STT → 半双工抑制 → 自动发送  │
│  turn.js      意图队列 + 播放管理 + 打断（唯一"谁在说"权威）│
│  providers.js TTS/STT/视觉 提供商表（含本地 VOICEVOX/Aivis）│
│  vision.js    截屏 → JPEG → image_url（桌面优先）         │
│  proactive.js 世界状态 → 主动意图（读 Game，不写 Game）    │
└──────────────────────────────────────────────────────────┘
```

三条必须守住的边界（否则会污染你 AUDIT §6.2 的高内聚）：

1. **实时层不读 `Game`**（`proactive.js` 除外，且只读）。`voice.js` / `turn.js` 不知道什么是体力、任务、地点。
2. **实时层不写状态**。`Game.applyDelta` 仍是唯一写入口。
3. **`turn.js` 是"谁在说话"的唯一权威**，`_bubbleHold/_bubbleKeep/_bubbleReveal` 与 `playUrl` 从它取状态，不再各自判断。

---

## 3. 模块设计

### 3.1 `turn.js` —— 底座，先写这个（约 250 行，2 天）

照抄 `pipelines-audio` 的语义（这是 airi 设计得最好的一块）：

```
IntentBehavior  = 'queue' | 'interrupt' | 'replace'
IntentHandle    = { intentId, turnId, priority, ownerId,
                    writeLiteral, writeSpecial, writeFlush, end, cancel(reason) }
API             = { openIntent, cancelIntent, interrupt, stopAll, on }
```

- **每次播放一个 `AbortController`**。`play(item, signal)` 里挂 `signal.addEventListener('abort', () => { source.stop(); source.disconnect() })`——airi 在 `Stage.vue` 里就是这么写的（30 行），而且这正是你现有 `App.playUrl` 需要的改造：你现在没有"中途停掉一个正在播的音频"的出口。
- **`stopByIntent / stopByOwner / stopAll`**：按意图、按属主、全部停。停止理由用枚举，airi 的定义可直接用：`'manual-chat' | 'manual-all' | 'muted'`，另加你自己的 `'provider-changed' | 'new-message' | 'unmount'`。
- **并发上限**：airi 的 `ttsMaxConcurrent` 默认 4、`maxVoices` 默认 1。你有 `MODE_PLAY_FX`（ASMR 变速不变调那段）——把它挂在 `play(item)` 里，不要挂在 `Turn` 外面，否则打断时会漏复位（你 AUDIT §8 明确写过 onended 必须复位 `playbackRate`）。
- **TTS 分句**：airi 的 `tts-chunker` 把长回复按标点切块、逐块合成 → 首句先响。你现在的 `speakThen` 是整段合成整段播。**这个改动单独拿出来就是体验提升**：长回复首字节延迟从"整段合成完"降到"第一句合成完"。

**顺带修掉一个已知 bug**：`turn.js` 的打断要真的能取消在飞的 LLM 请求，而你的 AUDIT §11.4 第 3 条写着 `Api.chat` **没有请求代际令牌**（重试条快速连发可乱序落账）。打断必须要有代际令牌，所以这一刀顺带把那个 bug 修了。注意 airi **自己也没做这件事**——它的 `chat-orchestrator-runtime.ts` 里那个 `activeSends` 的 `AbortController` 只被"会话清理/删除"调用，**没有被语音打断调用**。所以你在这点上会做得比 airi 对。

### 3.2 `voice.js` —— 语音输入（约 300 行，2–3 天）

**免打包方案已确认可行**：`@ricky0123/vad-web` 的官方用法就是 `<script>` 标签 + 显式资产路径：

```js
const myvad = await vad.MicVAD.new({
  baseAssetPath: '/vendor/vad/',        // 官方为免打包场景提供的选项
  onnxWASMBasePath: '/vendor/ort/',
  onSpeechStart: () => { ... },
  onSpeechEnd: (audio) => { ... },      // Float32Array, 16000 Hz
})
myvad.start()
```

要自托管的文件：`silero_vad_v5.onnx`（另有 `silero_vad_legacy.onnx`）、onnxruntime 的 wasm、vad worklet bundle。放进 `web/vendor/vad/`（和你现在的 `web/vendor/spine-webgl.js` 同一个位置、同一个思路）。

⚠️ **别照抄 airi 的 worklet 加载方式**：它用 Vite 专有的 `import workletUrl from '...?worker&url'`，普通 `<script>` 解析不了。你要走上面的显式路径。

**调参**（下面的值是 airi 实际配置，不是 vad-web 的默认值，可直接用作起点）：

| 参数 | airi 用的值 | 说明 |
|---|---|---|
| 采样率 | 16000 | vad-web 固定输出 16k |
| 语音阈值 | 0.52（stage-web 用 0.6） | 越小越敏感 |
| 退出阈值 | 阈值 × 0.3 | |
| 最短静音 | 1200 ms | **决定"说完"的手感**，手机端可能要调到 800–1000 |
| 语音前 pad | 360 ms | 防吃字头 |
| 最短语音 | 300 ms | 防咳嗽误触 |
| 自动发送延迟 | 2000 ms | airi 默认**关闭**自动发送；你大概也想要"填进输入框让玩家确认" |
| 流式转写空闲超时 | 15000 ms | |

**半双工抑制**（airi 的常量与逻辑，直接抄）：

```js
const DEFAULT_ASSISTANT_SPEECH_INPUT_COOLDOWN_MS = 800
shouldSuppressVoiceInput({ assistantSpeaking, suppressedUntil }, now = Date.now())
assistantSpeechCooldownDeadline(endedAt = Date.now(), cooldownMs = 800)
```

注意 airi 只在桌面 Electron 应用里做了这个（`stage-tamagotchi`），**没做进 `stage-ui`**。你有 `turn.js` 当"谁在说话"的唯一权威，所以你能做得比它干净：抑制条件就是 `Turn.isSpeaking()` 或冷却窗口未过。

**STT 路径分两级**：
1. 先做**零依赖版**：`browser-web-speech-api` 那一路（浏览器内置）——桌面 Edge/Chrome 可用，安卓 WebView 要看机型，得实测。
2. 再补**提供商版**：抄 `provider-inference` 的 `openai-audio-transcription` / `openai-compatible-audio-transcription` 描述符，走你已有的 `/_proxy`（一条新路由，不需要新基础设施）。这一路能覆盖 Whisper 兼容端点、MiMo、阿里云等。

**安卓注意**：`windowLayoutInDisplayCutoutMode` / 安全区那套已经处理过；新增的麦克风按钮必须遵守你自己的 AUDIT §7 规则——任何 `clientX − rect.left` 换算都要除以 `Avatar._cssZoom(el)`，否则桌面缩放下点不准。麦克风权限还要加进 `android/` 的 manifest。

### 3.3 `providers.js` —— 提供商表化（约 250 行，1–2 天）

这一刀你在评估报告里已经列为"该做"，airi 让它的形状变清楚了：**provider 描述符就是一个返回"OpenAI 调用参数"的函数**，TTS 返回 `{baseURL, model, fetch?, voice?}`，STT 返回 `{baseURL, model, fetch?}`；调用方永远是那两个公开函数（`generateSpeech` / `generateTranscription`），拿回 `ArrayBuffer` / 文本。

于是你的 `api.js` 里那堆按 provider 手写的分支，可以换成：

```js
// web/js/providers.js
export const PROVIDERS = {
  'openai-audio':        { kind:'tts', config:{apiKey:'',baseUrl:'https://api.openai.com/v1/'}, },
  'openai-compat-audio': { kind:'tts', config:{apiKey:'',baseUrl:''} },
  'voicevox':            { kind:'tts', config:{baseUrl:'http://localhost:50021/'} },
  'aivis-speech':        { kind:'tts', config:{baseUrl:'http://localhost:10101/'} },
  'openai-audio-stt':    { kind:'stt', config:{apiKey:'',baseUrl:'https://api.openai.com/v1/'} },
  // …按需从 airi 的 17+5 个描述符里挑
}
```

**抄描述符的价值**：airi 的 `voicevox` 描述符里有一段很聪明的写法——它注入一个假 `fetch`，忽略 OpenAI 形状的请求，直接调 VOICEVOX 引擎的两步 HTTP（`/audio_query` → `/synthesis`），于是"本地引擎"在调用方看来和云端点完全一样。你的三端 `/_proxy` 契约里，本地引擎反而更简单（同机直连、不用代理）。

**为什么 VOICEVOX / AivisSpeech 值得优先**（airi 的清单里对你最有用的两个）：

- **日语原生**，声音目录直接标 `languages: [{code:'ja'}]`——对一个日语角色的离线音色来说，这比 Kokoro 靠谱得多。
- **本地 HTTP 服务**（`localhost:50021` / `localhost:10101`），不联网、不计费，符合你 local-first 的定位。
- 代价：玩家要自己装引擎（对自用项目不是问题）。
- airi 还带 `fetchEngineVersion` / `fetchSpeakers` 做可达性探测（5s 超时、15s 间隔）与声音目录拉取——正好对应你设置页需要的"测试连接 + 音色下拉"。

⚠️ **Kokoro 别急着上**：它在 airi 里是 in-process WASM/WebGPU（`kokoro-js`，Apache-2.0），但耦合在 `stage-ui` 里且带一个 worker；日语质量要自己试听。

⚠️ **unspeech 要么不用、要么看清许可**：它的 **npm SDK 是 MIT，但那个 Go 服务端是 AGPL-3.0**（README 的 License 段落指的是服务端）。既然你有自己的 `/_proxy`、也打算直连各家端点，**直接跳过 unspeech**，别为了省事引一个 AGPL 的网关进来。

### 3.4 `vision.js` —— 截屏感知（约 150 行，2 天，桌面优先）

airi 的 `electron-screen-capture` 包**并不截屏**——它只做"选源"：`desktopCapturer.getSources()` + `session.setDisplayMediaRequestHandler()`。真正的抓帧是 30 行：

```js
function captureFrame(video, quality = 0.82, maxWidth = 1280, maxHeight = 720) {
  // canvas → toDataURL('image/jpeg', quality)
}
```

喂给模型的格式就是标准 OpenAI 多模态：`{ type: 'image_url', image_url: { url: dataUrl } }`。落到你的架构里：

- `desktop/main.js` 加 `desktopCapturer` + `setDisplayMediaRequestHandler`（Electron 主进程，约 60 行）。
- 抓帧在渲染进程（`web/js/vision.js`），复用你现成的画布缩放/`_cssZoom` 逻辑。
- `api.js` 加一条"带图请求"，走**单独的视觉模型槽位**（airi 也是分开配的：`settings/vision/active-provider` / `active-model`）——不要假设玩家的聊天模型支持视觉。
- 安卓：`MediaProjection` 是另一套活（要前台服务 + 用户授权），**先不做**。

**这个功能在你的项目里有个特别合适的落点**：她能"看见"你正在看的画面。但要小心它和你的"一比一"原则的关系——它是**新功能**，不是源包功能，所以应该像你的 NSFW 变体、作弊模式、时间流逝那样，明确登记为"本地扩展"，别混进"源包一比一"那份清单。

### 3.5 `proactive.js` —— 主动性（约 200 行，2–3 天）

airi 的 spark 系统完整可抄，参数如下：

| 组件 | airi 的实现 |
|---|---|
| 任务表 | `ScheduledTask { priority: 'low'\|'normal'\|'high'\|'critical', status: 'queued'\|'scheduled'\|'done'\|'dropped', dueAt? }` |
| 调度器 | `setInterval` **2000 ms** tick；到期窗口 **60000 ms**；失败重排延迟 **30000 ms** × **最多 3 次** |
| 事件 | `spark:notify { kind:'reminder', urgency, headline, note, destinations:['character'], payload }` |
| 反应 | spark agent 产出文本 → **以 `priority:'high', behavior:'interrupt'` 开意图** ⇒ 角色主动开口会**压掉当前正在说的台词** |
| 普通台词 | `priority:'normal', behavior:'queue'` |

**你这里比 airi 强的地方在于"什么触发它"**。airi 的触发源是任务表 + 插件推送；你的触发源是**世界状态**：体力见底、任务到期、每日登录里程碑、闹钟、时段变化（`real`/`flow` 时钟）、NPC 出现在同一地点、刚搬家、背包满、出航解锁。

关键纪律：`proactive.js` **只读** `Game.s` / `World` / `Quests` 的公开查询，产出意图交给 `turn.js` 播；**不写状态**。要推进游戏态就让 LLM 走既有的 `<state>` 通道——否则你会破掉"`applyDelta` 是唯一写入口"这条你守了很久的线。

### 3.6 工具 / agent —— 建议只取一个模式

你的 AUDIT §13 明确决定"不上 tools"（自填的 OpenAI 兼容端点不一定支持 function call）。这个决定是对的，**airi 的经验恰好证明它是对的**：airi 的 `llm-service.ts` 里有一串按供应商匹配的错误串，用来在端点不支持 tools 时**自动禁用**：

```
/does not support tools/i          // Ollama
/unrecognized request argument.+tools/i   // Azure AI Foundry
/tools?\s+(is|are)\s+not\s+supported/i    // Cloudflare Workers AI
```

所以如果你以后要加工具，**唯一正确的做法是"能力探测 + 按模型键记忆禁用"**，而不是"假设端点支持"。除此之外，MCP（`@modelcontextprotocol/sdk`，MIT，只支持 stdio 子进程传输）对你更有价值的方向是**反向的**：做一个 MCP server 把你的世界状态（`game_state` / `world_map` / `inventory`）暴露出去，让别的 agent 能读——这不会污染你的 LLM 协议，是个干净的增量。

---

## 4. 打断（barge-in）的具体设计 —— 这部分是原创

airi 没有，所以要自己写。但设计已经被它的底座约束好了：

```
状态：idle → listening → thinking → speaking → (idle)

speaking 期间 onSpeechStart 触发：
  ├ 先不立刻停（防咳嗽/环境噪声误触）
  ├ 等 minSpeechMs(300) 通过 + 能量高于"播放泄漏基线"
  ├ 通过 → Turn.interrupt('user-barge-in')
  │         ├ abort 当前播放的 AbortController → source.stop()
  │         ├ cancelIntent(当前, 'user-barge-in')（未播的块全丢）
  │         ├ 代际令牌 +1 → 在飞的 LLM 请求 abort（顺带修 AUDIT §11.4-3）
  │         └ 转 listening，等 VAD 判停 → STT → App.say()
  └ 未通过 → 什么都不做（VAD misfire）
```

**三个真实的坑，必须一起解决，否则会变成一个"老是抢话"的坏功能**：

1. **回声**：音箱放 TTS 时麦克风会听见，如果不处理，她自己每说一句就会打断自己。
   - `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`（大多数平台能压住）；
   - 加**自适应能量基线**：播放期间的 VAD 判定阈值要高于"当前播放音量对应的泄漏水平"，airi 用的是固定阈值 + 干脆禁麦 800 ms（更保守，但也就没有真打断）；
   - 兜底：**首句保护窗口**（例如开始播后的 600–800 ms 内不响应打断，避免句首被自己的起音触发）。
2. **误触**：键盘声/音乐/环境音。靠 `minSpeechMs` + `minSilenceMs` + 双阈值（进入 0.52 / 退出 0.16）压。
3. **打断后的一致性**：`turn.js` 是唯一权威，所以 `_bubbleHold/_bubbleKeep/_bubbleReveal`、`playUrl` 的 `playbackRate` 复位（ASMR 那条）、口型驱动必须**都从 `Turn` 的 stop 事件走同一个出口**。你 AUDIT §3.9 里 `_pokeUnmuteReady()` 那套"两处共用一个出口条件"的做法，照这个模式做。

**建议加第 7 套回归 `voice_regression.js`**，用你 `motion_regression` 那套播种时钟（xorshift32）的写法，headless 驱动 `turn.js` 断言：

- `behavior:'interrupt'` 且优先级 ≥ 当前 → 旧意图被 cancel、旧 `AbortController` fired；
- 优先级更低 → 只能排队，不能抢；
- `stopAll('muted')` 后没有任何 pending 播放泄漏；
- 打断后 `playbackRate` / 口型 / `_bubbleKeep` 全部复位（防你 AUDIT §8 那个 `IndexSizeError` 类问题复现）。

---

## 5. 落地顺序（按性价比）

| 序 | 内容 | 工时 | 为什么这个顺序 |
|---|---|---|---|
| 1 | `turn.js` + `api.js` 代际令牌 | 2–3 天 | **底座**。做完立刻拿到"能中途停掉 TTS"和修掉已知 bug；也是后面所有模块的地基 |
| 2 | `voice.js`（先 Web Speech 零依赖版）+ 麦克风按钮 | 2 天 | 你**唯一完全空白**的大功能 |
| 3 | `providers.js` + 抄 VOICEVOX/AivisSpeech 描述符 | 1–2 天 | 本地日语离线音色 + 消灭"切端点串凭据"那类 bug |
| 4 | 真 barge-in（VAD 触发打断） | 1–2 天 | airi 都没有，这是差异化体验；依赖 1+2 |
| 5 | `proactive.js` 接体力/任务/每日登录/闹钟 | 2–3 天 | 从"聊天客户端"变成"住在世界里的角色" |
| 6 | `vision.js`（桌面截屏 → 视觉模型） | 2 天 | 加分项，桌面优先 |
| 7 | 第 7 套 `voice_regression.js` | 与 1/4 一起 | 守住上面所有"别退回去" |

**最小可用切片 = 1 + 2**（4–5 天），就已经解决了你最初抱怨的两件事：能说话、能打断。

---

## 6. 创新点在哪（回答"是不是没啥能创新的了"）

你的担心是对的，但结论不是"没得做"，而是**你找错了对比对象**。

"通用陪伴 AI"这片确实挤满了（airi 49k star、SillyTavern、Neuro-sama 各种复刻），**而且这条路 airi 走得比你远**。但 airi 的陪伴有一个根本空缺：

- 它**没有世界**：没有经济、任务、背包、地点、时间、NPC、权威状态。它的记忆子系统**至今未实现**（官方 UI 自己写着暂不可用，`memory-pgvector` 是空壳，向量记忆还停在 issue 提案）。
- 它的截屏、电脑操作、Discord/Twitter 都是**通用工具**，不是"她活在一个世界里"。

你现在手里有的东西恰好补上这个空缺，而且是别人**结构上做不到**的：

1. **状态即记忆（state-grounded memory）**。她的记忆不该是向量汤，而应该是"我们在塔奥家门前，你昨天给了我一个苹果，任务 3 还差一次采集，今天第 2 天"。检索靠**世界状态**（在哪、见过谁、有什么、做到哪一步），不靠 embedding 相似度。这直接补上 airi 的空缺，而且是它没有 world state 就做不出来的。
2. **主动性由世界状态驱动**，不是通用 scheduler。体力见底她自己说、任务到期她提醒、傍晚她会提一句天要黑了——`proactive.js` 那 200 行接上你已有的 `Game`/`World`/`Quests` 就是独一份的东西。
3. **感知与世界融合**。她能看你屏幕，同时"知道自己在哪里"——这是 airi 的通用 vision 给不出的语境。
4. **实时交互发生在一个持续存在的世界里**，而不是一个聊天窗口里：打断、半双工、语音，全都作用在一个有存档、有进度、有时间流逝的角色身上。
5. **一比一的保真度本身是护城河**。你是对着官方 APK 的 203 个骨架、200 套场景、3609 个资源逐项核对过的；没人会再花这个成本做第二遍。

一句话：**"通用陪伴"打不过 airi，"住在一个被精确重建的游戏世界里的陪伴"目前没人做。** 你的差异化不是交互管线（那是可以抄的），是那个世界（那是抄不走的）。

---

## 7. 与"把 ryza 搬进 airi"的对比

评估报告里已经否决了三条搬入路线（iframe 扩展被"随机端口 ⇒ localStorage 存档不跨重启"堵死；用 airi 的 Spine 包会丢场景引擎；sidecar 只给聊天进出、不给语音输出/记忆）。这里补上**如果全押 airi 的真实成本**，供你对比：

| | 本方案（取管道） | 全押 airi（把 ryza 变 Vue 应用） |
|---|---|---|
| 改动面 | 新增 5 个模块，**游戏层一行不改** | 重写 `app.js` 2560 + `index.html` 328 + `app.css` 552 成 Vue 组件 |
| `avatar.js` 2827 行 | 不动 | 包成 Vue 组件（可行，但要停止和 airi 的 store 抢画布/循环） |
| 游戏逻辑 ~3,500 行（`game/quests/daily/world/memory`） | 不动 | 无 DOM 依赖，基本可原样搬 ✅ |
| 200 套场景 + 素材管线 + 6 套回归 | 不动 | 大体保留，但回归的宿主假设要重做 |
| **"官方 UI 一比一"** | 保留（你自己手写 DOM/CSS，逐像素比对过官方截图） | **要在一片别人的组件系统里重新挣一遍**，而且是持续成本 |
| **"安装包与源码逐文件哈希一致"** | 保留 | **失去**（引入 Vite 打包） |
| 工具链 | 无新增（照旧 `python scripts/serve.py`） | Node 23+ / pnpm / Vite；构建桌面版还要 VS2022 + C++ + rust-msvc |
| 上游风险 | 只抄 MIT 描述符，抄完就是你的 | 跟一个 0.12.0-beta、134 个 open PR、插件清单已改名一次的上游 |
| 安卓 | 现有 APK 流程不变 | 换 Capacitor（airi `stage-pocket`），你的 `build_apk.ps1` 与 `AssetServer` 要重做 |

结论：**全押 airi 换来的东西（UI 组件库、设置页、Capacitor）你都不缺，而失去的是你最贵的两项资产（官方 UI 保真 + 源码即产物的可验证性）。取管道则两样都保住。**

---

## 8. 许可与风险清单

| 项 | 状态 | 怎么办 |
|---|---|---|
| airi 的 provider 描述符 / pipelines-audio 语义 | **MIT**（Copyright (c) 2024-PRESENT Neko Ayaka） | 抄码需带 MIT 声明。放 `docs/third_party/` 或文件头注明来源 |
| `@xsai/*`（0.5.0） | MIT | 可 vendor |
| `@ricky0123/vad-web`（0.0.31） | **ISC** | 可 vendor，保留声明 |
| `onnxruntime-web` | MIT | 可 vendor |
| `kokoro-js` | Apache-2.0 | 可用，注意 NOTICE |
| **unspeech** | **SDK MIT / Go 服务端 AGPL-3.0** | **不用**（你有自己的 `/_proxy`） |
| `model-bank` | **npm 上 license 字段为 null**（未确认） | **不要抄**（airi 的 provider 描述符里若引用了它，抄的时候剥掉） |
| `@auv-js/*` / computer-use | Apache-2.0，**实际 macOS-only** | 不用 |
| Spine 运行时 | **不在任何 MIT 覆盖内**（Esoteric Spine Runtimes License，需自持 Spine Editor 许可） | 既有义务，与 airi 无关；核对一次自己是否持有 |
| airi 的 Live2D/VRM 预设模型 | 模型 zip 被 gitignore，仓库内无许可文本 | 不碰 |
| airi 的包是 `private: true` | 未发 npm | **别做依赖，抄描述符**；或 esbuild 自行构建 vendor |
| airi 上游在动 | 0.12.0-beta.5、134 open PR、manifest 改过名 | 抄完即冻结，不跟版本 |

**安卓侧新增体积**：`silero_vad_v5.onnx` 约 2 MB + onnxruntime wasm 数 MB。你的 `web/assets/` 已经 576 MB，体积不是问题，但新文件要记得进 `scripts/build_indexes.py` 的索引和 `pack_apk_assets.py` / `privacy_check.py` 的扫描面，否则打包会漏。

---

## 9. 下一步（如果要动手）

按 §5 的顺序，第一刀是 `turn.js` + `api.js` 代际令牌，因为：

- 它不依赖任何新素材/新依赖，纯 JS，能立刻用你的 6 套回归守住；
- 做完就能拿到"中途停掉 TTS + 修掉 AUDIT §11.4-3"；
- 之后的 `voice.js` / barge-in / `proactive.js` 全都挂在它上面。

第二刀是 `voice.js` 的零依赖版（浏览器 Web Speech），验证"麦克风 → 输入框 → `App.say()`"这条缝在三个宿主上都通，再决定要不要上 vad-web + 提供商版 STT。
