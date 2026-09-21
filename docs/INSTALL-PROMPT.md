# 安装提示词

把下面整段复制给你的 agent（DSH、Claude Code 或任何能跑命令的 harness）。它会自己完成全部安装并验证。

---

## 提示词（复制这一段）

```
帮我把「用 agent 玩《杀戮尖塔 2》」装好，按顺序做，每步做完先给我看结果再继续：

1. 先做环境检查，不要改动任何东西：
   - 运行 `node --version`，需要 22 或更高
   - 找到《杀戮尖塔 2》的安装目录（macOS 常见位置是
     ~/Library/Application Support/Steam/steamapps/common/Slay the Spire 2，
     也可能在 Steam 的其他库目录里，读 steamapps/libraryfolders.vdf 能看到）
   - 如果找不到游戏，停下来告诉我，不要猜路径

2. 安装控制器（一个包，既是命令行也是 DSH 插件）：
   dsh plugin --profile web add github:enderzcx/spire-ctl
   （headless 用户把 web 换成 headless；不是 DSH 用户就直接 git clone 这个仓库）
   装完运行 `dsh plugin --profile web list | grep spire` 确认，并告诉我版本号

3. 装游戏 Mod。这一步要写进游戏目录，所以严格按顺序：
   a. 先用 `ps` 确认游戏没在运行。如果在运行，停下来让我先关掉
   b. 备份存档目录（只复制一份，不要覆盖任何东西），告诉我备份到哪了
   c. 从 https://github.com/enderzcx/sts2-bridge/releases 下载最新的
      macOS 包（文件名形如 sts2-bridge-macos-*.zip），解压到一个临时目录
   d. 先不加 --yes 跑一次，把计划给我看：
      node <spire-ctl>/bin/spire.mjs doctor --install-mod <解压目录>
   e. 我确认后，再加 --yes 真正安装。它会用包里的 SHA256SUMS 校验每个文件，
      校验不过就拒绝写入——如果被拒绝，把原因告诉我，不要绕过

4. 验证（游戏要先启动）：
   - 从 Steam 启动游戏，接受 Mod 提示后重启
   - node <spire-ctl>/bin/spire.mjs doctor
     期望：problems 为空、bridge.reachable 为 true
   - curl --noproxy '*' http://127.0.0.1:15526/
     期望：{"message":"Hello from STS2 MCP v0.4.0","status":"ok"}
   - node <spire-ctl>/bin/spire.mjs state
     期望：返回当前局面和合法动作

5. 全部成功后，告诉我三件事：装的是哪个版本、Mod 目录的完整路径、以及
   `state` 读到的当前界面是什么。任何一步失败就停下报告，不要跳过或重试写入。

注意：不要修改游戏文件以外的任何东西，不要覆盖存档，不要把 15526 端口
转发到公网。
```

---

## 每一步在做什么

| 步骤 | 为什么需要 |
|---|---|
| 1. 环境检查 | 游戏可能装在**非默认的 Steam 库**里（我就遇到过在移动硬盘上），猜路径会装错地方 |
| 2. 装控制器 | 一个命令。同一个包既是 CLI 也是 DSH 插件，所以不会出现"插件和核心版本对不上" |
| 3. 装 Mod | **唯一需要写进游戏目录的一步。** 先 dry-run 看计划、校验 SHA256、拒绝在游戏运行时写入 |
| 4. 验证 | 桥接是"通了才有意义"的东西，所以每一步都要看到实际响应而不是"应该好了" |
| 5. 报告 | 出问题时你需要知道装的是哪个版本、文件在哪 |

## 为什么不让 agent 全自动

- **备份存档**：agent 应该备份而不是覆盖。这条写在提示词里是硬要求。
- **`--yes` 分开两步**：先看计划再执行，避免在错误目录里写入。
- **拒绝即停止**：校验失败说明下载的包不完整或被改过，绕过它比失败更糟。

## 装完之后

```sh
node bin/spire.mjs state          # 读局面
node bin/spire.mjs doctor         # 随时体检
```

在 DSH 里可以直接用原生工具：`spire_state`、`spire_act`、`spire_seq`（推荐，一次提交整回合）、`spire_advance`。

玩法和分工见 [操作合同](AGENT.md)。
