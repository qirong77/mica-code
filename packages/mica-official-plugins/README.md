# mica-official-plugins

官方插件的静态登记表：把仓库根 `plugins/<id>/` 的清单与入口编译进产物，使单二进制里也能启用官方插件。

## 主要能力

- 清单目录 `manifests.ts`：`officialPluginManifests`、`officialPluginIds`、`OFFICIAL_PLUGINS_DIR`。
- 入口登记 `index.ts`：内部 `officialSetups` 把 `id` 映射到各插件 `setup(ctx)`，对外导出 `officialPlugins`（`MicaPlugin[]`）供启动流程注册。
- 清单解析统一走 `mica-plugin` 的 `parsePluginManifest`；清单文件的单一事实来源是 `plugins/<id>/plugin.json`，本包不重复维护字段。

## 目录说明

- `manifests.ts`：只导入各插件的 `plugin.json`，供「只想列清单一类」的宿主使用（如配置页数据层）。
- `index.ts`：导入各插件入口并组装 `MicaPlugin` 列表，把实现一起拉进进程。
- `manifests.test.ts` / `index.test.ts`：清单字段校验、id 与目录一致性、入口覆盖完整性。

## 设计约束

- 只想列插件的宿主只能 import `@packages/mica-official-plugins/manifests.js`；`index.js` 会连带引入插件实现（React / Ink），不要进不需要运行插件的进程。
- 新增官方插件要同时改两处：仓库根 `plugins/<id>/` 建目录与清单，以及本包 `manifests.ts` + `index.ts` 登记。漏登记会让插件在单二进制里消失。
- 插件格式、`setup(ctx)` 能力面与设置项规则见仓库根 `plugins/README.md`，本包不重新定义。
