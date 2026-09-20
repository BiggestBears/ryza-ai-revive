# 官方运行时数据结构（施工图）

> 本文件由 `scripts/dump_data_schema.py` 从 `web/assets/`（官方 1.1.1 资产）自动生成。
> 所有字段名与取值都来自官方文件实测，没有一处是手写的；改数据请改官方文件并重跑本脚本。
> 逐文件哈希见 `official/assets-1.1.1/MANIFEST.json`。

## 1. `data/posture_camera.json` —— 姿态相机表

### `posture_standing`

```json
{
 "base": {
  "offsetX": 0.0,
  "offsetY": -346.153846,
  "scale": 1.4881573275862088,
  "cameraZoom": 1.45,
  "cameraPanX": 0.0,
  "cameraPanY": 1087.676934
 },
 "asmr": {
  "cameraZoom": 2.5,
  "cameraPanX": 0.0,
  "cameraPanY": 3390.992794
 }
}
```

### `posture_sitting`

```json
{
 "base": {
  "offsetX": 0.0,
  "offsetY": 288.461538,
  "scale": 1.0,
  "cameraZoom": 1.93,
  "cameraPanX": 0.0,
  "cameraPanY": 1218.837976
 },
 "asmr": {
  "cameraZoom": 3.5,
  "cameraPanX": 0.0,
  "cameraPanY": 3199.049805
 }
}
```

## 2. `data/stage_background_map.json` —— 舞台 → 背景套

- 条目数：121
- 去重后取值种类：50
- 样例 `stage_00_000_00`：`"stage_00_000_00"`

```json
"stage_00_000_00"
"stage_01_001_01"
"stage_01_001_02"
"stage_01_001_04"
"stage_01_001_05"
"stage_01_001_06"
"stage_01_001_08"
"stage_01_002_01"
"stage_01_002_02"
"stage_01_002_03"
```

## 3. `world_map/world_hierarchy.json` —— 世界层级

- 顶层键：`['areas']`
- 区域 5 个

| area | 名称 | fields | stages |
|---|---|---|---|
| `area_01` | クーケン島周辺地域 | 14 | 46 |
| `area_02` | クレリア地方 | 5 | 24 |
| `area_03` | ネメド地方 | 5 | 22 |
| `area_04` | 異界オーリム | 3 | 14 |
| `area_05` | 王都周辺地域 | 11 | 14 |

### 结构样例（`area_01`）

area 字段：['id', 'name', 'fields']

field 字段：['id', 'name', 'stages']

stage 字段：['id', 'name']

```json
{
 "id": "field_01_001",
 "name": "クーケン島",
 "stages": [
  {
   "id": "stage_01_001_01",
   "name": "尖塔の貯水池"
  },
  {
   "id": "stage_01_001_02",
   "name": "魔石の灯台"
  },
  {
   "id": "stage_01_001_04",
   "name": "ライザの家"
  },
  {
   "id": "stage_01_001_05",
   "name": "ヤギの放牧地"
  },
  {
   "id": "stage_01_001_06",
   "name": "憩いの広場"
  },
  {
   "id": "stage_01_001_08",
   "name": "水源の滝つぼ"
  }
 ]
}
```

## 4. `world_map/npc_placement.json` —— NPC 配置

- 顶层键：`['_note', 'npcs']`
- `_note`（官方原文）：キャラ配置マスタ_原案.xlsx 由来 (gen_npc_placement.py で生成)。ベース(%)＋移動%(エリア/フィールド/ステージ)＋同伴(%)の確率モデル。編集は xlsx 側 → スクリプト再生成。
- NPC 数：34

单条字段：['id', 'name', 'resolveOrder', 'companions', 'bases', 'move']

```json
{
 "id": "npc_ryza",
 "name": "ライザ",
 "resolveOrder": 1,
 "companions": [],
 "bases": [
  {
   "stageId": "stage_01_002_01",
   "pct": 100
  }
 ],
 "move": {
  "area": 0,
  "field": 0,
  "stage": 0
 }
}
```

