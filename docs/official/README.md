# 官方数据附带包（2026-09-20 加入）

> 这些文件来自官方 APK **1.1.1**（versionCode 231）、官方 CDN 与设备运行时缓存，
> 用于把旧项目缺的官方内容补齐。
> 采集环境与「明确不做」的事见 `PROVENANCE.md`。

> 本目录还有一份 **`REFERENCES.md`**：官方数据的来源路径（模拟器/安装根/CDN）、
> 其他莱莎重构项目（AgentAtelierR / Atelier R'Coagula）的本地副本与可取之处、
> 官方 UI 截图对照表、以及世界地图的关键事实。**要更新内容前先看它。**

## 1. 加入了什么

| 路径 | 内容 | 来源 | 对客户端的影响 |
|---|---|---|---|
| `web/assets/spine/crf_chr_002/crf_skn_002_000{2,3,4,5}_01/` | **官方 4 款付费皮肤**（每套 atlas/png/skel/gesture 四件） | 官方 CDN（Firebase Storage，公开可读），逐文件与 `masters_bundle` 记录**字节数一致**、zip 的 **sha256 与官方记录一致** | 新增可用服装（需在 UI 里挂出来） |
| `web/assets/spine/crf_chr_002/crf_skn_002_0001_0{1,99}/` | 两款原装皮肤（从官方档案重新解出，与包内资产逐字节相同） | 官方 CDN | 无变化（用于交叉验证档案完整性） |
| `web/assets/images/login_background_*.jpg`（6 语） | 官方 1.1.1 版登录背景（同分辨率 1875×1999，压缩不同） | APK 1.1.1 | **已生效**（纯画质升级） |
| `web/assets/spine/crf_chr_002/*/*_gesture.rev2.json` | 官方 1.1.1 动作表（原始副本，便于 diff） | APK 1.1.1 | **可覆盖使用**，见 §3 |
| `docs/official/masters_bundle.json` | 官方服务器数据缓存（任务板/皮肤名册/代币档位） | 设备 `/data/data/.../files/` | 不影响运行 |
| `docs/official/official_ja_texts.tsv` | 官方日语 UI 文本 **2269 条** | `libapp.so` 提取 | 不影响运行 |
| `docs/official/official_symbols.txt` | 官方 Dart 符号 **46,433 个** | `libapp.so` 提取 | 不影响运行 |
| `docs/official/official-data-schema.md` | 官方数据结构施工图（脚本生成） | 官方资产 | 不影响运行 |
| `docs/official/PROVENANCE.md` | 采集环境与出处 | — | — |

## 2. 皮肤档案：怎么来的、怎么验的

官方 6 款皮肤的档案路径写在服务器下发的 `masters_bundle.json` 里
（`asset.archive.path` = `spine/crf_chr_002/<id>/r<rev>.zip`，并带 `sha256` 与逐文件字节数）。

- **可下载**：官方 Firebase Storage 桶对这些档案是**公开可读**的（实测 HTTP 200）；
  只有 API（`api.craft.spiral-ai-app.com`）需要 `Authorization: Bearer`
- **已逐项校验**：6 个 zip 的 sha256 与 `bytes` 与官方记录**完全一致**；zip 内 4 个文件的
  字节数也与官方记录完全一致
- **交叉验证**：两款免费皮肤（`_0001_01` / `_0001_99`）在 APK 里也有，
  **zip 内文件与包内资产逐字节相同** —— 证明档案与包内资产是同一份东西
- 脚本：`python scripts/verify_skins.py`（可随时复跑复核）

> ⚠️ 这些是**官方付费内容**，本项目只做本地自用、不实现购买、不再分发。
> 请勿把这些文件打进任何安装包分发。

## 3. 动作表：1.1.1 是「两套注视结构并存」，不是替换

实测对比（1.1.1 vs 本项目原来的 1.0.2）：

| 结构 | 1.0.2 | 1.1.1 |
|---|---|---|
| `emotionalGesture.DriverDefs`（旧注视驱动，98 条） | 有 | **仍有** |
| `tensionProfiles[].ambientBindings`（旧绑定） | 有 | **仍有** |
| `emotionalGesture.AttitudePatterns`（57 条） | 无 | **新增** |
| `emotionalGesture.GesturePatternDefs`（21 条） | 无 | **新增** |
| `projectConfig.ambientGaze`（31 参数） | 无 | **新增** |

