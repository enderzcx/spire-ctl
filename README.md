# spire-ctl

**给 agent 用的《杀戮尖塔 2》控制面。** 一个 JSON 状态契约、一份合法动作清单、一套不会重放的执行层——任何能跑命令、读 JSON 的 harness 都能驱动游戏。零 npm 依赖。

不截图、不做视觉识别、不模拟点击：通过本地 Mod 读结构化状态，调用游戏原有的动作队列。

```text
你的 agent（任何 harness）
        ↓  state / act / seq
   spire-ctl：合法动作枚举 → 校验发送 → 结算核对
        ↓  游戏原有动作队列
    STS2 本地桥接（Mod）
```

## 它保证什么

这个项目的价值不在"能玩"，而在**出错时的行为**：

| 保证 | 含义 |
|---|---|
| **拒绝旧状态** | 状态一变，旧标识立即失效，不能沿用上一轮的手牌索引 |
| **单写者锁** | 同一端口只允许一个操作者；两个 agent 不会同时出牌 |
| **不自动重试** | 发送失败或结果无法确认 → **持久停止**，等人核实，绝不重发 |
| **结算核对** | 每个动作读回确认；没确认就不算完成 |
| **非法动作发不出去** | 动作只来自游戏自己广告的选项，不自造 ID |
| **算不清就停** | 未知机制、空意图、无法覆盖的致命攻击 → 交回调用方，不猜 |

## 它不承诺什么

**不是自动通关机器人。** 决策归你（或你的模型），spire-ctl 只保证"决定下来的动作被合法、可核对地执行"。默认没有取胜策略，也没有胜率保证。

## 快速开始

### 1. Mod（必需）

