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
| postWriteCheck | `tools/execute`（写前快照）+ `tools/post-execute`（写后检查） | write/edit 写入后做轻量语法解析（JSON 用 JSON.parse；YAML/代码做字符串与注释感知的括号配对 + YAML tab 缩进检查）。失败自动从 `.bak` 快照回滚并改写工具结果报告模型；≥3 个问题弹窗三选一（仅本次校验 / 本次+后续自动升级 / 不校验）。快照存 `~/.dsh-memory/files/`（独立于记忆池），每文件保留最近 5 份 |
| projectMemory | `tools/execute`（记录写前大小）+ `tools/post-execute`（写后校验） | 模型写入 `AGENTS.md` / `CLAUDE.md` / `AGENTS.local.md` / `CLAUDE.local.md` 后做**建议性**校验：重复行、单文件超出 65,536 B、超长行（默认 200 字符）、主目录/用户名/盘符绝对路径泄漏、同进程内异常缩水（< 写前 30%）。只把提示追加到该次工具结果，**绝不回滚、不新增存储、不注入提示词** |
| disciplineInject | `agent/turn-stopping`（惰性判定）+ `agent.steer()` | 每 N 小时 / N 轮，把 `AGENTS.md` 的 `## 项目纪律` 节重述一次（默认 3 小时、内容未变且未压缩则跳过、压缩后必补）。走**历史消息**而不是 systemPrompt —— 动态内容进系统段会废掉整段前缀缓存。缺节/超限只 warn，不猜内容 |

**失败识别两档**：工具级 `isError` + 命令级签名（stderrAsFailure，默认开）——DSH 的 pwsh 工具只有基础设施错误才标 `isError`，命令失败（非零退出/stderr 错误）作为普通结果返回；本插件按 `[exit code: N]` 与 stderr 错误关键词补识别，普通 warning 不误判。

## 设计依据（DSH 核心源码核实）

- 核心已内置写操作排他：`isConcurrencySafe` 分类（read/read_image 并行，edit/write/pwsh 等 exclusive 屏障），**插件不需要做 per-tool 串行规则**；
- 插件唯一动态并行杠杆是池上限 `maxParallelToolCalls`（settings 活 getter，运行时 `update` 即生效）；
- "暂停其他进行中的调用"无 API，不支持；工具失败无核心重试，改为"降并行让模型逐步修正"；
- 行为约束段是静态文本，保护 DeepSeek 前缀缓存（实测命中率 99.75%，动态内容会杀缓存）。

## 安装 / 卸载

**推荐:DSH 插件命令**(在 profile 内用 pnpm 安装,并自动把包名加入
`dsh.profile.bundles`;卸载时一并移出,无需手改配置):

```bash
dsh plugin --profile web add @zoria-lind/dsh-behavior-enhancer
dsh plugin --profile web remove @zoria-lind/dsh-behavior-enhancer   # 卸载
```

**或手动安装**(在 profile 目录执行;装完需确认 `dsh.profile.bundles`
包含 `@zoria-lind/dsh-behavior-enhancer`,卸载时同步删除):

```bash
cd ~/.dsh/profiles/web
pnpm add @zoria-lind/dsh-behavior-enhancer
```

**或本地路径**(git 克隆开发方式;`add` 换成目录路径,其余同上):

```bash
dsh plugin --profile web add ./dsh-behavior-enhancer
```

> **为什么 `cordis.patch.yml` 里的 `name` 是带 scope 的全名**:patch 条目的
> `name` 是 loader 解析**已安装包名**用的(与 `package.json` 的 `name` 一一
> 对应),`id: behavior-enhancer` 才是配置树里的逻辑标识。npm/marketplace
> 安装的包名带 scope,所以 `name` 必须与之一致;不一致时 loader 会报
> `cannot resolve package`。用上面的 `dsh plugin add` 安装即自动一致。

## 配置

```yaml
- id: behavior-enhancer
  name: '@zoria-lind/dsh-behavior-enhancer'
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
    projectMemory:             # v1.3 项目记忆写后校验（建议性，绝不回滚）
      enabled: true
      writeTools: ['write', 'edit']
      fileNames: ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
      maxBytes: 65536          # 与内核 maxBytes 对齐（按单文件计；内核按整批渲染计）
      maxLineLength: 200       # 超长行提示（长表格可调大）
      duplicateMinLength: 8    # 短行（如表格分隔线）不计重复
      shrinkRatio: 0.3         # 写后大小 < 写前 30% 告警
      shrinkMinBytes: 2048     # 写前小于该值不判缩水
      checkPathLeak: true      # 主目录/用户名/盘符绝对路径泄漏
    disciplineInject:          # v1.3 项目纪律周期重述（走历史消息，不碰 systemPrompt）
      enabled: true
      heading: '## 项目纪律'    # 只重述 AGENTS.md 里的这一节
      candidates: ['AGENTS.md', 'CLAUDE.md']   # 从会话 cwd 向上找最近一份
      everyHours: 3            # 0 = 关（只按轮次）；两键都 0 = 完全静默
      everyTurns: 0            # 0 = 关（只按时间）
      maxDigestBytes: 1600     # 节体超过即不重述并提示精简
      skipUnchanged: true      # 内容没变且未压缩过 → 跳过，只推进周期
      compactReinject: true    # 压缩后必补一次（内核基线是历史消息，会被摘要掉）
      pointer: ''              # 非空：每次重述末尾追加一行（如进度索引路径）
      stateFile: '~/.dsh/behavior-enhancer/discipline-state.json'
    memory_bridge:             # dsh-memory-bridge 联动占位节（阶段 3b 完成后开开关）
      enabled: false
      sync_on_check: true
      rollback_from_memory: true
      post_write_check: true
```