**推论**：把 `*_gesture.json` 换成 1.1.1 版**不会打断现有注视逻辑**
（旧的 `DriverDefs` 与 `ambientBindings` 都还在，值也一致——唯一差异是
`armInOutPartConfig.byGroupId` 的键顺序，无行为影响）。
因此 `*_gesture.rev2.json` 只是原始副本；要换只需覆盖同名文件。

新模型（`AttitudePatterns` × `GesturePatternDefs` × `ambientGaze`）是官方现在的注视方式，
旧代码用不到它；迁移方案见重建项目 `ryza-ai-chat-revive-official/web/js/gaze.js`
与 `docs/official/official-data-schema.md` 第 6 节。

## 4. 可直接拿来用的官方数值

### 4.1 任务板（`masters_bundle.json` → `mission_groups` / `missions` / `activities`）

官方是 **3 组 × 4 条**，按天开启：

| 组 | 开启日 | 组奖励 | 组内 4 条任务 |
|---|---|---|---|
| `crf_msng_001` | 第 0 天 | 4 点 → `voice_token` 100 | 完成 3 次任务 / 触摸莱莎 1 次 / 与角色对话 5 次 / 领取登录奖励（连续 1 天） |
| `crf_msng_002` | 第 3 天 | 同上 | 同上（登录奖励需连续 3 天） |
| `crf_msng_003` | 第 5 天 | 同上 | 同上（登录奖励需连续 5 天） |

任务源活动（`activities`，共 10 个）：`app_launched` / `login_streak` / `alarm_created` /
`app_shared` / `memory_viewed` / `profile_edited` / `subscribed` / `talk_response_received` /
`talk_sent`（带 `resource_id`）/ `voice_token_purchased`。

> 项目现在的欢迎任务界面是自造的 5 格流程；若要一比一，应按上表改成 3 组 × 4 条。

### 4.2 皮肤名册（`skins`，共 6 款）

| id | 官方名（zh_TW） | 价格 | 解锁 | ASMR | 姿势 | rev | 本体 |
|---|---|---|---|---|---|---|---|
| `crf_skn_002_0001_01` | 鍊金術士採集服 | 1850 | 购买 | ✓ | sitting | 2 | 包内 + CDN |
| `crf_skn_002_0001_99` | 基本款 | 0 | 免费 | ✗ | standing | 2 | 包内 + CDN |
| `crf_skn_002_0002_01` | 歡樂陽光 | 1850 | 购买 | ✓ | sitting | 3 | **已加入** |
| `crf_skn_002_0003_01` | 夜色人魚 | 0 | 订阅 | ✗ | sitting | 3 | **已加入** |
| `crf_skn_002_0004_01` | 小心噗尼出沒！ | 1850 | 购买 | ✓ | sitting | 4 | **已加入** |
| `crf_skn_002_0005_01` | 夏日海灘 | 1850 | 购买 | ✓ | sitting | 3 | **已加入** |

### 4.3 官方 UI 文本（`official_ja_texts.tsv`）

2269 条官方日语原文（含 62 个 `Translations<模块><语言>` 分类，模块清单可搜
`official_symbols.txt` 里的 `Translations`）。用途：把自译文案换成官方原文。

> 注意：从 AOT 快照提取的文本含少量**残片**（相邻数据拼接造成的乱码片段），
> 单条使用前建议人工过一眼；完整句子可直接用。

## 5. 复刻完整度自检（旧代码读了哪些官方字段）

`scripts/audit_gesture_fields.py`（在重建项目里）扫出：官方 rev1 动作表的 62 个字段里，
本项目旧代码**完全没读**的有 13 个，其中值得注意的：

| 未读字段 | 它是什么 | 影响 |
|---|---|---|
| `SittingSets`（4 条，含 `sitting_agura` 与权重 99999/0 的切换表） | 坐姿变体（正坐/盘腿）之间的切换与合法组合 | 现在只能显示一种坐姿，盘腿姿势没有入口 |
| `SittingMandatorySlots`（1 条：`sitting_agura` → `leg` 槽强制） | 盘腿时腿部槽必须用专用动画 | 与上一条配套 |
| `armInOutJointCrossfade` / `armInOutSplitRatio`（0.4） | 手臂「经过中间姿势」路由的交叉淡入与分割比例 | 手臂换位时更生硬 |
| `Timelines`（空数组）/ `performanceConfig` / `schemaVersion` / `version` | 元数据或空表 | 无影响 |

（另外 `AttitudePatterns` / `GesturePatternDefs` / `ambientGaze` 属 1.1.1 新增，旧代码不读是预期内的。）
