# 故障处理：导入任务超时 (Load Reached Timeout)

导入任务超时是数据导入过程中常见的错误之一。它通常表现为客户端收到超时错误，或者在 `SHOW LOAD` 命令中看到任务状态为 `CANCELLED`，错误信息为 `reached timeout`。

这通常意味着数据写入过程的某个环节耗时过长，超过了指定的 `timeout` 限制。排查此问题需要系统性地检查从数据源到 StarRocks 内部处理的整个链路。

## 现象

*   **Stream Load:** HTTP 客户端返回超时错误，或返回的 JSON 中 `Status` 为 `Fail`，`Message` 包含 `reached timeout`。
*   **Broker Load / Routine Load:** `SHOW LOAD` 命令的结果中，任务的 `State` 为 `CANCELLED`。
*   在 FE 日志 (`fe.log`) 中可以搜索到 `cancel load job with label: ... due to timeout` 的记录。

## 排查步骤

### 1. 查看导入任务详情

这是排查的第一步。通过 `SHOW LOAD` 命令找到超时的任务，并关注以下几个时间点：

```sql
SHOW LOAD WHERE `label` = 'your_load_label';
```

*   `CreateTime`: 任务创建时间。
*   `EtlStartTime`, `EtlFinishTime`: 数据预处理阶段。如果这里耗时很长，通常是数据质量或格式转换问题。
*   `LoadStartTime`, `LoadFinishTime`: 实际数据写入阶段。如果这里耗时很长，问题通常出在 BE 端。

通过分析哪个阶段耗时最长，可以初步定位问题的方向。

### 2. 检查集群资源负载

导入操作会消耗 BE 节点的 CPU、内存和磁盘 I/O。如果集群资源紧张，导入任务就会变慢。

*   **监控大盘 (Grafana):** 查看导入时间段内，BE 节点的 **CPU 使用率**、**内存使用率** 和 **磁盘 I/O**。
    *   如果 CPU 持续高位（如 > 80%），可能是 Compaction 压力过大或查询负载过高。
    *   如果磁盘 I/O 饱和，说明磁盘性能成为瓶颈。

### 3. 检查 Compaction 状态

高频或大量的数据写入会给后台 Compaction 带来压力。如果 Compaction 速度跟不上写入速度，会导致版本积压，从而严重影响后续的写入性能。

*   **监控指标:** 关注 `starrocks_be_compaction_score` 指标。如果该值持续很高（如 > 100），说明存在 Compaction 积压。
*   **诊断命令:** 参考 Compaction 原理 章节中的诊断命令，检查具体是哪些 Tablet 的 Compaction 存在问题。

### 4. 检查网络状况

*   **客户端到 BE:** 检查发起导入的客户端与 BE 节点之间的网络延迟和带宽。
*   **BE 节点之间:** BE 节点间需要通过网络进行副本同步。如果节点间网络存在瓶颈，也会拖慢整体的写入速度。

### 5. 检查数据模型设计

*   **Tablet 数量:** 不合理的分区和分桶设计可能导致单个表产生过多的 Tablet。过多的 Tablet 会增加 FE 的调度开销和 BE 的管理负担，从而影响导入性能。

## 解决方案

### 1. 临时解决方案：增加超时时间

最直接的方法是在导入请求中增加 `timeout` 参数的值（单位：秒）。

*   **Stream Load:** 在 HTTP Header 中设置 `timeout: 1800` (30分钟)。
*   **Broker Load:** 在 `PROPERTIES` 中设置 `"timeout" = "1800"`。

> **注意:** 这通常是治标不治本的方法。如果不是因为单次导入数据量确实巨大，应优先排查并解决根本原因。

### 2. 根本解决方案：优化与调整

*   **优化导入批次:**
    *   **避免高频小批量导入:** 这是导致 Compaction 压力和 FE 调度压力的主要原因。应在数据源侧进行**微批合并**，降低导入频率，增大单批次的数据量。
    *   **避免单批次过大:** 单个导入任务过大（如几十上百 GB）会长时间占用资源。建议将超大任务拆分成多个较小的任务。
*   **优化集群资源:**
    *   如果监控显示资源（CPU, I/O）确实成为瓶颈，应考虑**扩容 BE 节点**或**升级硬件**（如使用更高性能的 SSD）。
*   **优化数据模型:**
    *   如果 Tablet 数量过多，应重新审视表的**分区和分桶**策略，适当减少分桶数或调整分区粒度。
*   **调整 BE 配置:**
    *   如果存在 Compaction 积压，可以适当增加 `base_compaction_threads` 和 `cumulative_compaction_threads` 的数量，以提升 Compaction 并发能力。