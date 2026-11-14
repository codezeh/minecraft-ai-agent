# 恢复演练报告 2026-11-13 23:55:56

- 备份：`E:\我的世界ai\backups\world-20261113-234124`
- 演练目录：`E:\我的世界ai\tmp\drill-20261113-235525`
- 端口：server=25567 rcon=25568
- 结论：**PASS**（PASS 14 / FAIL 0，共 14 条）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | manifest 可读且 schemaVersion>=3 | PASS | schemaVersion=3 entries=7 |
| 2 | 每个压缩包字节与 SHA256 与 manifest 相等 | PASS | 7 个包全部核对通过 |
| 3 | region/*.mca 数与 manifest 相等 | PASS | 世界 3 个维度全部相符 |
| 4 | playerdata/*.dat 数与 manifest 相等 | PASS | 全部相符 |
| 5 | 每个 .mca 头部可解析（扇区表+至少 1 chunk） | PASS | 全部可解析 |
| 6 | 每个 level.dat 是合法 gzip/NBT | PASS | 首字节均为 0x0a（TAG_Compound） |
| 7 | 任务板 integrity_check=ok | PASS | integrity=ok user_version=5 |
| 8 | 任务板 jobs/claims/shared 行数与 manifest 相等 | PASS | jobs=15 claims=0 shared=26 |
| 9 | 每个 bot 的 memory.json 可 JSON 解析 | PASS | 3 个全部可解析 |
| 10 | 启动日志出现 Done ( | PASS | 24s |
| 11 | 启动日志 ERROR 数为 0 | PASS | ERROR=0 Exception=0 |
| 12 | RCON stop 后日志出现 All chunks are saved | PASS |  |
| 13 | server.properties 与配置文件来自备份（非合成） | PASS | properties=True 来源=备份；备份特征键=white-list/enforce-whitelist/difficulty/spawn-monsters；演练口令已注入=True；清单登记 19 个配置文件 |
| 14 | 插件目录与配置从备份还原（≥90% 条目） | PASS | 期望 590 个，实际 591 个；CoreProtect 库=True |
