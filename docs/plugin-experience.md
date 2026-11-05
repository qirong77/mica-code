# 会话体验卡与本地埋点

三个插件使用宿主统一的摘要卡片与详情面板，复用主题令牌和共享 Button。卡片只在有内容时出现，支持收起；完整信息仍可从插件面板查看。

| 插件 | 用途 | 信息来源 |
| --- | --- | --- |
| Task Delivery | 任务结果、文件与验证/构建/部署状态 | 模型提供摘要；实际观察到的工具结果单独作为证据 |
| Context Handoff | 回到旧会话时查看已完成、待完成和注意事项 | 保存的历史检查点；继续前核实当前工作区 |
| Environment Ready | 当前任务登记的本机 HTTP/TCP 服务 | 有超时、检查时间与过期标记的实际探测 |

这三个插件不额外调用模型。交付与交接需要主代理调用工具保存内容，不会从每条聊天消息自动猜测任务状态。环境卡只探测已登记的本机服务，不会自动启动、停止或重启服务。

## 统一事件

通过 `createPluginExperience(ctx)` 写入已有的插件 JSONL 日志。外层沿用 `{ time, plugin, level, event, data }`，其中 `event = "plugin:experience"`。`data` 的版本是 `schemaVersion: 1`：

| 字段 | 含义 |
| --- | --- |
| eventId | 唯一事件 ID，复制日志后可去重 |
| pluginVersion | 插件版本，避免混合不同版本的数据 |
| event | `impression / click / dismiss / update / failure / check / clear` |
| sessionKey | 会话 ID 的 SHA-256 截断值，用于本地关联，不是原始会话 ID |
| surface | `card / panel / tool / background` |
| action | 代码内固定的动作名，不放用户文本 |
| outcome | `success / error / stale / dismissed` |
| revision | 不含内容的版本标识，用于识别旧界面操作 |
| durationMs / count | 有上限的检查耗时、数量 |

字段按白名单输出，不收集对话正文、文件路径、命令、服务地址、接口响应或错误原文。哈希化会话键仍能关联同一会话的行为，属于本地化名数据，不声称完全匿名。

每个插件的设置中都有“本地使用统计”开关，关闭后立即停止这些事件。不会上传；日志继续遵守插件日志的 2 MB 分片和 7 天保留策略。`MICA_PLUGIN_LOG=0` 会关闭文件输出。日志可能被截断或已过保留期，所以统计只代表现有样本。

曝光来自可见卡片的实际呈现，同一挂载会话中按插件、卡片及版本去重；获取视图与后台轮询不计曝光。宿主必须支持 IntersectionObserver v2 并能确认未被遮挡；不支持时跳过曝光，所以可能有点击而没有曝光。页面重新挂载可能产生新的曝光，这里统计的是展示次数，不是人数。点击允许同一曝光后多次发生，`cardClicks / cardImpressions` 是每次展示的点击次数，可能超过 1，不能当作用户转化率。

## 自动化分析与导出

在仓库根目录运行（只读，不启动服务）：

```sh
bun scripts/plugin-experience-report.ts
bun scripts/plugin-experience-report.ts --plugin task-delivery --since 2026-11-01T00:00:00Z
bun scripts/plugin-experience-report.ts --dir /path/to/copied-logs > experience-report.json
```

输出为版本化 JSON，按插件和版本汇总事件、动作、结果、会话样本数、卡片展示/点击和检查平均耗时。没有日志时返回空汇总；未知 schema、非埋点日志、截断行会被跳过，重复 eventId 只计一次。该脚本在源码环境用 Bun 运行，不是已安装二进制的内置命令。

建议后续优化关注：

- 展示后是否有人查看详情、选择继续，或立即关闭；按版本和 surface 分开比较。
- 旧版本点击的 `stale` 比例：过高可能意味着卡片刷新太频繁或操作链太长。
- 环境检查耗时与失败比例：区分服务确实不可用和插件自身故障，不能把 HTTP 成功状态直接当作业务健康。
- 工具更新频率与实际展示次数：过度更新可能引起干扰；交接卡没有使用可能是检查点未保存，也可能是显示时机不合适。

事件只提供分析证据，不会自动修改插件设置、清理按钮、部署或触发任务。自动优化系统应先输出可审核的建议，结合样本量和用户反馈判断。
