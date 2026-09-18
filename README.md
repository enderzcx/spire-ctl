# Spire Jev

让主模型规划，让 Jev 快速选择，让程序可靠出牌。

《杀戮尖塔 2》的实验性 AI 玩家。通过本地 Mod 获取结构化状态、调用游戏原有动作队列，不需要逐张截图或拖牌。主模型可以运行在任何能执行命令、读取 JSON 的 agent harness 中；Jev 是默认的快速决策模型。

```text
主模型：构筑 / 路线 / 复杂回合 / 异常接管
                 ↓
控制器：合法选项 → Jev 快选 → 原动作队列 → 状态确认
                 ↑                      ↓
                 └──── 需要规划时返回 ─────┘
```

## 分工

| 场景 | 谁处理 |
|---|---|
| 动画结算、旧状态核对 | 程序等待 |
| 开新局（单机 → 标准 → 角色 → 启程） | 主模型/所有者授权 |
| 已知攻击能被一手牌完全挡下（无副作用） | 程序出牌 |
| 本回合继续打数值与目标都明确的攻击牌 | 程序连续执行 |
| 普通战斗中的下一手牌 | Jev |
| Jev 低置信度 | 交回主模型；同一状态不再重问 |
| 无牌可出且无需紧急考虑药水 | 程序结束回合 |
| 新牌、路线、商店、事件、药水取舍 | 主模型 |
| 可能致命的攻击无法挡下、陌生意图 | 主模型 |
| 动作结果未知 | 程序停止，核实后再继续 |

确定性回合可以先排好一个多卡计划，再用 `plan` 连续执行，期间不调用模型。程序逐张检查预测结果；抽牌、随机变化或选牌弹窗出现时重新规划。格式见 [回合计划](docs/ROUND-PLAN.md)。

默认置信度阈值不是胜率保证。当前策略仍会接管，不是全自动通关承诺。测试结果、支持范围和未验证场景见 [验证记录](docs/VALIDATION.md)。

## DSH 原生插件

