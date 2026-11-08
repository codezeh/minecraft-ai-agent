# 恢复演练报告 2026-11-08 06:51:42

- 备份：`E:\我的世界ai\backups\world-20261108-034843`
- 演练目录：`E:\我的世界ai\tmp\drill-20261108-065111`
- 端口：server=25567 rcon=25568
- 结论：**PASS**（PASS 12 / FAIL 0，共 12 条）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | manifest 可读且 schemaVersion>=3 | PASS | schemaVersion=3 entries=7 |
| 2 | 每个压缩包字节与 SHA256 与 manifest 相等 | PASS | 7 个包全部核对通过 |
| 3 | region/*.mca 数与 manifest 相等 | PASS | 世界 3 个维度全部相符 |
| 4 | playerdata/*.dat 数与 manifest 相等 | PASS | 全部相符 |
| 5 | 每个 .mca 头部可解析（扇区表+至少 1 chunk） | PASS | 全部可解析 |
| 6 | 每个 level.dat 是合法 gzip/NBT | PASS | 首字节均为 0x0a（TAG_Compound） |
| 7 | 任务板 integrity_check=ok | PASS | integrity=ok user_version=2 |
| 8 | 任务板 jobs/claims/shared 行数与 manifest 相等 | PASS | jobs=0 claims=0 shared=1 |
| 9 | 每个 bot 的 memory.json 可 JSON 解析 | PASS | 3 个全部可解析 |
| 10 | 启动日志出现 Done ( | PASS | 24.4s |
| 11 | 启动日志 ERROR 数为 0 | PASS | ERROR=1 Exception=3（豁免离线网络噪音 4 条，见报告） |
| 12 | RCON stop 后日志出现 All chunks are saved | PASS |  |

## 被豁免的离线网络噪音
- [06:51:32] [Yggdrasil Key Fetcher/ERROR]: Failed to request yggdrasil public key
- com.mojang.authlib.exceptions.MinecraftClientException: Failed to read from https://api.minecraftservices.com/publickeys due to Remote host terminated the handshake
- Caused by: javax.net.ssl.SSLHandshakeException: Remote host terminated the handshake
- Caused by: java.io.EOFException: SSL peer shut down incorrectly
