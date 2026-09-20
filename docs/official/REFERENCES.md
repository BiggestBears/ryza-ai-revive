# 外部参考索引：官方数据来源 + 其他莱莎重构项目

> 这份文档回答两个问题：**「官方数据从哪来、怎么重新拿一遍」** 和
> **「别人的莱莎项目在哪、能参考什么」**。
> 需要更新内容（加皮肤、改地图、对照 UI）时先看这里，别重复调研。
>
> 维护约定：本文件只记录**路径、来源、能取什么、坑**。具体做法写到对应的模块注释里。

---

## 1. 官方数据来源

### 1.1 模拟器里的官方 App（1.1.1）

| 项 | 值 |
|---|---|
| 模拟器 | MuMu，安卓 12（x86_64 / ABI armeabi-v7a，**root 可用**） |
| adb | 模拟器自带的 `adb.exe`（本机路径，按自己的安装位置填），设备 `127.0.0.1:16416` |
| 安装根 | `/data/app/~~jUZMRrX56Gr7NEks5PVP1w==/ai.gospiral.atelierryza-fNjMWARSOPyRKjTZsvpSrQ==/` |
| 数据根 | `/data/data/ai.gospiral.atelierryza/` |
| 版本 | versionName **1.1.1**，versionCode **231**，minSdk 24，targetSdk 36 |
| 包名 | `ai.gospiral.atelierryza` |

**安装根里有什么**（split bundle，不是一个 APK）：

```
base.apk                  244,702,903 B   资产主体（2767 个 flutter 资产）
split_ambient_pack.apk    138,309,399 B   环境音（74）
split_scene_pack_1.apk    110,558,607 B   场景 1（384）
split_scene_pack_2.apk    112,872,847 B   场景 2（384）
split_config.armeabi_v7a.apk  27,182,029 B  native 库（含 libapp.so）
split_config.en.apk / .mdpi.apk           语言/密度资源
```

**数据根里有价值的**：

| 路径 | 内容 |
|---|---|
| `files/masters_bundle.json` | **官方服务器数据缓存**（任务板 3 组×4 条、6 款皮肤名册含价格与 sha256、7 档代币、10 种活动） |
| `files/skin_cards/spine/crf_chr_002/<id>/card_r3.png` | 官方下载的皮肤卡（700×900，可当皮肤预览图） |
| `cache/craft_audio/` | 运行期解出的音频（与包内文件逐字节相同，只是缓存） |
| `app_flutter/chat/<会话>/crf_chr_002/1.json` | **加密**聊天记录（`craft-chat-v1` = kid+iv+ct） |
| `shared_prefs/FlutterSharedPreferences.xml` | 玩家侧设置（会话模式 story/text、语言 zh-TW 等） |

取文件的方式（**只读**）：

```bash
ADB="<模拟器目录>/adb.exe"        # 本机路径，按自己的安装位置填
# 文本/小文件
"$ADB" -s 127.0.0.1:16416 exec-out "su 0 cat /data/data/ai.gospiral.atelierryza/files/masters_bundle.json" > out.json
# APK（split 各自拉）
PKG="/data/app/~~jUZMRrX56Gr7NEks5PVP1w==/ai.gospiral.atelierryza-fNjMWARSOPyRKjTZsvpSrQ=="
"$ADB" -s 127.0.0.1:16416 pull "$PKG/base.apk" .
```
⚠️ **`adb pull` 的远端路径别用 Git Bash 的 `//` 风格**；写成上面这样（引号包住）即可。

### 1.2 官方 CDN 上的皮肤档案（公开可读）

服务器 `masters_bundle.json` 里每条皮肤都带 `asset.archive`：

```
path   spine/crf_chr_002/<skinId>/r<rev>.zip
sha256 与逐文件字节数
```

**Firebase Storage 桶对这些 zip 是公开可读的**（只有 API 要 token）：

```
https://firebasestorage.googleapis.com/v0/b/craft-prod-2026.firebasestorage.app/o/<URL编码的路径>?alt=media
```

已拉下来的 6 个（全部校验通过，与官方记录的 sha256 一致）：

| 皮肤 | 档案 | 字节 | 说明 |
|---|---|---|---|
| `crf_skn_002_0001_01` | r2.zip | 9,193,089 | 坐姿基本款，与包内资产逐字节相同 |
| `crf_skn_002_0001_99` | r2.zip | 5,298,772 | 站姿基本款，同上 |
| `crf_skn_002_0002_01` | r3.zip | 9,856,551 | 歡樂陽光 |
| `crf_skn_002_0003_01` | r3.zip | 9,507,657 | 夜色人魚（订阅） |
| `crf_skn_002_0004_01` | r4.zip | 10,546,263 | 小心噗尼出沒！ |
| `crf_skn_002_0005_01` | r3.zip | 9,726,319 | 夏日海灘 |

落地位置：`web/assets/spine/crf_chr_002/<skinId>/`（每套 atlas/png/skel/gesture 四件）。
**校验脚本**：`python scripts/verify_skins.py`（重建项目里有，比对本表 sha256）。

