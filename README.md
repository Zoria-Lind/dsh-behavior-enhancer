# dsh-behavior-enhancer

> DeepSeek Harness 行为管理插件：改变模型**怎么调用工具**，让复杂任务更稳定，不干预内容本身。
> 与 [dsh-token-optimizer](https://github.com/Zoria-Lind/dsh-token-optimizer) 职责互补——
> **token-optimizer 管内容**（压缩/裁剪/采样），**本插件管行为**（调用纪律/失败收敛/连续失败介入）。两者互不依赖，可独立安装。

## 它做什么（30 秒版）

| 模块 | 机制 | 说明 |
| :--- | :--- | :--- |
| behaviorPrompt | `ctx.inject(['systemPrompt'])` + `systemPrompt.section()` | 注册静态行为约束段（先读后写、批量前先验证、失败即收敛、同类修改串行）。**软约束**，强制靠下面模块 |
| parallelConvergence | `tools/result` + `settings.update('agent-loop', {maxParallelToolCalls})` | 任何工具失败（含命令级失败）→ 并行池上限压到 1；连续 3 次成功 → 恢复用户原值；上下文压力 ≥60%（idle 测量）→ 降档，回落 <54% 滞回恢复。串行状态**跨进程持久化**，重启自动接管还原 |
| failureGuard | `tools/result` + `agent.followup()` | 同工具连续失败 ≥2 次 → 向模型注入提示，引导它向用户确认而不是继续重试 |
| postWriteCheck | `tools/execute`（写前快照）+ `tools/post-execute`（写后检查） | write/edit 写入后做轻量语法解析（JSON 用 JSON.parse；YAML/代码做字符串与注释感知的括号配对 + YAML tab 检查）。失败自动从 `.bak` 快照回滚并改写工具结果报告模型；≥3 个问题弹窗三选一（仅本次校验 / 本次+后续自动升级 / 不校验）。快照存 `~/.dsh-memory/files/`，每文件保留最近 5 份 |

**失败识别两档**：工具级 `isError` + 命令级签名（stderrAsFailure，默认开）——DSH 的 pwsh 工具只有基础设施错误才标 `isError`，命令失败（非零退出/stderr 错误）作为普通结果返回；本插件按 `[exit code: N]` 与 stderr 错误关键词补识别，普通 warning 不误判。

## 设计依据（DSH 核心源码核实）

- 核心已内置写操作排他：`isConcurrencySafe` 分类（read/read_image 并行，edit/write/pwsh 等 exclusive 屏障），**插件不需要做 per-tool 串行规则**；
- 插件唯一动态并行杠杆是池上限 `maxParallelToolCalls`（settings 活 getter，运行时 `update` 即生效）；
- "暂停其他进行中的调用"无 API，不支持；工具失败无核心重试，改为"降并行让模型逐步修正"；
- 行为约束段是静态文本，保护 DeepSeek 前缀缓存（实测命中率 99.75%，动态内容会杀缓存）。

## 安装

```bash
dsh plugin --profile web add ./dsh-behavior-enhancer
```

## 配置

```yaml
- id: behavior-enhancer
  name: 'dsh-behavior-enhancer'
  config:
    behaviorPrompt:
      enabled: true
      order: -98
      text: |        # 可整体替换；必须保持静态（禁时间戳/动态值）
        ## 工具调用行为纪律（本会话）
        - 先读后写
        - 批量操作前先验证
        - 失败立即收敛
        - 同类修改串行
        - 证据与诚实
        - 上下文已压缩时先查日志再回答
    parallelConvergence:
      enabled: true
      recoveryThreshold: 3     # 连续成功次数达到后恢复原并行度
      complexRatio: 0.6        # 上下文压力比（idle 测量），超阈值降档
      minParallel: 1
      defaultParallel: 10      # 读不到当前值时的 fallback（核心默认 10）
      contextWindowFallback: 1000000
    failureGuard:
      enabled: true
      maxFailures: 2
      followupMessage: '工具 {tool} 已连续失败 {count} 次。请停止重试，向用户说明失败原因并询问下一步。'
      blockFeedback: false     # 慎用：拦截错误结果正文，模型会看不到失败细节
      feedbackText: '该工具调用失败。请先分析失败原因并修正调用参数后再重试，不要原样重复。'
    postWriteCheck:            # v1.1 写后检查（默认开启）
      enabled: true
      writeTools: ['write', 'edit']
      checkExtensions: ['json', 'yaml', 'yml', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'ps1', 'sh', 'toml', 'xml']
      maxFileBytes: 500000     # 超过该大小跳过检查（也跳过快照）
      keepBackups: 5           # 每文件保留的 .bak 快照份数
      askThreshold: 3          # ≥3 个问题才弹窗询问（1~2 个自动回滚）
      askTimeoutMs: 120000     # 询问超时，超时按 autoRollback 降级
      snapshotDir: '~/.dsh-memory/files'
      autoRollback: true       # 询问不可用/超时时自动回滚（fail-safe）
    memory_bridge:             # dsh-memory-bridge 联动占位节（阶段 3b 完成后开开关）
      enabled: false
      sync_on_check: true
      rollback_from_memory: true
      post_write_check: true
```

## 权限与边界（上架声明）

| 类别 | 实际行为 | 边界 |
| :--- | :--- | :--- |
| 文件 files | 读写 `~/.dsh/behavior-enhancer/state.json`（parallelConvergence 串行状态）；postWriteCheck 在 write/edit 执行前把目标文件快照到 `~/.dsh-memory/files/`（`.bak-<时间戳>`，每文件留 5 份），写后检查失败时把快照回滚写回目标文件 | 不写 Profile 配置、不改 DSH 核心/官方包；用户工作区的读写**仅限模型主动调用的 write/edit 目标文件**，快照目录固定为 `~/.dsh-memory/files/` |
| 网络 network | 无 | 不发起任何网络请求 |
| 命令 commands | 无 | 不执行任何子进程 |
| 凭据 credentials | 无 | 不读取任何环境变量或凭据 |

- **运行时依赖**：零 npm 依赖，无外部服务。
- **失败边界**：所有模块 fail-open——状态文件损坏即丢弃重来；约束段是**软约束**（行为提示），强制收敛由并行池与 followup 两条独立路径保证，任何一条失效不影响 DSH 核心流程。
- **已知风险**：`failureGuard` 通过 `agent.followup()` 注入提示，模型是否服从取决于模型本身；`behaviorPrompt.text` 若被改成动态内容会破坏 DeepSeek 前缀缓存（默认静态）。`postWriteCheck` 的轻量解析是启发式（非编译器），回滚恢复的是整个文件的写入前版本（文件写入前已存在的问题会一并带回）；检查范围仅 write/edit 工具，经 pwsh/bash 等命令写入的文件不检查。
- **兼容范围**：完整开发与验证基于 DSH `0.1.1-rc.2`（Node ≥ 18）；`0.1.2+` 与 `0.1.3+` 尚未验证，在 `package.json` 的 `dsh.compatibility.dshReleases` 中标为 `unknown`。

## 开发

```bash
node test/smoke.mjs          # 单进程全量自检（无需 API），npm test 同
```

## 路线图

- 实验分支：给 grep/glob 补 `isConcurrencySafe`（需 agent 作用域 shadow 包装器，复杂度高，主线不依赖）
- dsh-memory-bridge 联动（配置节已占位；`~/.dsh-memory/files/` 文件快照已就绪，等 bridge 服务上线后支持"从快照找回文件正确版本"）

## 许可 / License

[MIT](LICENSE) © 2026 Zoria Lind
