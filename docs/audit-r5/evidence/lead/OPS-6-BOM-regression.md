# Lead 交叉复核：OPS-6（start-panel.ps1 缺 BOM → 面板起不来）的引入点

时间: 2026-11-08T16:04:09+08:00
机器编码: ANSI=cp936 (gb2312)

## 1. 全仓 ps1 的 BOM 实测（scripts/ 下）
```
efbbbf  scripts/backup-world.ps1
efbbbf  scripts/deny-rcon-25575-in.ps1
efbbbf  scripts/e2e.ps1
efbbbf  scripts/harden-credentials-acl.ps1
efbbbf  scripts/install-backup-task.ps1
efbbbf  scripts/release.ps1
efbbbf  scripts/restore-drill.ps1
23204d  scripts/start-panel.ps1
efbbbf  scripts/stop-panel.ps1
efbbbf  scripts/verify-world-backup.ps1
efbbbf  scripts/lib/backup_config.ps1
efbbbf  scripts/lib/rcon.ps1
efbbbf  scripts/tests/fake-rcon-server.ps1
efbbbf  scripts/tests/rcon-regression.ps1
```

## 2. 三个历史版本 ParseFile 实测（同一台机器、同一编码环境）
```
40e29d6  head=(239,187,191)=EF BB BF  ParseErrors=0
af4aa22  head=(35,32,77)=23 20 4D     ParseErrors=7
57499b7  head=(35,32,77)=23 20 4D     ParseErrors=8
工作树   head=(35,32,77)=23 20 4D     ParseErrors=8
```

## 3. 引入点：af4aa22 的 diff 第一行即删除 BOM
```
diff --git a/scripts/start-panel.ps1 b/scripts/start-panel.ps1
index 009e25a..feb918d 100644
--- a/scripts/start-panel.ps1
+++ b/scripts/start-panel.ps1
@@ -1,4 +1,4 @@
-﻿# Minecraft AI 陪玩面板 —— 一键启动
+# Minecraft AI 陪玩面板 —— 一键启动
 # 由 启动面板.bat 调起。所有中文都在这里（UTF-8+BOM），cmd 那层只留 ASCII。
 #
 # 设计要点（都是实测踩出来的）：
@@ -269,7 +269,11 @@ if (-not $tok) {
     Read-Host '按回车退出'
```

## 4. 反证：面板在 10-30/10-31 确实跑过（那时还是 40e29d6 之前的有 BOM 版本）
```
total 32
drwxrwxrwx 1 zeh zeh     0 Nov  8 12:46 .
drwxrwxrwx 1 zeh zeh  4096 Nov  8 13:16 ..
-rwxrwxrwx 1 zeh zeh  1572 Nov  8 13:10 backup-auto.log
-rwxrwxrwx 1 zeh zeh     0 Oct 30 19:23 mindcraft-console.err.log
-rwxrwxrwx 1 zeh zeh  3320 Oct 31 01:40 mindcraft-console.log
-rwxrwxrwx 1 zeh zeh   126 Oct 30 19:23 server-console.err.log
-rwxrwxrwx 1 zeh zeh 21090 Oct 31 01:40 server-console.log
```

## 结论
OPS-6 成立，但性质修正：**不是长期存在**，是 `af4aa22`（2026-11-06 16:05，fix(security) 批次1，OPS-001 修复）引入的回归。
该提交修 OPS-001 的同时把文件存成无 BOM，导致 PS 5.1 在 cp936 下解析 7~8 条 ParserError ⇒ `启动面板.bat` 退出码非 0。
