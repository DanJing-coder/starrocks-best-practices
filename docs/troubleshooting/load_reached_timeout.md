# 故障处理：导入任务超时 (Load Reached Timeout)

导入任务超时是数据导入过程中最常见的错误之一。它通常表现为客户端收到超时错误，或者在 `SHOW LOAD` 命令中看到任务状态为 `CANCELLED`，错误信息为 `Label: ..., State: CANCELLED, ErrorMsg: reached timeout`。

这通常意味着数据写入过程的某个环节耗时过长，超过了用户指定的 `timeout` 或系统默认的超时限制。排查此问题需要系统性地检查从数据源到 StarRocks 内部处理的整个链路，定位性能瓶颈。

## 现象

*   **Stream Load:** HTTP 客户端返回超时错误，或返回的 JSON 中 `Status` 为 `Fail`，`Message` 包含 `reached timeout`。
*   **Broker Load / Insert Into:** `SHOW LOAD` 命令的结果中，任务的 `State` 为 `CANCELLED`。
*   在 FE 日志 (`fe.log`) 中可以搜索到 `cancel load job with label: ... due to timeout` 的记录。

## 导入原理

### 整体流程

一次导入大致可以分为如下环节,其中数据写入环节最复杂,也是出问题最多的

1.  数据读取,不同导入方式数据源不同
    *   Stream Load: HTTP数据流
    *   Routine Load: Kafka
    *   Broker Load: Files
    *   INSERT INTO: Query执行结果
2.  数据写入:数据 shuffle 到 tablet 进行持久化
3.  Publish: Tablet 修改元数据使数据可见,对于主键表还涉及更新primary index等复杂操作

### 数据写入

主要有两部分工作

*   Coordinator BE 将数据 shuffle 到 tablet 所在的 Executor BE,可能有多个 Coordinator BE
*   Tablet 将数据进行持久化,对于存算一体(replicated storage), Tablet 主副本还负责将数据sync到从副本

以存算一体为例说明一个tablet的数据写入主要涉及的步骤,存算分离没有主从副本之间的同步,其它和存算一体基本一致

*   OlapTableSink: 接收上游的数据并把数据 shuffle 到tablet的主副本,数据 shuffle 通过 brpc接口 `tablet_writer_add_chunks`
*   Primary Replica
    *   `brpc tablet_writer_add_chunks`:收到OlapTableSink发送的数据后做一些简单处理,避免阻塞brpc线程池,IO等阻塞操作提交异步任务给 async_delta_writer 来做,然后借助bthread非阻塞等待任务完成,使用brpc thread pool
    *   Asyn delta writer:负责将数据写入memtable、导入完成commit,使用 asyn_delta_writer thread pool
        *   如果memtable满了或者commit,会提交异步任务执行memtable flush
        *   commit 阶段需要等待 memtable flush、数据同步到从副本。对于主键表,如果BE配置`skip_pk_preload` 为 false,可能还涉及重建primary index、preload等复杂操作
    *   Memtable flush:将memtable写到磁盘生成segment,并提交异步任务segment replicate sync,将segment同步给从副本,使用 memtable_flush thread pool
    *   Segment replicate sync:通过 brpc 接口 `tablet_writer_add_segment` 将segment同步给从副本,阻塞等待同步成功,使用 segment_replicate thread pool
*   Secondary Replica
    *   `brpc tablet_writer_add_segment`:收到主副本同步的segment后,提交异步任务segment flush执行数据写入,使用brpc thread pool
    *   Segment flush:将segment持久化到磁盘,如果是导入结束还会执行commit,完成后对brpc进行回复。对于主键表commit,如果BE配置 `skip_pk_preload` 为false,可能还涉及重建primary index、preload等复杂操作

### BRPC交互

*   Coordinator BE -> Primary Replica
    *   `tablet_writer_open`: 初始化tablet writer
    *   `tablet_writer_add_chunks`: 把数据发送给tablet主副本
*   Coordinator BE -> Secondary Replica
    *   `tablet_writer_open`: 初始化 tablet writer
*   Primary Replica -> Secondary Replica
    *   `tablet_writer_add_segment`: 主副本把数据同步给从副本

### 各线程池以及对应的BE 配置

