# official/runtime —— 运行时数据来源说明

这些文件**不在 APK 里**，是官方 App 在设备上运行后落盘的数据。
它们证明「官方服务器下发了什么」，但**只在本地自用，不得再分发**。

## 采集环境（本轮）

| 项 | 值 |
|---|---|
| 官方 App | `ai.gospiral.atelierryza` versionName **1.1.1**，versionCode 231 |
| 设备 | MuMu 模拟器 Android 12（x86_64，ABI armeabi-v7a，root 可用） |
| adb | 模拟器自带的 `adb.exe`（本机绝对路径不入库；设备 `127.0.0.1:16416`） |
| 采集方式 | `adb exec-out "su 0 cat <路径>"`（只读，未修改设备任何数据） |
| 采集时间 | 2026-09-20 |

## 文件清单

### masters_bundle.json

- sha256：`64a615ec256ab33bcc91a1c80223636df42ad1769436d0ab14aa7c95068c2a24`
- bytes：17351
- 设备路径：`/data/data/ai.gospiral.atelierryza/files/masters_bundle.json`
- 性质：官方 `/v1/masters` 的本地缓存，带 `etag = c1acac6c41b34fc9bba4e963c25c5a3cdcdf8a22b41db52650cdc827f9314905`
- 内容：
  - `characters`：1 位（`crf_chr_002` 萊莎，default_skin `crf_skn_002_0001_99`，含 6 语言的 drama_id）
  - `skins`：**6 款**（含 `price` / `unlock_type` / `prompt_posture` / `asset.rev` / `archive.path` + `sha256` + 逐文件字节数）
  - `mission_groups`：3 组（`welcome_start_day` = 0 / 3 / 5，4 点换 100 `voice_token`）
  - `missions`：12 条（每组 4 条：`app_launched`×3 + `login_streak`×1）
  - `activities`：10 个活动类型
  - `token_packages`：7 档（`price` / `paid_quantity` / `free_quantity`）
  - `scenes`：空数组（0）

### masters_summary.txt

从上面那份 JSON 生成的人读摘要（由本轮脚本生成，非官方文件）。

## 对照价值（已验证，别再重复验）

- `_0001_01` / `_0001_99` 两款皮肤的 4 个文件，服务器记录的字节数与**包内资产逐字节一致**
  → 说明包内那两个皮肤资源与线上 rev 一致，唯一不一致的是 `*_gesture.json`（rev1 → rev2）
- `asset.rev` 说明官方有 `r<rev>.zip` 的档案化更新机制（`spine/crf_chr_002/<skin>/r<rev>.zip`）
- 4 款付费皮肤（`_0002_01` / `_0003_01` / `_0004_01` / `_0005_01`）的记录在表内，但**档案本体不在包内、
  也不在本仓库**（属官方 CDN + 账号权益，本项目不实现购买）

## 未采集（明确不做）

- 官方账号凭据：设备上 `shared_prefs/com.google.firebase.auth.*` 为 `ENCRYPTED:`（Flutter secure storage
  + Android Keystore），**不尝试提取**——那是拿账号凭证伪造客户端，越过本项目的边界。
- 官方服务端接口调用：`/v1/*` 全部要求 `Authorization: Bearer <Firebase ID token>`
  （实测：带正确 `X-Craft-App-Version: 1.1.1` 返回 `401 missing_bearer_token`），本项目不接官方服务器。
