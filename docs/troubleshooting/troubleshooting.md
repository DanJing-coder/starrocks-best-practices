# 故障处理

本章旨在提供一个系统性的故障处理框架，帮助您在遇到 StarRocks 集群问题时，能够快速、有效地定位并解决问题。

## 1. 故障排查基本思路

一个有效的故障排查流程通常遵循以下步骤：

1.  **明确现象：** 问题的具体表现是什么？是节点宕机、导入失败，还是查询变慢？
2.  **收集信息：** 利用 StarRocks 提供的各种工具（SQL 命令、日志、监控、Profile）收集与现象相关的上下文信息。
3.  **分析原因：** 基于收集到的信息，结合 StarRocks 的工作原理，分析导致问题的可能原因。
4.  **验证假设：** 对可能的根本原因进行验证。
5.  **解决问题：** 采取相应的措施解决问题。
6.  **复盘总结：** 记录问题、原因和解决方案，形成知识库，并思考如何从流程或系统层面避免问题再次发生。

## 2. 核心排查工具

*   **SQL 命令:**
    *   `SHOW FRONTENDS;` / `SHOW BACKENDS;`: 查看 FE/BE 节点的状态，是排查节点问题的第一步。
    *   `SHOW PROC '/';`: 访问 StarRocks 的 Proc 系统，可以获取大量内部状态信息，如 Tablet 状态、集群负载均衡情况等。
    *   `SHOW LOAD;` / `SHOW ROUTINE LOAD;`: 查看导入任务的状态和错误信息。
    *   `ADMIN SHOW REPLICA STATUS;`: 检查副本的健康状况。

*   **日志文件:**
    *   **`fe.log`:** FE 的运行日志，记录了元数据操作、任务调度等信息。
    *   **`be.INFO`:** BE 的运行日志，记录了查询执行、Compaction、数据导入等详细信息。是排查 BE 问题的核心。
    *   **`fe.audit.log`:** 审计日志，用于分析查询历史、慢查询和用户行为。

*   **监控系统 (Prometheus + Grafana):**
    *   通过监控大盘可以直观地看到集群的 CPU、内存、I/O、网络等资源使用趋势，以及 QPS、查询延迟等核心业务指标。

*   **Query Profile:**
    *   对于慢查询问题，Query Profile 是最强大的分析工具。它详细记录了查询在每个阶段、每个算子上的耗时和处理的数据量，可以帮助您精确定位性能瓶颈。

## 3. 常见故障场景与排查指南

以下是一些常见的故障场景及其排查思路。

### 3.1 节点故障 (FE / BE Down)

*   **现象:**
    *   `SHOW FRONTENDS;` 或 `SHOW BACKENDS;` 中，对应节点的 `Alive` 状态为 `false`。
    *   连接 FE 或 BE 的端口失败。
    *   监控系统触发节点离线告警。
*   **排查思路:**
    1.  **登录服务器:** 登录到故障节点服务器。
    2.  **检查进程:** 使用 `ps -ef | grep starrocks` 检查 `StarRocksFe` 或 `starrocks_be` 进程是否存在。
    3.  **检查端口:** 使用 `netstat -ntlp` 检查相关端口是否被监听。
    4.  **查看日志:**
        *   如果进程不存在，查看对应组件的 `.out` 日志（如 `fe.out`）和 `.log` 日志，查找启动失败的原因。
        *   最常见的原因是 **OOM (Out of Memory)**，可以检查系统日志（如 `/var/log/messages`）中是否有 `oom-killer` 的记录。
    5.  **检查硬件:** 检查服务器的 CPU、内存、磁盘和网络是否正常。

### 3.2 导入问题

#### a. 导入任务超时

*   **现象:** `SHOW LOAD` 状态为 `CANCELLED`，错误信息为 `load reached timeout`。
*   **排查与解决方案:**
    *   请参考详细指南：导入任务超时 (Load Reached Timeout)

#### b. 数据质量问题

*   **现象:** `SHOW LOAD` 状态为 `CANCELLED`，错误信息包含 `ETL_QUALITY_UNSATISFIED` 或 `TypeConvertError`。
*   **排查思路:**
    1.  从 `SHOW LOAD` 的结果或 Stream Load 的返回 JSON 中找到 `ErrorURL`。
    2.  访问该 URL，查看具体的错误行和错误原因。
    3.  根据错误信息清洗源头数据，或调整建表语句中的字段类型。

### 3.3 查询性能问题 (慢查询)

*   **现象:** 特定 SQL 查询耗时远超预期，或集群整体 CPU/内存使用率过高。
*   **排查思路:**
    1.  **获取 Profile:** 为慢查询开启 Profile (`SET enable_profile=true;`) 并执行，然后通过 `SHOW PROFILELIST;` 获取 `Query ID`，再通过 `SHOW PROFILE FOR QUERY <query_id>;` 查看详细 Profile。
    2.  **分析 Profile:**
        *   找到耗时最长的算子（Operator）。
        *   检查 `Scan` 算子的 `RowsRead` 是否过大，是否有效利用了分区和索引。
        *   检查 `HashJoin` 算子是否发生了溢写 (`Spill`)。
    3.  **分析执行计划:** 使用 `EXPLAIN` 查看优化器选择的执行计划是否合理，特别是 Join 顺序和 Join 类型。
    4.  **检查统计信息:** 确认相关表的统计信息是否已收集且为最新。过时的统计信息会导致 CBO 做出错误的决策。

### 3.4 磁盘空间问题

*   **现象:** 收到磁盘使用率告警，导入任务报 `disk reach capacity limit`。
*   **排查与解决方案:**
    *   请参考详细指南：磁盘空间不足

### 3.5 Tablet 副本问题

*   **现象:** `SHOW PROC '/statistic';` 中 `abnormal_tablets_num` 的值大于 0。
*   **排查思路:**
    1.  执行 `ADMIN SHOW REPLICA STATUS FROM your_db.your_tbl WHERE status != 'OK';` 来定位具体的异常副本及其原因（如 `VERSION_ERROR`, `SCHEMA_ERROR`）。
    2.  对于大部分副本问题，可以尝试使用 `ADMIN REPAIR TABLE your_db.your_tbl;` 来让系统自动进行修复。
    3.  如果自动修复失败，可以根据具体的错误状态，考虑使用 `ADMIN SET REPLICA STATUS` 命令手动将异常副本设置为 `BAD`，强制系统使用其他健康副本重新克隆一个新的副本。**此为高危操作，请谨慎执行。**