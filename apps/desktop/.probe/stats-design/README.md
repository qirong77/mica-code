# Stats · 图表新版

三个真正不同的阅读方向，不再受旧统计页卡片顺序限制。仅使用 `fixture.js` 的固定示例，不连接后端，不读写真实会话、配置或主题偏好。

## 预览

仓库根目录：

```sh
apps/desktop/node_modules/.bin/vite --config apps/desktop/.probe/stats-design/vite.config.mjs
```

地址 `http://127.0.0.1:5233/`，端口固定。导出离线页：

```sh
node apps/desktop/.probe/stats-export/export.mjs stats-design
```

导出后可直接打开 `preview.html`，或通过静态服务访问。只编译探针，不构建或重启日常 App。

## 三个方向

| 方向 | 阅读重点 | 表达方式 |
| --- | --- | --- |
| A · 用量全景（默认） | 用了多少、如何变化、集中在哪里 | 指标带 + 每日趋势 + Token 环形图 + 模型排行 + 按来源堆叠的项目条形图 |
| B · 来源分析 | 主对话和后台各消耗多少 | 来源环形图，可按 Tokens / 请求切换；点击图例或扇区联动来源说明和明细高亮 |
| C · 项目地图 | 哪个项目值得重点关注 | 矩形树图，面积对应 Tokens / 请求；点击项目联动项目说明与会话筛选 |

三版共享精确明细：会话 / 来源 / 模型 / 项目 / 模型速度；排序、会话分页、速度指标切换均可操作。模型排行点击联动模型明细，项目筛选只过滤会话表。Token 构成点击用于查看占比，不会将全页口径偷偷改为局部。

趋势点选只展示当日精确数值，不冒充全页日期筛选。没有小时级数据，不画伪造的小时趋势；没有价格与对比期数据，不显示费用或增长率。项目与来源图的颜色只作类别区分，面积/条长才表达用量。

## 数据与主题

固定区间 `2026-10-06` 至 `2026-11-04`：24 个活跃会话、1,286 次请求、48.6M Tokens。缓存输入 42M、未缓存输入 3.95M、输出 2.65M；缓存命中率 91.4% 的分母是输入，环图占比的分母是全部 Tokens。各维度总量一致，不将其误称为 API 真实结果。

支持 `auto` 与六套正式主题；使用真实 `theme.js`、`ArcoProvider`、Card、Statistic 与共享控件。图表使用现有 ECharts 依赖的按需模块与 SVG renderer，不新增依赖；配色取主题 token，不固定为蓝色。主题即时切换、图表容器 resize 后重排，销毁时清理 observer 与实例。

URL：

```text
/?variant=a&theme=auto
/?variant=b&theme=light
/?variant=c&theme=mocha
/?variant=a&theme=dark&data=empty
```

顶部“查看无数据状态”可切换全部图表与表格的空态。无数据不生成假百分比，缓存命中率显示 `—`。

## 验证

```sh
cd apps/desktop
bun test ./.probe/stats-design/chart-model.test.js
```

纯数据测试覆盖占比分母、异常数值与日期补零。方案 A 已接入正式 Stats 的真实统计聚合与共享会话详情；本探针仍是固定示例对照，不代表 API 真实结果。正式页面可通过 App 的 Stats 入口查看。
