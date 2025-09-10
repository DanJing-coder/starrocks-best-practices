# 实时分析场景最佳实践

实时分析旨在对持续产生的最新数据进行即时查询和分析，以获得快速的业务洞察。典型场景包括实时监控大盘、用户行为分析、实时风控、物联网 (IoT) 数据分析等。这些场景的核心要求是：数据从产生到可供查询的延迟（End-to-End Latency）要足够低（通常在秒级），同时查询性能也要满足低延迟的要求。

本章将介绍如何围绕 StarRocks 构建一个高效的实时分析系统，涵盖数据建模、数据导入和查询优化等关键环节。

## 1. 核心思想：读写平衡，各司其职

实时分析场景下，系统需要同时处理高频的数据写入和实时的查询请求。其核心挑战在于如何平衡这两者的资源消耗，避免相互干扰。

*   **写入端:** 追求稳定、高效的数据摄入，确保数据以低延迟、不丢不重的方式进入系统。
*   **查询端:** 追求极致的查询性能，即使在数据持续写入的背景下，也能获得毫秒到秒级的响应。

## 2. 数据建模：为实时而设计

一个为实时场景优化的数据模型，可以在数据写入和查询时都获得最佳性能。

### 2.1 选择合适的表模型

*   **主键模型 (Primary Key Model):**
    *   **适用场景:** 需要对数据进行实时更新的场景，如订单状态更新、用户画像实时变更、实时物料库存等。其 `UPSERT` 语义能够优雅地处理数据更新，避免数据冗余。
    *   **实践:** 将业务主键（如 `order_id`, `user_id`）定义为表的主键。对于高频更新的场景，建议开启持久化主键索引（v3.1+）以降低内存消耗。
    *   **示例:**
        ```sql
        CREATE TABLE orders (
            order_id BIGINT,
            order_status INT,
            update_time DATETIME,
            ...
        )
        PRIMARY KEY (order_id)
        DISTRIBUTED BY HASH(order_id);
        ```

*   **明细模型 (Duplicate Key Model):**
    *   **适用场景:** 存储无需更新的原始日志数据，如用户行为日志、应用 Log、监控指标数据等。写入性能最高，因为无需检查主键唯一性。
    *   **实践:** 将时间戳和高频过滤维度作为排序键的前缀，加速查询。
    *   **示例:**
        ```sql
        CREATE TABLE user_behavior_log (
            event_time DATETIME,
            user_id BIGINT,
            event_type VARCHAR(50),
            ...
        )
        DUPLICATE KEY (event_time, user_id)
        PARTITION BY RANGE(event_time) (...)
        DISTRIBUTED BY HASH(user_id);
        ```

### 2.2 分区与分桶

*   **分区 (Partition):**
    *   **必须**使用时间列进行分区，通常按天 (`PARTITION BY DATE_TRUNC('day', event_time)`) 或按小时分区。
    *   使用动态分区自动管理分区生命周期，定期删除过期数据。
*   **分桶 (Bucket):**
    *   使用高基数的列（如 `user_id`, `device_id`）作为分桶键，确保数据在 BE 节点间均匀分布，避免写入和查询热点。

## 3. 实时数据导入：选择合适的工具

StarRocks 提供多种实时数据导入方式，可以满足不同数据源和延迟的需求。

### 3.1 Routine Load (推荐)

*   **适用场景:** 从 Apache Kafka 或 Apache Pulsar 等消息队列中持续、自动地消费数据。这是构建实时数仓最常用、最稳定的方式。
*   **优势:**
    *   **Exactly-Once 语义:** StarRocks 内部管理消费位点，确保数据不重不丢。
    *   **自动化:** 创建任务后，StarRocks 会自动持续消费，无需外部干预。
    *   **高吞吐、低延迟:** 可以稳定地实现秒级的端到端延迟。
*   **实践:**
    ```sql
    -- 从 Kafka topic 'user_events' 持续导入数据
    CREATE ROUTINE LOAD my_db.load_user_events ON user_behavior_log
    COLUMNS TERMINATED BY ',',
    PROPERTIES (
        "desired_concurrent_number" = "3" -- 并发度
    )
    FROM KAFKA (
        "kafka_broker_list" = "broker1:9092,broker2:9092",
        "kafka_topic" = "user_events",
        "kafka_partitions" = "0,1,2",
        "property.kafka_default_offsets" = "OFFSET_END" -- 从最新的位置开始消费
    );
    ```

### 3.2 Stream Load

*   **适用场景:** 通过 HTTP 协议将本地文件或数据流导入 StarRocks。适合小批量、高频次的写入，或作为其他系统（如 Flink, Spark）写入 StarRocks 的底层接口。
*   **优势:**
    *   **简单易用:** 一个 `curl` 命令即可完成导入。
    *   **同步返回:** 导入结果同步返回，便于应用判断成功与否。
*   **实践:** 客户端应用（如 Java, Python）可以通过拼接批次数据，然后调用 Stream Load 的 HTTP 接口进行写入。建议使用连接池和批处理来提升性能。
    ```bash
    curl --location-trusted -u user:password -H "label:my_label" \
        -H "column_separator:," -T data.csv \
        http://fe_host:8030/api/my_db/my_table/_stream_load
    ```

### 3.3 Flink Connector

*   **适用场景:** 已经在使用 Apache Flink 进行实时数据处理，希望将处理结果高效写入 StarRocks。
*   **优势:**
    *   **深度集成:** 与 Flink 的 Checkpoint 机制深度集成，提供端到端的 Exactly-Once 保证。
    *   **高吞吐:** 利用 Stream Load 的底层能力，并做了大量优化，写入性能极高。
    *   **支持 Changelog:** 可以将 Flink 的 CDC 数据流（INSERT, UPDATE, DELETE）同步到 StarRocks 的主键模型表中。

## 4. 查询加速：物化视图与读写分离

即使数据持续写入，查询也必须保持低延迟。

*   **异步物化视图:** 这是实时分析场景下最重要的查询加速手段。
    *   **原理:** 在实时写入的明细表（基表）之上，创建一个或多个异步刷新的物化视图，用于预计算聚合结果。
    *   **优势:**
        1.  **读写分离:** 查询直接访问物化视图，避免了在庞大的明细表上进行实时聚合，从而将高频写入与查询负载隔离开。
        2.  **查询加速:** 将复杂的聚合计算提前完成，查询时只需读取预计算好的结果，延迟可降至亚秒级。
    *   **实践:** 为实时大盘、报表中的核心指标（如 PV, UV, GMV）创建物化视图。
        ```sql
        -- 基表：实时写入的用户行为日志
        CREATE TABLE user_behavior_log (...);

        -- 物化视图：每分钟刷新一次，统计每分钟的 PV 和 UV
        CREATE MATERIALIZED VIEW minute_pv_uv_mv
        REFRESH ASYNC EVERY(INTERVAL 1 MINUTE)
        AS
        SELECT
            DATE_TRUNC('minute', event_time) as minute_window,
            COUNT(*) as pv,
            COUNT(DISTINCT user_id) as uv
        FROM user_behavior_log
        WHERE event_time >= date_sub(now(), INTERVAL 1 DAY) -- 只计算最近一天的数据
        GROUP BY minute_window;

        -- 大盘查询直接查物化视图，或让 StarRocks 自动改写
        SELECT * FROM minute_pv_uv_mv ORDER BY minute_window DESC;
        ```

*   **资源隔离:** 使用资源组将 Routine Load/Stream Load 等导入任务与前台查询进行资源隔离，确保它们不会争抢 CPU 和内存，保证查询的稳定性。