# dsh-behavior-enhancer

DeepSeek Harness 行为管理插件(v1):改变模型"怎么调用工具",让复杂任务更稳定,不干预内容本身。

> 与 [dsh-token-optimizer](https://github.com/Liora2050348900/dsh-token-optimizer) 职责互补:
> **token-optimizer 管内容**(压缩/裁剪/采样/摘要),**本插件管行为**(调用纪律/失败收敛/连续失败介入)。
> 两者互不依赖,可独立安装。

## 模块

| 模块 | 机制 | 说明 |
| :--- | :--- | :--- |
| behaviorPrompt | `ctx.inject(['systemPrompt'])` + `systemPrompt.section()` | 注册静态行为约束段(order 在 identity/source 之后、persona 之前):先读后写、批量前先验证、失败即收敛、同类修改串行。**软约束**——强制靠下面两个模块 |
| parallelConvergence | `tools/result` + `settings.update('agent-loop', {maxParallelToolCalls})` | 任何工具失败(含命令级失败,见下)→ 并行池上限压到 1;连续 3 次成功 → 恢复用户原值;上下文压力 ≥60%(idle 时测量)→ 降档,回落 <54% 滞回恢复。会话结束还原。串行化状态跨进程持久化,重启后自动接管还原 |
| failureGuard | `tools/result` + `agent.followup()` | 同工具连续失败 ≥2 次 → 经收件箱向模型注入提示(下轮开始可见),引导它向用户确认而不是继续重试。计数在提示后重置 |

**失败识别两档**:工具级 `isError` + 命令级签名(stderrAsFailure,默认开)——DSH 的 pwsh 工具只有基础设施错误才标 isError,命令失败(非零退出/stderr 错误)作为普通结果返回;本插件按 `[exit code: N]` 与 stderr 错误关键词补识别,普通 warning 不误判。

## 设计依据(DSH 0.1.1-rc.2 核心源码核实)

- 核心已内置写操作排他:`isConcurrencySafe` 分类(read/read_image 并行,edit/write/pwsh 等 exclusive 屏障),**不需要插件做 per-tool 串行规则**;
- 插件唯一的动态并行杠杆是池上限 `maxParallelToolCalls`(settings 活 getter,运行时 update 即生效);
- "暂停其他进行中的调用"无 API,不支持;工具失败无核心重试,改为"降并行让模型逐步修正";
- 行为约束段是静态文本,保护 DeepSeek 前缀缓存(实测命中率 99.75%,动态内容会杀缓存)。

## 配置

```yaml
- id: behavior-enhancer
  name: 'dsh-behavior-enhancer'
  config:
    behaviorPrompt:
      enabled: true
      order: -98
      text: |        # 可整体替换;必须保持静态(禁时间戳/动态值)
        ## 工具调用行为纪律(本会话)
        - 先读后写
        ...
    parallelConvergence:
      enabled: true
      recoveryThreshold: 3     # 连续成功次数达到后恢复原并行度
      complexRatio: 0.6        # 上下文压力比(idle 时测量),超阈值降档
      minParallel: 1
      defaultParallel: 10      # 读不到当前值时的 fallback(核心默认 10)
      contextWindowFallback: 1000000
    failureGuard:
      enabled: true
      maxFailures: 2
      followupMessage: '工具 {tool} 已连续失败 {count} 次。请停止重试,向用户说明失败原因并询问下一步。'
      blockFeedback: false     # 慎用:拦截错误结果正文,模型会看不到失败细节
      feedbackText: '该工具调用失败。请先分析失败原因并修正调用参数后再重试,不要原样重复。'
```

## 安装

```bash
dsh plugin --profile web add ./dsh-behavior-enhancer
```

## 开发

```bash
node --check src/index.js src/config.js src/modules/*.js
node test/smoke.mjs
```

## 路线图

- 实验分支:给 grep/glob 补 `isConcurrencySafe`(需 agent 作用域 shadow 包装器复制 schema 委托原实现;核心 register 同名抛错,复杂度高,主线不依赖)
- 硬阻塞选项:连续失败后用 `userQuestions.ask` 阻塞等用户回答(默认走软通道 followup)