官方 API 本身（`https://api.craft.spiral-ai-app.com`）**全部要 `Authorization: Bearer`**，
实测带正确 `X-Craft-App-Version: 1.1.1` 也是 `401 missing_bearer_token`。
**不提取账号凭据、不伪造客户端**（设备上凭据是 Android Keystore 加密的 `ENCRYPTED:` 值）。

### 1.3 重建项目里的解包产物（可直接查）

参考项目的本机解包副本（路径随机器，本仓库只记形态不记路径）：

| 路径 | 内容 |
|---|---|
| `official/assets-1.1.1/` | 官方 3609 个资产 + `MANIFEST.json`（逐文件 sha256，可 `--verify` 复核） |
| `official/skins-1.1.1/*.zip` | 6 个官方皮肤档案原件 |
| `official/runtime/masters_bundle.json` | 服务器数据缓存 + `PROVENANCE.md`（出处与「明确不做」） |
| `official/libapp-1.1.1/` | `libapp.so` + 提取出的 **2269 条官方日文文本** + **46,433 个 Dart 符号** |
| `official/libapp-1.0.3/` | 上一版对照（提取结果，用于看版本差异） |
| `docs/official-data-schema.md` | 官方数据结构施工图（脚本生成，字段全部来自官方文件） |
| `reports/` | 官方文案索引、术语对齐、复刻核对、耦合度实测 |

本仓库（`ryza-ai-revive`）里的对应副本：`docs/official/`（masters/语料/符号/施工图/README）。

---

## 2. 其他莱莎重构项目（参考做法）

> **只取做法，不抄代码**（许可情况见每项）。

### 2.1 AgentAtelierR

| 项 | 值 |
|---|---|
| 来源 | `https://github.com/onion-aqua/AgentAtelierR` |
| 形态 | Dart / Flutter（**与本项目不同构**，代码不能直接用） |
| 许可 | **仓库内无 LICENSE 文件**；作者已确认有许可（用户与群主确认）。要抄代码先让作者在仓库里补声明 |
| 本地抓取副本 | `temp/repo/`（相对仓库根；93 个文件，**temp 可清理**） |

**它有什么值得看**（详见重建项目 `docs/reference-agentatelierr.md`）：

- **本地皮肤导入的完整校验规则**（≤64MB / ≤64 条目 / 拒 `..` 与符号链接 / 单页图集 /
  PNG 尺寸必须匹配 atlas 声明 / 骨架必须 Spine 4.2 / 必须含 `MotionGroups`）
- 动作与表情调度：80/20 探索、最近 5 组去重、语义动作 2.3s 让位、说话/闲置两套间隔
- 说话头部驱动（`control_roll_head` / `control_roll_neck` + 颈延迟）
- 口型参数（scrub_01、透明度 .56、速度 .82、20ms 包络帧、张口上限 55%）
- `docs/animation_dynamics.md` 里明确写了它**参考过本项目**（引用 `web/js/avatar.js` 与提交号）
- **它的地图标定表**：`lib/src/world_map_screen.dart` 的 `_fieldLayouts` / `_stageOffsets`
  —— 本项目 `worldmap.js` 里 `FIELDS`/`STAGES` 的来源（经 Coagula 转写）

⚠️ 它的资料**加密打包**（`.aarpack`），原始资产不入库 ⇒ **它那里拿不到皮肤素材**。

### 2.2 Atelier R'Coagula 0.9.0-beta.1

| 项 | 值 |
|---|---|
| 来源 | `<下载目录>/Atelier R'Coagula 0.9.0-beta.1.zip`（755,618,161 B，Electron 安装包） |
| 形态 | **Electron + 同一套 `resources/web/js/` 结构**（与本项目同构，最值得读） |
| 许可 | 包内只有 Electron/LICENSE.chromium，仓库许可未见 ⇒ 只取做法 |
| 本地解出副本 | 参考项目副本下的 `temp/coagula/web/`（**temp 可清理**） |

解出方式（zip 路径里有单引号和空格，用 Python 的 zipfile 更省事）：

```python
import zipfile, os
z = zipfile.ZipFile(r"<下载目录>\Atelier R'Coagula 0.9.0-beta.1.zip")
for n in z.namelist():
    if '/resources/web/' in n and not n.endswith('/'):
        t = 'web/' + n.split('/resources/web/')[-1]
        os.makedirs(os.path.dirname(t) or '.', exist_ok=True)
        open(t, 'wb').write(z.read(n))
```

**它比本项目多/做得更细的地方**（详见重建项目 `docs/reference-coagula.md`）：