### 怎么改「每 N 小时」（v1.3.0）

两条通道，都不必重启：

- **通用设置**：设置 → 通用 →「项目记忆」一行，改数字后失焦即生效，并落盘到 profile 的 `cordis.patch.yml`。
- **会话命令**：`/pm status`（查看当前值）· `/pm 3h`（设为 3 小时）· `/pm off`（关闭）。

原理：`disciplineInject` 在 `Config` schema 里声明为 volatile 字段，宿主会把它们解析成引用对象（`{ get(), [Symbol.for('cosmokit.volatile.write')] }`）交给插件；本插件**每轮判定时 `.get()` 取活值**，所以设置面板与命令的修改立即生效。schema 导入失败时 `Config` 为 `undefined`，只是一行 UI 不出现，其余功能照常。

## 权限与边界（上架声明）

| 类别 | 实际行为 | 边界 |
| :--- | :--- | :--- |
| 文件 files | 在 `~/.dsh/behavior-enhancer/` 下维护 `state.json`（并行收敛状态）、`discipline-state.json`（重述周期与内容 hash）、`stats.json`（遵守度计数）、`boot.json`（每次启动写一条加载记录）；postWriteCheck 在 write/edit 执行前把目标文件快照到 `~/.dsh-memory/files/`（`.bak-<时间戳>`，每文件留 5 份），写后检查失败时把快照回滚写回目标文件 | 不写 Profile 配置、不改 DSH 核心/官方包；用户工作区的读写**仅限模型主动调用的 write/edit 目标文件**，快照目录固定为 `~/.dsh-memory/files/` |
| 网络 network | 无 | 不发起任何网络请求 |
| 命令 commands | 无 | 不执行任何子进程 |
| 凭据 credentials | 无 | 不读取任何环境变量或凭据 |

- **运行时依赖**：核心路径零依赖、无外部服务；`@deepseek-ai/schemastery` 只用于设置面板的 `Config` 声明（导入失败即视为无 schema，仅少一行 UI，其余功能照常）。
- **失败边界**：所有模块 fail-open——状态文件损坏即丢弃重来；约束段是**软约束**（行为提示），强制收敛由并行池与 followup 两条独立路径保证，任何一条失效不影响 DSH 核心流程。
- **已知风险**：`failureGuard` 通过 `agent.followup()` 注入提示，模型是否服从取决于模型本身；`behaviorPrompt.text` 若被改成动态内容会破坏 DeepSeek 前缀缓存（默认静态）。`postWriteCheck` 的轻量解析是启发式（非编译器），回滚恢复的是整个文件的写入前版本（文件写入前已存在的问题会一并带回）；检查范围仅 write/edit 工具，经 pwsh/bash 等命令写入的文件不检查。**不要把 `md` 加进 `postWriteCheck.checkExtensions`**——括号配对会在含 JSON/代码片段的记忆文件上误判，进而**回滚整个记忆文件**；记忆文件交给 `projectMemory`（只提示、永不回滚）。
- **兼容范围**：支持基线 DSH `0.1.5-rc.x`（Node ≥ 18）：`0.1.5-rc.1` 已按核心源码静态核验全部依赖 API、`0.1.5-rc.2` 经真实环境运行验证（Issue #2 报告），`0.2.0-rc.2` 与 `0.2.1-rc.2`（官方桌面端内核）已在实际运行中验证（含纪律重述注入、设置面板写入、`/pm` 命令），并在 `package.json` 的 `dsh.compatibility.dshReleases` 中标为 `compatible`；`≤0.1.4` 旧版不再跟踪支持。

### 项目记忆边界

- **注入归内核**：`@deepseek-ai/dsh-agent-instructions` 在首个请求读取 `$DSH_HOME/AGENTS.md`、项目根（`.git` 标记）到会话 cwd 的 `AGENTS.md`/`CLAUDE.md` 及 `.local` 叠加层（`maxBytes: 65536`，按 trim 内容去重）。本插件**不注入、不缓存、不新增存储**，只在 write/edit 之后校验文件内容。
- **跨项目/用户级记忆池归 dsh-ecolink**：本插件不读、不写、不感知其池与格式；同一条事实不要两处都写。
- 本模块**永不回滚**记忆文件，也不会把记忆内容重新写进系统提示词；校验文本只追加到该次工具结果。
- **周期重述需要你写一节**：在 `AGENTS.md` 里加 `## 项目纪律`（当前主题 / 工作流程规定 / 要避开的坑，一行一条）。`disciplineInject` 只重述这一节；没有这一节就什么都不做（只计数 + warn）。重述走 `agent.steer` 进**历史消息**，不改 systemPrompt，因此不伤前缀缓存。

## 开发

```bash
node test/smoke.mjs          # 单进程全量自检（无需 API），npm test 同
```

## 路线图

- 实验分支：给 grep/glob 补 `isConcurrencySafe`（需 agent 作用域 shadow 包装器，复杂度高，主线不依赖）
- dsh-memory-bridge 联动（配置节已占位；`~/.dsh-memory/files/` 文件快照已就绪，等 bridge 服务上线后支持"从快照找回文件正确版本"）

## 许可 / License

[MIT](LICENSE) © 2026 Zoria Lind
