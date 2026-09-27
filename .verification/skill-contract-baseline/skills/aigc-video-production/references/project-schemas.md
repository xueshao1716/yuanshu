# 项目结构与数据约定

## 稳定 ID

| 对象 | 格式 | 示例 |
|---|---|---|
| 项目 | `PRJ-*` | `PRJ-DEMO-001` |
| 人物 | `CHR-*` | `CHR-001` |
| 生物 | `CRT-*` | `CRT-001` |
| 道具 | `PROP-*` | `PROP-007` |
| 场景资产 | `LOC-*` | `LOC-003` |
| 视效资产 | `VFX-*` | `VFX-002` |
| 场次 | `SC###` | `SC012` |
| 镜头 | `SC###-SH###` | `SC012-SH004` |
| 生成记录 | `GEN-*` | `GEN-SC012-SH004-003` |
| 选片记录 | `SEL-*` | `SEL-SC012-SH004-001` |

ID 一经引用不重命名；外观、伤势、天气或提示词变化使用版本和状态字段表达。

## CSV 表

### `assets.csv`

`asset_id,asset_type,name,version,status,reference_path,notes`

`asset_type` 使用 `character`、`creature`、`prop`、`location` 或 `vfx`。参考路径可为空，但批准进入生成的资产必须明确版本和状态。

### `scenes.csv`

`scene_id,scene_order,title,location_id,time_of_day,story_goal,status,notes`

`location_id` 引用 `assets.csv` 中的 `LOC-*`。

### `shots.csv`

`shot_id,scene_id,shot_order,duration_seconds,status,prompt_version,selected_generation_id,notes`

`scene_id` 必须存在；`selected_generation_id` 为空或引用生成记录。

### `generation-log.csv`

`generation_id,shot_id,prompt_version,provider,model,seed,created_at,status,output_path,cost,notes`

每次真实调用追加一行，包括失败尝试。成本使用项目约定币种；不要用空白代表免费，未知时写入备注。

### `selection-log.csv`

`selection_id,shot_id,generation_id,decision,reviewer,reviewed_at,notes`

`decision` 推荐使用 `shortlist`、`reject`、`select` 或 `supersede`。

### `continuity-matrix.csv`

`shot_id,character_ids,asset_ids,screen_direction,costume_state,injury_state,prop_state,environment_state,notes`

多值字段使用分号分隔。只写镜头中真实出现或影响接点的状态。

## 版本规则

- 提示词：`v001`、`v002`。
- 资产：稳定 ID 不变，`version` 递增。
- 成片：文件名包含项目 ID、交付规格和版本，不用 `final-final`。
- 不覆盖失败生成、评审意见或已被引用的旧版本。
