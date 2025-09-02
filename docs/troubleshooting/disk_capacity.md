# 故障处理：磁盘空间不足

磁盘空间不足是 StarRocks 集群中最常见的故障之一。当 BE 节点的磁盘使用率过高时，可能会导致数据导入失败、Compaction 阻塞，甚至节点宕机。

## 现象

*   监控系统中收到磁盘使用率超过阈值（如 85%）的告警。
*   `SHOW BACKENDS;` 命令中，对应 BE 节点的 `DataUsedPct` 过高。
*   数据导入任务失败，错误信息中包含 `disk reach capacity limit` 或 `no available disk`。
*   BE 节点日志 (`be.WARNING.log`) 中出现大量 `disk is full` 或 `no space left on device` 的错误。

## 排查步骤

### 1. 确认磁盘使用情况

首先，登录到有问题的 BE 节点服务器，确认是哪个磁盘路径空间不足。

*   **查看 BE 配置:**
    在 `be/conf/be.conf` 文件中，找到 `storage_root_path` 配置项，它定义了 BE 使用的所有数据存储目录。
    ```properties
    # be.conf
    storage_root_path = /data1/starrocks/be;/data2/starrocks/be
    ```

*   **使用 `df` 命令检查:**
    使用 `df -h` 命令查看每个挂载点（`storage_root_path` 对应的路径）的磁盘使用率。
    ```bash
    df -h
    ```

### 2. 分析空间占用原因

#### a. 数据文件占用

这是最主要的原因。数据文件持续写入，但旧数据没有被及时清理。

*   **检查表的 TTL:** 确认业务表的动态分区属性是否配置正确，特别是 `dynamic_partition.start` 属性，它决定了保留多少天/月的分区。如果 TTL 设置过长或未设置，会导致历史数据堆积。
*   **检查 Compaction 状态:** Compaction 积压会导致已删除的数据无法被物理回收。通过监控 `starrocks_be_compaction_score` 指标或 `SHOW PROC '/compactions';` 命令来判断。

#### b. 回收站 (Trash) 文件占用

BE 节点在删除数据后，会先将文件移动到 `trash` 目录中，并保留一段时间（默认为 3 天）。

*   **检查 `trash` 目录大小:**
    ```bash
    du -sh /data1/starrocks/be/trash
    ```
*   如果 `trash` 目录过大，可以考虑缩短回收站保留时间。在 `be.conf` 中调整 `trash_file_expire_time_sec` 参数，并重启 BE。

#### c. 日志文件占用

*   检查 `be/log` 目录的大小。如果日志文件过大，应检查日志级别是否过低（如 DEBUG），并配置日志轮转策略。

## 解决方案

### 1. 紧急处理：清理空间

*   **清理回收站:** 如果确认 `trash` 目录中的数据不再需要，可以手动删除 `trash` 目录下的文件来快速释放空间。**此操作有风险，请谨慎执行。**
*   **手动删除分区:** 对于不再需要的旧分区，可以通过 `ALTER TABLE ... DROP PARTITION ...;` 命令手动删除。

### 2. 长期方案：扩容与优化

*   **扩容磁盘:** 为 BE 节点增加新的数据盘，并在 `storage_root_path` 中添加新路径。
*   **扩容节点:** 向集群中添加新的 BE 节点，StarRocks 会自动进行数据均衡，将部分数据迁移到新节点上。
*   **优化 TTL:** 与业务方沟通，为所有表设置合理的 TTL（通过动态分区），实现数据的自动生命周期管理。
*   **优化 Compaction:** 如果存在 Compaction 积压，参考 Compaction 原理 章节进行调优。