| id | name | resolveOrder | companions | bases | move |
|---|---|---|---|---|---|
| `npc_ryza` | ライザ | 1 | - | stage_01_002_01=100% | {"area": 0, "field": 0, "stage": 0} |
| `npc_lent` | レント | 23 | [{"id": "npc_samuel", "pct": 3}] | stage_01_001_01=98%; stage_01_002_01=2% | {"area": 85, "field": 5, "stage": 5} |
| `npc_klaudia` | クラウディア | 29 | [{"id": "npc_ruberto", "pct": 5}] | stage_01_001_06=50%; stage_05_002_01=48%; stage_01_002_01=2% | {"area": 40, "field": 20, "stage": 30} |
| `npc_tao` | タオ | 2 | - | stage_05_002_02=50%; stage_05_002_01=48%; stage_01_002_01=2% | {"area": 60, "field": 20, "stage": 10} |
| `npc_empel` | アンペル | 3 | - | None=45%; stage_03_004_01=45%; stage_01_002_01=10% | {"area": 100, "field": 0, "stage": 0} |
| `npc_lila` | リラ | 24 | [{"id": "npc_empel", "pct": 75}] | None=45%; stage_03_004_01=45%; stage_01_002_01=10% | {"area": 100, "field": 0, "stage": 0} |
| `npc_boos` | ボオス | 26 | [{"id": "npc_moritz", "pct": 10}] | stage_01_001_08=98%; stage_01_002_01=2% | {"area": 40, "field": 20, "stage": 20} |
| `npc_moritz` | モリッツ | 25 | - | stage_01_001_08=100% | {"area": 20, "field": 40, "stage": 30} |
| `npc_agate` | アガーテ | 4 | - | stage_01_001_01=100% | {"area": 20, "field": 40, "stage": 30} |
| `npc_lumber` | ランバー | 32 | [{"id": "npc_boos", "pct": 20}, {"id": "npc_agate", "pct": 20}, {"id": "npc_mori | stage_01_001_08=100% | {"area": 20, "field": 40, "stage": 30} |
| `npc_karl` | カール | 27 | [{"id": "npc_samuel", "pct": 3}] | stage_01_001_04=100% | {"area": 5, "field": 20, "stage": 30} |
| `npc_mio` | ミオ | 33 | [{"id": "npc_karl", "pct": 50}, {"id": "npc_samuel", "pct": 3}] | stage_01_001_04=100% | {"area": 5, "field": 20, "stage": 30} |
| `npc_samuel` | ザムエル | 5 | - | stage_01_001_01=100% | {"area": 20, "field": 20, "stage": 30} |
| `npc_fressa` | フレッサ | 6 | - | stage_01_001_01=100% | {"area": 10, "field": 10, "stage": 40} |
| `npc_ruberto` | ルベルト | 28 | - | stage_01_001_06=70%; stage_05_002_01=30% | {"area": 20, "field": 20, "stage": 20} |
| `npc_kilo` | キロ | 7 | - | stage_04_001_01=100% | {"area": 10, "field": 10, "stage": 70} |
| `npc_romy` | ロミィ | 8 | - | stage_01_001_02=40%; stage_05_002_01=40%; stage_03_002_01=20% | {"area": 10, "field": 10, "stage": 20} |
| `npc_patricia` | パティ | 30 | [{"id": "npc_tao", "pct": 10}, {"id": "npc_volker", "pct": 10}] | stage_05_002_02=98%; stage_01_002_01=2% | {"area": 40, "field": 20, "stage": 20} |
| `npc_clifford` | クリフォード | 9 | - | stage_05_002_01=98%; stage_01_002_01=2% | {"area": 100, "field": 0, "stage": 0} |
| `npc_serri` | セリ | 31 | [{"id": "npc_clifford", "pct": 10}] | stage_04_001_01=98%; stage_01_002_01=2% | {"area": 70, "field": 10, "stage": 10} |
| `npc_fee` | フィー | 10 | - | stage_04_001_01=99%; stage_01_002_01=1% | {"area": 1, "field": 1, "stage": 68} |
| `npc_volker` | ヴォルカー | 11 | - | stage_05_002_02=100% | {"area": 30, "field": 20, "stage": 20} |
| `npc_zephine` | ゼフィーヌ | 12 | - | stage_05_002_02=100% | {"area": 20, "field": 20, "stage": 20} |
| `npc_dennis` | デニス | 13 | - | stage_05_002_04=100% | {"area": 10, "field": 10, "stage": 20} |
| `npc_cassandra` | カサンドラ | 14 | - | stage_05_002_03=100% | {"area": 20, "field": 20, "stage": 40} |
| `npc_kala` | カラ | 15 | - | stage_04_001_01=98%; stage_01_002_01=2% | {"area": 40, "field": 25, "stage": 25} |
| `npc_alberta` | アルベルタ | 16 | - | stage_02_002_04=100% | {"area": 20, "field": 30, "stage": 30} |
| `npc_saverio` | サヴェリオ | 17 | [{"id": "npc_alberta", "pct": 5}] | stage_02_002_03=100% | {"area": 20, "field": 30, "stage": 30} |
| `npc_anna` | アンナ | 18 | [{"id": "npc_alberta", "pct": 5}, {"id": "npc_saverio", "pct": 5}] | stage_02_002_01=100% | {"area": 10, "field": 30, "stage": 30} |
| `npc_dort` | ドルト | 19 | - | stage_03_002_01=100% | {"area": 10, "field": 10, "stage": 40} |
| `npc_deadra` | デアドラ | 20 | [{"id": "npc_dort", "pct": 5}] | stage_03_002_01=100% | {"area": 10, "field": 20, "stage": 40} |
| `npc_federica` | フェデリーカ | 21 | [{"id": "npc_alberta", "pct": 5}, {"id": "npc_saverio", "pct": 5}, {"id": "npc_a | stage_02_002_01=98%; stage_01_002_01=2% | {"area": 10, "field": 20, "stage": 60} |
| `npc_dian` | ディアン | 34 | [{"id": "npc_lent", "pct": 75}, {"id": "npc_dort", "pct": 5}, {"id": "npc_deadra | stage_03_002_01=100% | {"area": 25, "field": 25, "stage": 25} |
| `npc_korou` | 古老 | 22 | - | stage_01_001_01=100% | {"area": 1, "field": 9, "stage": 70} |

- `bases[].pct` 取值集合：[1, 2, 10, 20, 30, 40, 45, 48, 50, 70, 98, 99, 100]
- `move` 组合（去重）：

```json
{"area": 0, "field": 0, "stage": 0}
{"area": 85, "field": 5, "stage": 5}
{"area": 40, "field": 20, "stage": 30}
{"area": 60, "field": 20, "stage": 10}
{"area": 100, "field": 0, "stage": 0}
{"area": 40, "field": 20, "stage": 20}
{"area": 20, "field": 40, "stage": 30}
{"area": 5, "field": 20, "stage": 30}
{"area": 20, "field": 20, "stage": 30}
{"area": 10, "field": 10, "stage": 40}
{"area": 20, "field": 20, "stage": 20}
{"area": 10, "field": 10, "stage": 70}
{"area": 10, "field": 10, "stage": 20}
{"area": 70, "field": 10, "stage": 10}
{"area": 1, "field": 1, "stage": 68}
{"area": 30, "field": 20, "stage": 20}
{"area": 20, "field": 20, "stage": 40}
{"area": 40, "field": 25, "stage": 25}
{"area": 20, "field": 30, "stage": 30}
{"area": 10, "field": 30, "stage": 30}
```

## 5. `spine/scenes/<stage>/<stage>.json` —— 场景配置（200 个）

- 顶层键：`['id', 'name', 'config']`
- `config` 键：`['backgroundSpinePath', 'constraintOverrides', 'light', 'midgroundPostures']`

```json
{
 "id": "stage_01_001_01_aft",
 "name": "stage_01_001_01_aft",
 "config": {
  "backgroundSpinePath": "assets/scenes/stage_01_001_01_aft/spine/stage_01_001_01_aft.skel",
  "constraintOverrides": {
   "con_bg_far_01": {
    "translateMixX": 7.500000298023224,
    "translateMixY": 2.9999999329447746,
    "scaleMixX": 100.0,
    "scaleMixY": 100.0
   },
   "con_bg_far_02": {
    "translateMixX": 5.000000074505806,
    "translateMixY": 1.9999999552965164,
    "scaleMixX": 100.0,
    "scaleMixY": 100.0
   },
   "con_bg_far_03": {
    "translateMixX": 3.999999910593033,
    "translateMixY": 0.9999999776482582,
    "scaleMixX": 100.0,
    "scaleMixY": 100.0
   },
   "con_chara_root": {
    "translateMixX": 0.0,
    "translateMixY": 0.0,
    "scaleMixX": 100.0,
    "scaleMixY": 100.0
   }
  },
  "light": {
   "direction": 222.0,
   "color": 4284115290,
   "shadowEnabled": false,
   "rimEnabled": true,
   "rimFeather": true,
   "rimOpacity": 0.8,
   "rimGlowWidth": 12.0,
   "rimGlowPower": 2.4
  },
  "midgroundPostures": [
   "posture_sitting"
  ]
 }
}
```

## 6. `<skin>_gesture.json` —— 动作表（rev2，1.1.1 版）

- 顶层键：`['schemaVersion', 'id', 'name', 'atlasPath', 'skeletonPath', 'description', 'rigConfig', 'projectConfig', 'emotionalGesture', 'mouthOpenRatios']`
- `projectConfig` 键（31）：`['version', 'schemaVersion', 'generatorManaged', 'fixedBasePoseMode', 'lockSittingAxis', 'enableArmInOutRouting', 'fxOnAnimNames', 'fxOffAnimNames', 'hitPartNames', 'closedEyeAnimation', 'lookAtBoneHierarchy', 'tapReactionAnimation', 'tapReactionEnterMix', 'tapReactionExitMix', 'gazeReturnToFront', 'ambientGaze', 'windAnimationPrefix', 'postureKey', 'mixDurationSaturationRatio', 'armInOutSplitRatio', 'armInOutJointCrossfade', 'fingerTrackCenterBone', 'fingerTrackMaxRange', 'fingerTrackHeadThreshold', 'fingerTrackBodyThreshold', 'fingerTrackHeadScale', 'fingerTrackBodyScale', 'fingerTrackDelay', 'tensionConfig', 'lipSyncClosure', 'armInOutPartConfig']`
- `emotionalGesture` 键：`['AttitudePatterns', 'EmotionProfilesV4', 'GesturePatternDefs', 'MixDurationPoses', 'MotionGroups', 'PoseTypeSets', 'SittingMandatorySlots', 'SittingSets', 'TapReactions', 'Timelines', 'performanceConfig', 'schemaVersion']`

### 6.1 `projectConfig.ambientGaze`（31 参数）

```json
{
 "yawLimit": 0.8,
 "pitchUpLimit": 1.0,
 "pitchDownLimit": -1.0,
 "rollPlusLimit": 0.8,
 "rollMinusLimit": -0.8,
 "sizeSmall": 0.6,
 "sizeMedium": 0.85,
 "sizeLarge": 1.0,
 "dwellShort": 0.6,
 "dwellMedium": 1.5,
 "dwellLong": 4.0,
 "speedFast": 2.0,
 "speedNormal": 1.0,
 "speedSlow": 0.5,
 "widthRatioYaw": 0.55,
 "widthRatioPitch": 0.85,
 "moveBaseSeconds": 0.15,
 "centerHalfWidth": 0.3,
 "maxStrengthScale": 1.15,
 "curveBulgeRatio": 0.5,
 "rollDurationScale": 1.5,
 "headFollowDelay": 0.1,
 "bodyFollowDelay": 0.6,
 "followScaleStrong": 0.9,
 "followScaleMedium": 0.7,
 "followScaleWeak": 0.5,
 "followScaleOpposite": -0.2,
 "lookAtUserTau": 0.25,
 "bodyResetKeep": 0.5,
 "serverLookYawMagnitude": 0.7,
 "serverLookPitchMagnitude": 0.7
}
```

### 6.2 `GesturePatternDefs`（21 条）

字段：['bodyMovement', 'bodyTilt', 'description', 'directions', 'eyeMovement', 'faceMovement', 'patternId', 'points', 'route', 'tilts']

```json
[
 {
  "bodyMovement": "動かない",
  "bodyTilt": "傾けない",
  "description": "考える・思い出す",
  "directions": [
   "上",
   "斜め上"
  ],
  "eyeMovement": "指定方向",
  "faceMovement": "追従（弱）",
  "patternId": "A1",
  "points": 1,
  "route": "1点",
  "tilts": [
   "なし",
   "右",
   "左"
  ]
 },
 {
  "bodyMovement": "逆方向",
  "bodyTilt": "同方向",
  "description": "のけぞる・驚く",
  "directions": [
   "上"
  ],
  "eyeMovement": "指定方向",
  "faceMovement": "追従（強）",
  "patternId": "A2",
  "points": 1,
  "route": "1点",
  "tilts": [
   "なし",
   "右",
   "左"
  ]
 }
]
```

### 6.3 `AttitudePatterns`（57 条）

字段：['attitude', 'attitudeDescription', 'description', 'dwell', 'moveSpeed', 'oneShotAnimation', 'patternId', 'repeatMax', 'repeatMin', 'size', 'weight']

```json
[
 {
  "attitude": "talk_low",
  "attitudeDescription": "話している・気がない",
  "description": "普通に見る",
  "dwell": "中",
  "moveSpeed": "普通",
  "oneShotAnimation": "",
  "patternId": "D1",
  "repeatMax": 4,
  "repeatMin": 2,
  "size": "中",
  "weight": 0.4
 },
 {
  "attitude": "talk_low",
  "attitudeDescription": "話している・気がない",
  "description": "そっぽを向く",
  "dwell": "長",
  "moveSpeed": "遅い",
  "oneShotAnimation": "",
  "patternId": "A6",
  "repeatMax": 2,
  "repeatMin": 1,
  "size": "中",
  "weight": 0.1
 },
 {
  "attitude": "talk_low",
  "attitudeDescription": "話している・気がない",
  "description": "呆れる・うんざり",
  "dwell": "中",
  "moveSpeed": "普通",
  "oneShotAnimation": "",
  "patternId": "C2",
  "repeatMax": 2,
  "repeatMin": 1,
  "size": "中",
  "weight": 0.1
 }
]
```

### 6.4 `tensionProfiles.<band>.gaze`

字段：['gaze', 'torsoWaistGroupWeights']

```json
{
 "gaze": {
  "eyeModeEntries": [
   {
    "animationSpeed": 1.0,
    "intervalSeconds": 3.0,
    "jitterSeconds": 2.0,
    "mode": "blink",
    "weight": 0.7
   },
   {
    "animationSpeed": 1.0,
    "intervalSeconds": 3.0,
    "jitterSeconds": 2.0,
    "mode": "blinkFast",
    "weight": 0.2
   },
   {
    "durationSeconds": 1.5,
    "mode": "closed",
    "weight": 0.1
   },
   {
    "durationSeconds": 1.0,
    "mode": "open",
    "weight": 0.0
   }
  ],
  "gazeEntries": [
   {
    "direction": "lookAtUser",
    "holdSeconds": 3.0,
    "speed": "normal",
    "weight": 1.0
   }
  ],
  "motionModifiers": {
   "springDampingScale": 0.6,
   "springFrequencyScale": 1.5,
   "strengthScale": 1.3,
   "tempoScale": 1.4
  },
  "tremor": {
   "amplitude": 2.5,
   "enabled": false,
   "frequency": 5.0
  }
 },
 "torsoWaistGroupWeights": {
  "grp_eh_20": 0.8,
  "grp_eh_30": 0.0
 }
}
```

### 6.5 情绪与档位

| emotion | 顶层键 | tension 档 | intensity 档 |
|---|---|---|---|
| angry | baseAnimTimeScale,id,intensityProfiles,lipSyncScrubClip,mixDurationMax,mixDurationMin,tensionProfiles | high,low,mid | normal,strong,weak |
| crying | baseAnimTimeScale,id,intensityProfiles,lipSyncScrubClip,mixDurationMax,mixDurationMin,tensionProfiles | high,low,mid | normal,strong,weak |
| cuddle | baseAnimTimeScale,id,intensityProfiles,lipSyncScrubClip,mixDurationMax,mixDurationMin,tensionProfiles | high,low,mid | normal,strong,weak |
| happy | baseAnimTimeScale,id,intensityProfiles,lipSyncScrubClip,mixDurationMax,mixDurationMin,tensionProfiles | high,low,mid | normal,strong,weak |
| laughing | baseAnimTimeScale,id,intensityProfiles,lipSyncScrubClip,mixDurationMax,mixDurationMin,tensionProfiles | high,low,mid | normal,strong,weak |
| neutral | id,intensityProfiles,lipSyncScrubClip,mixDurationMax,mixDurationMin,tensionProfiles | high,low,mid | normal,strong,weak |
| sad | baseAnimTimeScale,id,intensityProfiles,lipSyncScrubClip,mixDurationMax,mixDurationMin,tensionProfiles | high,low,mid | normal,strong,weak |
| shy | baseAnimTimeScale,id,intensityProfiles,lipSyncScrubClip,mixDurationMax,mixDurationMin,tensionProfiles | high,low,mid | normal,strong,weak |
| tease | baseAnimTimeScale,id,intensityProfiles,lipSyncScrubClip,mixDurationMax,mixDurationMin,tensionProfiles | high,low,mid | normal,strong,weak |

### 6.6 其它表（`emotionalGesture` 内）

- `AttitudePatterns`：57 条
- `EmotionProfilesV4`：9 键（angry,crying,cuddle,happy,laughing,neutral,sad,shy,tease）
- `GesturePatternDefs`：21 条
- `MixDurationPoses`：6 键（animPoses,boundsHeight,measurerVersion,setupPose,sourceFileDigest,sourceHash）
- `MotionGroups`：140 条
- `PoseTypeSets`：36 条
- `SittingMandatorySlots`：1 条
- `SittingSets`：4 条
- `TapReactions`：7 条
- `Timelines`：0 条
- `performanceConfig`：1 键（intensitySpeedMultipliers）
- `schemaVersion`：4