想在 DSH 中直接使用原生工具，可安装独立的 [DSH Spire Jev 插件](https://github.com/enderzcx/dsh-spire-jev)。核心不依赖 DSH；插件只负责适配。

## 准备

- 自己安装的《杀戮尖塔 2》，单人模式。
- Node.js 22+，无需 npm 依赖。
- TypeSafe API key（运行 Jev 时需要）。
- 本项目适配的 [STS2MCP](https://github.com/Gennadiyev/STS2MCP) 游戏 Mod。
- 仅从源码编译 Mod 时需要 .NET 9 SDK、Git 和本机游戏程序集。

目前在 macOS arm64、游戏 v0.107.1 上验证。其他版本可能有 API 变化；不应直接视为兼容。先关闭游戏并备份存档，再安装 Mod。

### 1. 安装 Mod

macOS arm64、游戏 v0.107.1 可直接下载 [已编译桥接包](https://github.com/enderzcx/spire-jev/releases/tag/v0.1.1)，按包内说明复制 DLL 和 JSON。包内附来源、补丁、许可证和校验值，不包含游戏或存档。其他版本请自行验证兼容性。

从源码编译：

```sh
export STS2_GAME_DIR='/path/to/SteamLibrary/steamapps/common/Slay the Spire 2'
bash scripts/build-bridge.sh
```

脚本固定上游源码版本并应用本地补丁，产出 `out/bridge/STS2_MCP.dll` 和 `STS2_MCP.json`。不会覆盖游戏安装，也不会下载或发布游戏本体。

游戏关闭时，将这两个文件放入：

| 系统 | Mod 目录 |
|---|---|
| macOS | 游戏目录下 `SlayTheSpire2.app/Contents/MacOS/mods/` |
| Windows / Linux | 游戏目录下 `mods/`（本项目尚未实测） |

从 Steam 启动，确认首次 Mod 提示后重启。检查：

```sh
curl --noproxy '*' http://127.0.0.1:15526/
```

Mod 只绑定本机；本地程序可控制游戏，浏览器 Origin 请求被拒绝。不要把端口转发到公网。

### 2. 配置 Jev

```sh
cp .env.example .env
# 用编辑器填写 TYPESAFE_API_KEY；不要提交 .env
node --env-file=.env bin/spire.mjs state
```

`state` 只观察。它返回当前局面、可选动作和本次状态标识。主模型应先读取 [操作合同](docs/AGENT.md)。

从终局界面开新局走已支持的正规入口（不会放弃存档，也不会碰设置或多人）：

```sh
node bin/spire.mjs state            # game_over -> game_over 只有 main_menu
node bin/spire.mjs act STATE 0      # 回到主菜单
# 依次：singleplayer -> standard -> 选角色 -> embark
```

`menu` 状态只广告这些安全动作：主菜单的 `continue/singleplayer/compendium/settings`、单人子菜单的 `standard/back`、角色选择的已解锁角色与 `confirm/embark/back`。`abandon_run`、`quit`、`multiplayer`、`daily`、`custom` 和锁定的时间线一律不出现在动作列表里。

### 3. 交给主模型

在当前目录启动自己的 harness，给它一个明确范围，例如“继续当前这一场战斗，打完停在奖励界面”，并让它阅读操作合同。

本机已装好并配置 DeepSeek Harness（DSH）时，可以直接使用：

```sh
node --env-file=.env scripts/dsh.mjs '继续当前这一场战斗，打完停在奖励界面'
```

这会启动本机 DSH headless，沿用它已有的模型配置，不改提供商或账户设置。已实际验证 DSH 读取实时状态、调用动作领取药水生成的卡牌并读回；完整 DSH 独立通关尚未验证。该脚本不是 Reasonix，也不需要 Ollama。

```sh
node --env-file=.env bin/spire.mjs battle 60
```

这条命令会连续使用 Jev，直到战斗结束、达到预算或需要主模型。收到接管包后，主模型从刚返回的选项中选择：

```sh
node bin/spire.mjs act STATE_ID OPTION_ID
```

状态改变后旧标识会被拒绝，不能沿用旧手牌索引。动作发送失败或无法确认结果时会持久停止，避免重复出牌。确认实际局面后才能清除停止标记：

```sh
node bin/spire.mjs state
node bin/spire.mjs clear-halt STATE_ID
node bin/spire.mjs save-strategy STRATEGY.json
```

多个调用方可以读状态，但只能有一个游戏操作者。CLI 锁防止本项目的并发写入；它不能阻止用户或其他 Mod 直接操作游戏。试玩时请勿同时手动出牌。

## 工程说明

- `src/combat.mjs`：已知/未知效果与结果推演的唯一算术。
- `src/decision.mjs`：唯一战术入口（执行一张、执行前缀、或交回）。
- `src/jev.mjs`：薄适配器，只发送、校验和记账。
- `src/runner.mjs` 与 `src/plan.mjs`：单步与多卡前缀共用的已验证发送。
- `src/strategy.mjs`：带 run identity 的显式续行；未匹配不会默认结束回合。
- `bin/spire.mjs`：通用 JSON CLI，含 `save-strategy` / `strategy`。
- `bridge/`：上游版本、许可证和兼容补丁。
- `.runtime/`：私有实测记录与停止标记，默认不进入 Git。

```sh
npm test
npm run check
node scripts/summarize.mjs .runtime/events.jsonl
node scripts/metrics-jsonl.mjs .runtime/events.jsonl --turns 6
```

`metrics-jsonl` 区分每回合的 `turn_ms`（首次出牌到最后一次结算）、`action_ms`（游戏动画与结算）和 `agent_gap_ms`（出牌之间等模型与编排），并统计 `local_decision` 的类别与原因。它只能看到 Jev 的调用；主模型调用次数由调用方 harness 记录。

每次战斗调用最多 100 步，输入 token 预算在请求之间检查。模型失败和游戏动作均不自动重试。数据只发往配置的 Jev 服务；日志不包含 API key。不要公开原始个人存档或本地 harness 配置。

## 卸载

关闭游戏，移走本项目安装的 Mod 文件，再从 Steam 启动。不要直接恢复旧存档覆盖新进度；备份只用于确认需要的恢复。

## 来源与许可证

控制器采用 MIT。游戏桥接基于 Yikun Ji 的 STS2MCP，保留其 [MIT 版权说明](bridge/UPSTREAM-LICENSE)。固定版本见 [SOURCE.json](bridge/SOURCE.json)。仓库不包含游戏程序集、游戏素材、个人存档或凭据。
