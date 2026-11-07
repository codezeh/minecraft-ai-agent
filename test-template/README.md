# test-template —— 隔离服 E2E 的**干净模板**

`scripts/e2e.ps1` 每次跑场景都从这里拷一份世界到一次性运行目录（`tmp/e2e/<scenario>/`），
跑完把世界删掉、从模板重建 —— 这就是"重置"的全部机制，也是"中途失败不污染下次"的保证。

## 目录里有什么

| 文件 | 作用 |
|---|---|
| `world/` | **干净的超平坦世界**（Paper 1.21.8 生成，无任何玩家/建筑/掉落物）。E2E 的场地（箱子、熔炉、僵尸、forceload）都在运行目录里现造，从不写回这里 |
| `server.properties` | 测试服配置模板：端口 **25566**、RCON **25576**、`level-type=minecraft\:flat`、`online-mode=false`、`white-list=false`、`spawn-protection=0`、只绑 `127.0.0.1` |

`rcon.password` 写的是占位符 **`__E2E_RCON_PASSWORD__`**：`e2e.ps1` 每次运行生成一个随机密码替换它，
所以仓库里**没有可用的真实密码**，密码也不会进日志（`tools/rcon.mjs` 只打"已生成"）。

## 为什么不直接把 `server-test/` 当模板

`server-test/` 是日常手工开测试服用的工作目录，它**不在版本控制里**（父仓 `.gitignore`），
里面还有 `world/`（124MB，bot 跑过的地形/建筑）、`logs/`、`plugins/` 的历史状态。
拿它当模板有两个问题：换台机器 clone 下来根本没有；而且"跑过的世界"不是干净起点，断言会受上次残留影响。

所以这里的模板是**最小可复现**的一份：世界只有出生区，配置只有测试端口。

## 怎么重新生成模板世界（一般不需要）

```powershell
# 1) 建个一次性的运行目录（自己拼，或用 e2e.ps1 生成后 -KeepRun 保留）
# 2) 在里面起服一次，让它按 server.properties 的 flat 参数生成 world/：
#    然后 RCON 发 save-all flush + stop，确认进程退出
# 3) 把生成出来的 world/ 复制回 test-template/world，并删掉 session.lock：
#    Remove-Item test-template/world/session.lock
```

判断"世界是不是干净"的办法：`Get-WorldFingerprint`（`e2e.ps1` 里的函数）对模板与运行目录逐文件算
sha256，跑之前/重置之后都必须**完全相等** —— 这也是 E2E 自己断言的两条：
`起服前世界 = 模板世界（干净起点）`、`重置后世界 = 模板世界（重置生效）`。

## 依赖

模板本身只含世界与配置。起服还需要（都不在本目录）：

- `server/server.jar`（Paper 1.21.8）
- `.tools/jdk-21*/bin/java.exe`（JDK 21）
- `server-test/{libraries,versions,cache}` —— `e2e.ps1` 用 **junction** 复用它们（Paper 的
  libraries+versions+cache 合计约 158MB，没必要每次拷贝）；`cache/mojang_1.21.8.jar` 必须在，
  否则 Paperclip 会尝试联网下载（本机实测无外网时启动直接失败）。