| Thread pool 名称             | 配置                           | 默认值          | 队列大小 | 支持动态修改 |
| ---------------------------- | ------------------------------ | --------------- | -------- | ------------ |
| brpc                         | brpc_num_threads             | -1 (#CPU core)  | 没限制   | false        |
|                              | number_tablet_writer_threads | 16              | 40960    | true         |
| asyn_delta_writer           |                                |                 |          |              |
| memtable_flush              | flush_thread_num_per_store   | 2               | INT_MAX | true         |
|                              | lake_flush_thread_num_per_store | 0 (2 * #CPU core) | INT_MAX | true         |
| segment_replicate           | flush_thread_num_per_store   | 2               | INT_MAX | true         |
| segment_flush               | flush_thread_num_per_store   | 2               | INT_MAX | true         |

### 超时配置

导入链路上一些超时配置参考 [导入超时配置](https://docs.starrocks.io/docs/loading/loading_introduction/loading_considerations/)

## 排查思路

排查导入超时问题的核心思路是**自顶向下，层层深入**：首先从宏观的导入任务状态入手，定位耗时最长的阶段；然后深入到具体的组件（FE、BE）和资源（CPU、磁盘、网络），找到性能瓶颈。

导入慢的常见现象有以下几种,先根据现象确定数据读取、写入和publish哪个环节慢,然后对慢的环节进一步分析

| 现象                               | 分析                                           |
| ---------------------------------- | ---------------------------------------------- |
| 导入成功,但耗时长                  | 读取+写入+ publish 整体耗时长                  |
| 导入失败,报错 Timeout by txn manager | 读取+写入慢                                    |
| 导入失败,报错 [E1008]Reached timeout | 写入慢,存储层慢导致 Coordinator BE -> Exectuor BE BRPC 超时 |
| 导入报错 publish timeout           | publish慢,主键表出现较多                       |

### 1. 定位超时阶段

这是排查的第一步。通过 `SHOW LOAD` 命令找到超时的任务，并关注其生命周期中的几个关键时间点，以判断延时发生在哪里。

```sql
SHOW LOAD WHERE `label` = 'your_load_label';
```

*   `CreateTime`: 任务创建时间。
*   `EtlStartTime`, `EtlFinishTime`: 数据预处理阶段。如果这里耗时很长，通常是数据质量或格式转换问题。
*   `LoadStartTime`, `LoadFinishTime`: 实际数据写入阶段。如果这里耗时很长，问题通常出在 BE 端。

通过分析哪个阶段耗时最长，可以初步定位问题的方向。

Timeout by txn manager 可以通过 profile 确定是读取慢还是写入慢,导入 profile 使用方法参考 [StarRocks导入运维手册](https://docs.starrocks.io/zh/docs/loading/loading_profile/)

*   通过 OLAP_TABLE_SINk 耗时判断是否是写入慢
*   通过 CONNECTOR_SCAN/FileScanNode 耗时判断是否是读取慢,如果是 INSERT INTO 导入,其中的 select query可能比较复杂,需要是否是 query 耗时

导入成功,耗时长 可以通过如下步骤进一步确定是哪个环节慢

a.  FE Transaction 日志分析:导入完成后对应的 transaction 会在FE 日志里记录 write(数据读取+数据写入)和publish阶段的耗时,可以根据日志判断是 write 还是 publish 慢
    i.  首先需要确定导入的 label 或 txn_id,然后执行如下命令
        ```bash
        # 已知 txn_id
        cat fe.log | grep "txn_id: 1189" | grep "finishTransaction"
        # 已知 label
        cat fe.log | grep "label: insert_78a0fe64-540d-11f0-bb4c-1efd9bcf5b66" | grep "finishTransaction"
        ```
    ii. 日志样例如下,其中 "write cost" 和 "publish total cost" 分别是 write 和 publish 的耗时
        ```
        2025-06-28 10:48:48.802Z INFO (PUBLISH_VERSION|25) [DatabaseTransactionMgr.finishTransaction():1214] finish transaction TransactionState. txn_id: 1189, label: insert_78a0fe64-540d-11f0-bb4c-1efd9bcf5b66, db id: 10002, table id list: 12816, callback id: 12852, coordinator: FE: 127.0.0.1, transaction status: VISIBLE, error replicas num: 0, replica ids: , prepare time: 1751107728397, write end time: 1751107728635, allow commit time: -1, commit time: 1751107728640, finish time: 1751107728794, write cost: 243ms, wait for publish cost: 6ms, publish rpc cost: 134ms, finish txn cost: 14ms, publish total cost: 154ms, total cost: 397ms, reason: attachment: com.starrocks.transaction.InsertTxnCommitAttachment@473c782c successfully
        ```
b.  如果是 write 慢,可以根据 profile 进一步分析是数据读取还是写入慢

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

### 6. 读取慢排查

*   Stream Load 可能原因
    *   HTTP客户端到 StarRocks 集群的网络慢
    *   使用json 格式导入,一批数据量大,json 解析慢。可以减小批次,或尝试 csv 格式
*   Routine Load 可能原因
    *   单次消费的数据量少,可以调大 `max_routine_load_batch_size` 和 `routine_load_task_consume_second`
    *   kafka 的分区数量太少,并发太低
*   Broker Load 可能原因
    *   导入大量小文件,吞吐上不去
    *   文件存储性能差
*   INSERT INTO 可能原因
    *   Query 复杂,执行耗时

### 7. 写入慢排查

常见问题可以分为如下几类,前三种出现频率最高,可以参考 [Reached timeout 典型场景整理](https://forum.starrocks.com/t/topic/1167)

1.  集群资源用满,可能是用户负载突然增加,比如业务高峰期、定时跑批等,需要增加集群资源或降低负载
2.  集群资源充足但是导入相关的线程池不够,需要调整线程池大小
3.  主键表导入阶段重建 pk index、preload等耗时久,可以通过设置 BE `skip_pk_preload` 为 true 来规避
4.  其它问题,比如 bug,需要具体分析

一般按照如下步骤排查问题

1.  查看【集群资源监控】,如果资源使用高,先解决资源使用问题
2.  查看导入监控,依次分析【BRPC】、【Async Delta Writer】、【Memtable Flush】、【Segment Replicate Sync】、【Segment Flush】各环节的监控分析瓶颈。如果某个环节存在瓶颈,对应的线程池会有任务堆积,通用解决办法是增加线程池大小,如果无效可以进一步分析每个步骤的细粒度耗时,寻找异常点进行优化。各环节功能介绍参考【数据写入】
3.  如果无法从监控判断原因,比如缺少指标,或者指标无法反映个例问题,可以尝试通过 【存储层 Profile】和【Stack Trace】进一步分析
    a.  自3.4.3 版本,profile 包含了存储层更细粒度的指标; Reached timeout 可以自动触发profile输出到日志用来事后分析
    b.  自 3.5版本, Reached timeout 可以自动触发 profile 上报 FE 以及获取 stack trace 辅助分析

下面介绍的监控指标已经包含在了官网 Grafana 模板中
https://docs.starrocks.io/zh/docs/administration/management/monitoring/Monitor_and_Alert/#125-%E9%85%8D%E7%BD%AE-dashboard

#### 集群资源监控

*   各BE CPU 使用情况
*   IO 监控
    *   对于存算一体,查看本地磁盘IO util;对于存算分离,需要同时关注本地磁盘以及S3的IO
    *   本地磁盘IO util
    *   S3可以查看 fslib write io相关的指标,参考 https://docs.starrocks.io/docs/administration/management/monitoring/metrics-shared-data/#fslib-write-io-metrics
*   网络监控
    *   StarRocks 提供了网络流量的监控,可以判断是否达到了网络带宽限制
    *   建议用户增加对物理机 TCP 的监控,比如连接队列溢出、丢包、重传,如果没有可以安装 prometheus node_exporter(https://github.com/prometheus/node_exporter)

#### 导入监控

##### BRPC

*   线程池监控
*   和导入相关的BRPC接口,每个都有 latency 以及当前正在处理的rpc 请求数,各接口功能介绍参考【Sink流程】
    *   `tablet_writer_open`
    *   `tablet_writer_add_chunks`
    *   `tablet_writer_add_segment`

##### Async delta writer

*   线程池监控

##### Memtable Flush

*   线程池
*   Memtable flush 耗时

##### Segment replicate sync

*   只对存算一体 replicated storage 有效
*   线程池
*   耗时指标

##### Segment Flush

*   只对存算一体 replicated storage 有效
*   线程池
*   Segment flush 耗时

### 8. Publish慢排查

可能原因

1.  BE publish 线程池不够,通过 metrics 查看是否有任务堆积,如果有堆积可以通过 BE配置 `transaction_publish_version_worker_count` 动态增加线程池大小。默认为CPU核数
    *   存算一体监控指标 `starrocks_be_publish_version_queue_count`
    *   存算分离监控指标 `lake_publish_tablet_version_queuing_count`
2.  主键表开启同步 publish 后执行慢,由FE配置 `enable_sync_publish` 控制,可以通过 BE 日志分析 apply 耗时,关键字 `apply_rowset_commit finish`
3.  clone 任务执行可能影响 publish,一般比较复杂,需要结合 FE/BE 日志分析

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

## 存储层 Profile

### 使用方式

#### 方式一：手动开启Profile

*   **适用版本：** >= 3.3
*   **操作方式：** 和 Query Profile 相同，通过设置变量手动开启。
*   **查看方式：** 和 Query Profile 一样，通过 FE 获取。

#### 方式二：自动触发Profile并输出到BE日志

*   **适用版本：** >= 3.4
*   **触发条件：** `Reached timeout` 错误发生时，会自动触发BE存储层Profile。
*   **查看方式：** Profile会输出到BE的日志中。例如，如果报错信息为 `[E1008] Reached timeout=300000ms @172.26.95.221:8060`，可以到 BE节点 `172.26.95.221` 的日志中搜索关键字 `profile=`，会找到类似如下的日志：
    ```log
    W20250110 18:17:57.977756 139905026795072 load_channel.cpp:256] tablet writer add chunk timeout. txn_id=1691, cost=16728ms, timeout=16500ms, profile=xxx
    ```

#### 方式三：自动触发Profile并上报到FE

*   **适用版本：** >= 3.5
*   **触发条件：** `Reached timeout` 错误发生时，会自动触发BE存储层Profile。
*   **查看方式：** Profile会从BE上报给FE，可以像查询Query Profile一样，通过FE获取。

### Profile结构

存储层 profile 是整个 query profile 的一部分,对应 `LoadChannel`,详细设计可以参考 [导入BE Load Channel Profile](https://docs.starrocks.io/zh/docs/3.1/reference/be_load_channel_profile)

Profile 结构分为三层,最终的 profile 会将每层进行合并

*   LoadChannel: 每个 Executor BE 一个,该 BE 上所有index的入口
*   Index: 对应表的 index概念,比如一个同步物化视图,该Index下所有Tablet的入口
*   Tablet Replica: Tablet 的一个副本,存算分离可以理解成只有1副本

## Stack Trace

自StarRocks 3.5 版本开始, `Reached timeout` 发生后可以触发异常 BE 打印 stack trace 并保存到日志中,方便后续问题排查。

该机制基本流程为

1.  Coordinator BE 给 Executor BE 发送的 brpc 报错后,检查是否报错信息是否是 `Reached timeout`
2.  如果 timeout 大于 BE 配置 `load_diagnose_rpc_timeout_stack_trace_threshold_ms`,则给 Executor BE 发送打印 stack trace 的rpc请求该配置默认值为600000
3.  Executor BE 收到请求后,检查跟需打stacktrace的间隔是否超过 BE 配置 `diagnose_stack_trace_interval_ms`,如果小于该间隔则忽略该请求,否则获取 stack trace 并输出到日志中,该配置默认为 1800000

### 如何查看 stack trace

1.  调整配置 `load_diagnose_rpc_timeout_stack_trace_threshold_ms` 和 `diagnose_stack_trace_interval_ms` 确保 timeout 发生时会打印 stack trace
2.  根据报错信息找到异常 BE,比如 `[E1008]Reached timeout=300000ms @172.26.95.221:8060`,异常 BE 为 172.26.95.221
3.  使用关键词 `diagnose stack trace, id:` 在BE日志中搜索,找到需要的时间点附近的日志,提取 id 值,这里是 1
    ```
    I20250225 23:34:36.215724 139700663744064 diagnose_daemon.cpp:103] diagnose stack trace, id: 1, cost: 4792 ms, size: 53973, context: [load_id: 00a73bb3-f38e-11ef-b34b-1a2eb442ad8d, txn_id: 1002, remote: 127.0.0.1]
    ```
4.  接着用关键词 `DIAGNOSE $id` (把 `$id` 替换成实际的 id 号)进行搜索,这样就能获取这次 stack trace的所有日志行
    ```bash
    grep "DIAGNOSE 1 -" be.INFO > stack_trace.log
    ```

## 附录

### Reached timeout 值班问题汇总

如下是2024.09 - 2025.05 出现的问题总结