下载 [sts2-bridge Releases](https://github.com/enderzcx/sts2-bridge/releases) 里对应平台的包，按 `INSTALL.txt` 放进 Mod 目录。**先关闭游戏并备份存档。**

验证桥接：

```sh
curl --noproxy '*' http://127.0.0.1:15526/
# {"message":"Hello from STS2 MCP v0.4.0","status":"ok"}
```

Mod 只绑定回环地址。**不要把端口转发到公网。**

### 2. 控制器

```sh
git clone https://github.com/enderzcx/spire-ctl.git && cd spire-ctl
node bin/spire.mjs state        # 只读：当前局面、可选动作、状态标识
```

`state` 不改变任何东西。先读 [操作合同](docs/AGENT.md)。

### 3. 接管

```sh
node bin/spire.mjs seq STEPS.json     # 一次提交一整回合的既定动作
node bin/spire.mjs act STATE_ID OPTION_ID
```

CLI 全部命令：

| 命令 | 用途 |
|---|---|
| `state` | 读状态、合法动作、路由原因、本次状态标识 |
| `act STATE_ID OPTION_ID` | 执行**一个**动作 |
| `seq STEPS.json` | 执行**一串**已决定的动作，逐步重读逐步校验 |
| `plan PLAN.json` | 带预测的多卡前缀（预测不符即停） |
| `battle [MAX] [STRATEGY.json]` | 交给可选的快速决策模型连续打 |
| `advance [MAX]` | 只做机械推进（领金币、推进对话、固定按钮） |
| `clear-halt STATE_ID` | 核实实际局面后，清除停止标记 |
| `strategy` / `save-strategy` | 查看/保存显式续行条件 |

### `seq`：为什么它比逐张 `act` 好

逐张出牌 = 每张一次进程启动 + 一次 HTTP + 调用方重读一遍完整 JSON。而且 `card_index` 是**位置**——打掉一张，后面所有索引都会漂移（实测踩过：本想打剑柄打击，落到了灰烬打击上）。

`seq` 让你一次提交整回合，并且**按卡牌 id 指定**而不是位置：

```json
{
  "expected_state_id": "…",
  "steps": [
    {"card": "FLAME_BARRIER"},
    {"card": "TOXIC"},
    {"card": "DEFEND_IRONCLAD"},
    {"action": "end_turn"}
  ]
}
```

每一步都从新的已结算状态重新解析、重新匹配游戏广告的动作，再走**和 `act` 完全相同**的事务（旧状态拒绝、单写锁、停止标记、结算核对）。任何一步不再被广告——牌离手了、目标死了、回合结束了——**序列在打出任何东西之前停下**，并把当时的可用动作返回给你。

它也适用于非战斗界面：一次买齐商店、一趟领完奖励。

## 分工

程序负责**算术与合法性**，调用方负责**决定**：

| 场景 | 谁 |
|---|---|
| 等待动画结算、核对旧状态 | 程序 |
| 动作是否合法、目标是否存在、能量是否够 | 程序 |
| 精确伤害/格挡/斩杀线（基于游戏自己算好的意图） | 程序 |
| 出哪张牌、打哪个敌人、药水取舍、路线、构筑 | **调用方** |
| 陌生意图、可能致命且挡不下、结果无法确认 | 程序停下，交回调用方 |

`battle` 里可以挂一个可选的快速决策模型（默认 TypeSafe Jev）来接管普通战斗回合；**不用它完全可以**——`state` + `act` + `seq` 就是完整闭环。详见 [docs/AGENT.md](docs/AGENT.md) 与 [决策层级](docs/DECISION-LEVELS.md)。

## 在 DeepSeek Harness 里用（可选）

同一个包既是 CLI 也是 DSH 插件，**一条命令**：

```sh
dsh plugin --profile web add github:enderzcx/spire-ctl
```

装完 `spire_state` / `spire_act` / `spire_seq` / `spire_advance` 等原生工具就能直接调用，不用拼 shell 命令。

**核心运行时不依赖 DSH。** `bin/` 与 `src/` 从不 import 适配器，`@deepseek-ai/dsh-tools` 是**可选** peer 依赖——所以别的 harness（Claude Code、纯 shell、自己的 agent）照样能只用 CLI。这条边界由 `test/boundary.test.mjs` 守住。

其他 harness 照旧：

```sh
node bin/spire.mjs state
```

## 从终局开新局

正规入口，不碰存档、不碰设置、不进多人：

```sh
node bin/spire.mjs state          # game_over → 只有 main_menu
node bin/spire.mjs act STATE 0    # 回主菜单
# 依次 singleplayer → standard → 选角色 → embark
```

`menu` 只广告安全动作：`continue/singleplayer/compendium/settings`、`standard/back`、已解锁角色与 `confirm/embark/back`。`abandon_run`、`quit`、`multiplayer`、`daily`、`custom` 和锁定时间线**一律不出现**。

## 工程

- `src/game.mjs` — 状态 → 合法动作广告；`route()` 决定谁来决策
- `src/dispatch.mjs` —**唯一的发送事务**：锁、停止标记、结算核对、事件日志
- `src/runner.mjs` — `battle` / `advance` / `sequence` 三个循环
- `src/combat.mjs` — 已知/未知效果与结果推演的唯一算术
- `src/contract.mjs` — 面向消费者的稳定状态契约（如商店条目统一命名）
- `src/decision.mjs` + `src/jev.mjs` —**可选的**快速决策模型适配
- `bin/spire.mjs` — 通用 JSON CLI
- `scripts/probe-api.mjs` — 只读接口探针：逐界面核对决策所需字段是否齐全

```sh
npm test                                   # 离线回归
npm run check                              # 语法与静态检查
node scripts/probe-api.mjs                 # 需要游戏在跑
node scripts/metrics-jsonl.mjs .runtime/events.jsonl --turns 6
```

`metrics-jsonl` 区分 `turn_ms`（首次出牌到结算）、`action_ms`（游戏动画）与 `agent_gap_ms`（出牌之间等模型/编排），并统计本地决策的类别与原因。

**离线测试不能证明游戏兼容性。** 每个真实局面都只能对着跑起来的游戏验证。

多处调用可以并发**读**，但只能有一个操作者。锁只防本项目自己；它挡不住你手动出牌或其他工具直接操作游戏。

## 兼容性

在 **macOS arm64、游戏 v0.107.1** 上验证。游戏或上游 Mod 的 API 变化可能让字段改名——那样控制器会**明确报错**而不是静默继续。支持范围与未验证场景见 [验证记录](docs/VALIDATION.md)。

## 卸载

关闭游戏，移走 Mod 文件，从 Steam 重启。不要拿旧存档覆盖新进度；备份只为确认需要的恢复。

## 来源与许可证

MIT。Mod 是 [sts2-bridge](https://github.com/enderzcx/sts2-bridge)，基于 Yikun Ji 的 [STS2MCP](https://github.com/Gennadiyev/STS2MCP)（MIT）并附一个补丁。

**本仓库不包含游戏程序集、游戏素材、个人存档或任何凭据。** 日志里不含 API key。
