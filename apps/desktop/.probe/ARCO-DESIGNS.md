# Arco 外观方案

基线已提交：`5c92041c`，分支 `experiment/arco-settings`。方案页只用示例数据，不读写真实会话。

## 长回复摘要：已选 C

C · 可收起摘要已经接入正式 `DigestNotice`，底层复用共享 Arco Collapse，默认展开；点击标题或键盘 Enter 可收起。不改变摘要生成、消息顺序、原回复与 Markdown 链接。

已删除旧的识别色底、渐变、阴影和内外双框。设计探针的 C 与原摘要探针均复用正式容器，A/B 仅保留对照。

[摘要 C 交互预览](digest-design/preview.html?variant=c&theme=auto)

## Stats：已选 A · 用量全景

旧三版主要区别是卡片排布，现改为三个不同的阅读方向：

| 方案 | 重点 | 主要图形 |
| --- | --- | --- |
| A · 用量全景（默认） | 用了多少、最近如何变化、用在哪里 | 每日趋势 + Token 环形图 + 模型排行 + 项目堆叠条 |
| B · 来源分析 | 主对话与委派、插件、内核后台的消耗 | 来源环形图 + 联动说明/来源明细 + 趋势与输入输出 |
| C · 项目地图 | 项目消耗的集中度与相关会话 | 矩形树图 + 项目排行 + 联动会话筛选 |

[Stats 交互预览](stats-design/preview.html?variant=a&theme=auto)，顶部切换 A/B/C。各版都有精确明细与排序，支持 Tokens/请求切换、六套主题、跟随系统及无数据状态。不同维度的百分比分母明确，不从 Tokens 推算费用或虚构增长率。

方案 A 已接入正式 `StatsView`，使用真实区间聚合、共享会话详情和 Arco Card / Statistic；趋势、环图与项目堆叠使用正式图表组件。此处三版仍是固定示例对照，旧版 PNG 仅为历史方案，不代表正式页面。

## 启动与导出

运行方式见 [Stats README](stats-design/README.md)、[摘要 README](digest-design/README.md)。离线 `preview.html` 由 [导出脚本](stats-export/README.md) 生成，可直接打开或用静态服务托管。仅编译方案探针，不构建、安装或重启日常 App。
