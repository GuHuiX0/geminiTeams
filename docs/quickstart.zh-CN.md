# 中文快速开始

这个版本实现的是讨论最后确定的方向：**一个持续运行的 Runtime，多个持久任务，按需创建临时 Gemini Worker。** 支持研究、分析、设计、脑暴和长期项目；前台简单问题有独立容量。

## 安装与体验

需要 Node.js 24+：

```bash
npm ci
npm run build
npm run demo
```

Demo 完全离线，所有内容都标有 OFFLINE DEMO，只展示调度机制，不是实际研究结果。

使用真实 Gemini：

```bash
export GEMINI_API_KEY='你的 API Key'
export LIVING_MODEL=gemini-flash-latest
npm start -- serve
```

在另一个终端：

```bash
npm start -- submit "用三句话解释 Actor Model" --policy instant --wait
npm start -- submit "比较个人研究助手的三种架构，并挑战各自的关键假设" --policy deep --wait
npm start -- list
npm start -- get TASK_ID
npm start -- events TASK_ID
```

`submit` 立即返回任务 ID；`--wait` 持续显示新的有效结果。`instant` 只调用一次模型，没有前置 Planner。默认 `focused` 先在交互通道处理，若确实需要深入，则先交付结果，再把后续工作转入后台通道。`deep` 可以并行探索。`persistent` 没有可做的事情就等待事件，不会不断调用模型。

可用 `npm start -- serve --demo` 在无 Key 的情况下体验完整 CLI/API。需要联网研究时，`serve --ground-search` 为推理 Worker 开启 Gemini Google Search grounding，并保留模型返回的来源；可用性和费用取决于你的模型与账户。

## 干预任务

```bash
npm start -- pause TASK_ID
npm start -- steer TASK_ID "完整的新目标：先研究系统架构，暂缓商业分析"
npm start -- resume TASK_ID --extra-calls 10
npm start -- cancel TASK_ID
```

旧结果保留，旧 Worker 的迟到输出不能覆盖新方向。模型调用预算包含重试和已中断的请求；预算不够会暂停，不会假装完成。

## 长期任务与事件

```bash
npm start -- submit "持续跟踪这个研究假设" --policy persistent
npm start -- subscribe TASK_ID --source research --subject 'papers/*' --type evidence
npm start -- emit --source research --subject papers/actor --type evidence \
  --event-id paper-1 --payload '{"summary":"新的研究证据"}'
npm start -- timer TASK_ID --in 30m --every 6h
```

只有显式订阅的来源能唤醒任务。默认不监控键盘、屏幕、浏览器或文件系统。相同事件去重，短时间内的同类变化合并。事件、任务、产物、定时器和检查点都保存在本地 SQLite，重启后仍存在。

## 文件工具

```bash
npm start -- serve --workspace /你的项目目录
npm start -- submit "阅读 notes.md，列出尚未解决的问题" --tools file_read
```

需要写入时，服务端必须开启 `--allow-writes`，任务也必须通过 `--tools file_read,file_write` 授权。已授权的工具可以实际修改文件。中断后无法判断是否成功的写操作会暂停，需先核对实际结果，再用 `reconcile JOB_ID "实际结果"` 和 `resume TASK_ID` 继续。

## 验证与范围

`npm run check` 运行严格类型检查、测试和构建。测试包含真实进程强制终止后的恢复、并发隔离、任务重定向、事件回放及工具边界。Gemini SDK 通过模拟 HTTP 响应测试；真实推理需要你的 Key。

当前是单机 SDK/CLI/API MVP，没有 Web 面板、分布式调度或自动桌面观察。更多运行保证与扩展方式见 [架构](architecture.md)、[API](api.md) 和 [扩展指南](extending.md)。