| 文件 | 内容 |
|---|---|
| `js/crfstore.js` | 服装导入：IndexedDB 存 blob + **ZIP 自解析**（`DecompressionStream`）+ **atlas 贴图行是裸文件名**这个坑的解法 |
| `js/longmem.js` | 长期记忆：条目录 + 压缩摘要（本项目已按此合并实现 `longterm.js`） |
| `js/voicecache.js` | 语音片段缓存（已实现 `voicecache.js`） |
| `js/worldmap.js` + `js/worldpins.js` | **世界地图（本项目当前参照它 + 官方截图重做）** |
| `js/segments.js` | 说话人/译文分段（**本项目已合并进 `npc.js`，没有新增模块**） |
| `js/prompts.js` | 角色设定 / 世界设定两个可编辑槽 + 默认值 |
| `js/assetseal.js` | 资源解密（文件名派生 keystream；**本项目不采用**） |
| `avatar.js` | 玩家缩放（只放大，`ZOOM_MIN=1.0` 的实测理由） |

它自带 **8 套**服装目录（含官方名册外的 `_0006_01` 与 `_9007_测试_01`），
但 `.skel/.atlas/.png` 是**加密的**（文件名是内容哈希），**不能直接当素材**；
`_gesture.json` 是明文。

### 2.3 airi / N.E.K.O.（实时层参考，与素材无关）

| 项目 | 用途 | 备注 |
|---|---|---|
| `moeru-ai/airi`（MIT） | provider 注册表形状、意图/播放语义、TTS 分句、spark 主动性 | UI/舞台**不用**（Vue，会毁掉官方 UI 保真） |
| `Project-N-E-K-O/N.E.K.O`（Apache-2.0） | 断句/打断/回声/回合状态机的实测参数 | 抄代码需带 NOTICE |

详见 `docs/ryza-unification-architecture.md` 与 `docs/ryza-airi-realtime-layer-design.md`。

---

## 3. 官方 UI 对照（用截图核对形态）

用户提供的官方截图（**本机路径，供后续对照**）：

| 截图 | 内容 | 用途 |
|---|---|---|
| `<用户截图目录>/屏幕截图 2026-09-20 140421.png` | 官方**标题页**（RyzaChat 与莱莎共谱…, ver 1.1.1 (231)） | 标题页形态、右上角「選項/選單」 |
| `…140431.png` | 官方**世界地图·区域级**：铺满整屏、金色水滴标记 + 深色地名胶囊、数字角标、锁图标、「目前位置」红标、底部「庫肯島周邊地區 ▾ + 目前位置」 | 区域级布局 |
| `…140440.png` | 官方**区域选择弹层**：底部弹层、两列卡片（区域实景图 + 锁 + 底部一排 NPC 头像 + 名称）、当前区域挂「目前位置」 | 区域弹层的形态 |
| `…140447.png` | 官方**世界地图·地点级**：选中 field 用橙色描边圈出、圈外压暗、stage 标记带**角色头像**与地名胶囊、底部变成「‹ 小妖精森林 + 目前位置」 | 地点级布局 |
| `…140502.png` | 官方**侧栏展开**：右侧竖排「商店/服裝/存檔/全螢幕顯示/切換角色顯示/設定/返回世界地圖」（带图标圈），**其余控件（HUD/快捷钮）隐藏** | 侧栏与控件隐藏规则 |
| `…151827.png` | **本项目当时的坏状态**（侧栏菜单与缩放钮叠在一起） | 已修：`body.side-open` 时快捷钮让位 |

⚠️ **读这些截图会让某些上游模型报 400**（见 `docs/HANDOFF.md` 的「操作坑」）；
需要核对时优先用**文本探针**（元素计数/盒子尺寸/计算样式），本仓库已有三个：
`scripts/probe-map-dom.js`、`scripts/probe-map-labels.js`、`scripts/probe-ui.js`。

---

## 4. 地图实现的关键事实（别再重查）

| 事 | 事实 |
|---|---|
| 官方区域图 | `web/assets/world_map/areas/area_01..05.jpg`（5 张，2048×1152） |
| 官方地图 UI | `web/assets/world_map/ui/{area_pin,field_pin,field_pin_inactive,field_pin_ring,current_location,char_pin,dots}.svg` |
| **`current_location.svg` 是空气泡** | 190×72 只有形状没有字 ⇒ 「目前位置」必须用 HTML 叠上去（`i18n: world.current`） |
| 官方 SVG 的尺寸坑 | 这批 SVG 自带 `width="100%" height="100%"` ⇒ 必须 `!important` 锁尺寸，否则撑满整屏 |
| **标定数据只覆盖一部分** | `FIELDS` 37/38（缺 `field_05_012`）、`STAGES` **只有 10/120**（参考项目那张表里多数是 `[0,0]` 占位） |
| 兜底 | 没标定的用**确定性环形布局**（`WorldMap._fallbackFieldPos/_fallbackStagePos`），标定优先；来源可用 `pin.dataset.calibrated` 与 `WorldMap.coordSource(id)` 区分 |
| 地图铺满的代价 | 地图模式隐藏整个头部（`#view-world.map-mode .view-head{display:none}`）⇒ **列表/地图的切换键必须放在地图内部**（现为底部条 `.wmp-list`） |
| 验证脚本 | `scripts/verify-map-coverage.js`（5 区域 × field × stage 全覆盖 + 屏内）、`scripts/verify-map-fixes.js`（真鼠标点钉子 / 切区域 / 侧栏让位） |
