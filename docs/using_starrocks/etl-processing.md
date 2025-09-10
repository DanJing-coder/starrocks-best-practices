# ETL/ELT 场景最佳实践

StarRocks 不仅是一个高性能的查询引擎，其强大的计算能力和灵活的数据模型也使其成为一个理想的 ETL (Extract, Transform, Load) 或 ELT (Extract, Load, Transform) 平台。通过将 ETL/ELT 任务从外部计算引擎（如 Spark, Flink）迁移到 StarRocks 内部，可以极大地简化数据架构，降低运维成本，并提升数据处理的时效性。

本章将介绍如何在 StarRocks 中构建高效、稳定的数据转换和处理链路。

## 1. 核心思想：化繁为简，库内处理 (In-database Processing)

传统的数据仓库架构通常涉及多个系统：数据从业务库同步到 ODS (Operational Data Store)，然后通过 Spark/Flink 等计算引擎进行清洗、关联、聚合，生成 DWD (Data Warehouse Detail) 和 DWS (Data Warehouse Summary) 层，最后加载到分析型数据库中供查询。

StarRocks 提倡的 ELT 模式，旨在将“T”(Transform) 的过程内置：
1.  **Extract & Load:** 将原始数据（如日志、业务库 CDC 数据）以最快的速度直接加载到 StarRocks 的贴源层（ODS 表）。
2.  **Transform:** 利用 StarRocks 强大的 SQL 引擎和物化视图，在数据库内部完成数据清洗、维度关联、指标聚合等一系列转换操作。

这种模式的优势在于：
*   **架构简化:** 减少了外部计算组件和数据流转环节。
*   **时效性提升:** 数据加载后即可进行转换，缩短了数据可见的延迟。
*   **运维成本降低:** 无需维护额外的计算集群。

## 2. 使用物化视图构建增量 ETL

异步物化视图是 StarRocks 实现 ELT 的核心利器。它可以将一个复杂的 SQL 转换逻辑定义成一个视图，并由系统自动、增量地进行计算，将转换结果物化存储。

### 2.1 建模分层

*   **ODS 层 (明细模型):** 创建一个明细模型（Duplicate Key）的表作为 ODS 层。此模型写入开销最低，适合快速接收来自上游的原始数据，无需任何预处理。
*   **DWD/DWS 层 (物化视图):** 在 ODS 表之上，创建异步物化视图来生成 DWD 或 DWS 层。

### 2.2 实践示例

假设我们需要从原始的订单表 (`orders_raw`) 和用户表 (`users_raw`) 中，清洗并关联数据，生成一个按城市统计每日订单总额的 DWS 报表。

1.  **创建 ODS 表:**
    ```sql
    -- 原始订单表 (事实表)
    CREATE TABLE orders_raw (
        order_id BIGINT,
        order_amount DECIMAL(10, 2),
        user_id BIGINT,
        order_time DATETIME
    ) DUPLICATE KEY(order_id)
    PARTITION BY date_trunc('day', order_time) -- 按天分区
    DISTRIBUTED BY HASH(order_id);

    -- 原始用户表 (维度数据)
    CREATE TABLE users_raw (
        user_id BIGINT,
        city VARCHAR(100),
        update_time DATETIME
    ) PRIMARY KEY(user_id)
    DISTRIBUTED BY HASH(user_id);
    ```

2.  **创建分区物化视图作为 DWS 层:**
    为了实现最高效的增量 ETL，推荐创建与基表分区对齐的**分区物化视图**。
    ```sql
    CREATE MATERIALIZED VIEW daily_city_gmv_dws
    PARTITION BY (order_date) -- 关键：对物化视图进行分区，分区键与基表分区逻辑对齐
    DISTRIBUTED BY HASH(city)
    REFRESH ASYNC EVERY(INTERVAL 1 DAY) -- 每天刷新一次
    AS
    SELECT
        DATE(t2.order_time) AS order_date, -- 分区键必须在 SELECT 列表中
        t1.city,
        SUM(t2.order_amount) AS gmv
    FROM users_raw AS t1
    JOIN orders_raw AS t2 ON t1.user_id = t2.user_id
    GROUP BY order_date, t1.city;
    ```
    创建后，StarRocks 会自动维护 `daily_city_gmv_dws` 的数据。其核心优势在于**分区级别的增量刷新**：当 `orders_raw` 表的某个分区（例如，今天的分区）有新数据写入时，StarRocks 只会智能地重新计算并刷新物化视图中对应的分区，而无需扫描和重算整个物化视图。这极大地降低了刷新开销，提升了数据时效性，是构建高效 ELT 链路的关键。

## 3. 大规模 ETL 的资源管控

ETL 任务通常是资源密集型的，涉及全表扫描、大规模 Join 和复杂聚合。为了避免这些重度任务影响到其他高并发的在线查询，必须进行有效的资源隔离和管控。

### 3.1 使用资源组进行隔离

这是最推荐的方式。为 ETL 任务创建一个专属的资源组，并为其设置合理的资源配额、并发限制和默认行为。

*   **实践:**
    1.  创建一个名为 `etl_group` 的资源组，分配固定的 CPU、内存资源，并设置并发数限制。
    2.  在执行 ETL 任务时（无论是通过外部调度系统还是手动执行），将当前会话或用户与该资源组绑定。

    ```sql
    -- 创建资源组
    CREATE RESOURCE GROUP etl_group
    WITH (
        'cpu_core_limit' = '10',
        'mem_limit' = '30%',
        'concurrency_limit' = '5', -- 限制该组内同时运行的查询不超过 5 个
        'spill_mem_limit_threshold' = '0.9' -- 当单个查询内存使用超过该组总内存的90%时，自动触发溢写
    );

    -- 为用户指定资源组
    ALTER USER etl_user SET PROPERTIES ("session.resource_group" = "etl_group");

    -- 或为当前会话临时指定资源组
    SET resource_group = 'etl_group';
    -- 执行你的大型 SQL ETL 任务
    INSERT INTO ... SELECT ...;
    ```
*   **说明:**
    *   `concurrency_limit`: 控制该资源组内可以同时执行的查询数量，有效防止 ETL 任务冲垮集群。
    *   `spill_mem_limit_threshold`: 为资源组设置默认的溢写策略。当查询内存使用超过阈值时自动开启 Spill-to-Disk，增强大查询的稳定性。

### 3.2 开启查询队列 (Query Queues)

当 ETL 任务并发较高，超过了资源组设置的 `concurrency_limit` 时，默认情况下新来的查询会被拒绝。为了避免任务失败，可以为资源组开启查询队列。

*   **原理:** 开启查询队列后，超出并发限制的查询会进入队列中等待，而不是立即被拒绝。当前面的查询执行完毕后，队列中的查询会按先进先出的顺序被调度执行。
*   **实践:** 
    1.  **开启全局开关:**
        要使用查询队列，特别是对于 ETL 场景中的导入任务，必须先开启相应的全局开关。
        ```sql
        -- 开启资源组级别的查询队列功能
        SET GLOBAL enable_group_level_query_queue = true;
        
        -- 允许导入任务（如 INSERT INTO ... SELECT ...）进入队列
        SET GLOBAL enable_query_queue_load = true;
        ```
    2.  **为资源组配置队列大小:**

        ```sql
        -- 所有队列中等待的查询总数的上限，默认为 1024。
        SET query_queue_max_queued_queries = 100;
        -- 查询在队列中等待的超时时间（秒），默认为 300。超时后查询将失败。
        SET query_queue_pending_timeout_second = 300;
        ```

        这样，该资源组最多可以同时处理 5 个导入，另外还有 100 个导入可以在队列中排队，总共可以承接 105 个并发请求。

### 3.3 会话级开启 Spill-to-Disk (溢写)

除了通过资源组统一配置溢写策略外，对于临时的、未绑定特定资源组的大型 ETL 查询，也可以在会话级别手动开启 Spill 功能，以防止因内存不足 (OOM) 而导致任务失败。

*   **原理:** 当算子的内存使用达到阈值时，它会将部分数据临时写入磁盘，从而释放内存给其他数据处理。这是一种以时间换空间（牺牲性能换取稳定性）的策略。
*   **实践:** Spill 功能默认关闭。对于大型 ETL 任务，可以在会话级别开启。

    ```sql
    -- 在当前会话中开启 Spill 功能
    SET enable_spill = true;

    -- 执行可能导致 OOM 的超大查询
    SELECT ... FROM large_table1 JOIN large_table2 ON ...;
    ```
    **注意:** 开启 Spill 会降低查询性能，因此它主要适用于对延迟不敏感的后台批处理任务，而不应用于在线查询。

### 3.4 调整查询并行度

对于单个大型 ETL 查询，如果希望限制其对整个集群的 CPU 冲击，可以临时调低其查询执行的并行度。

*   **实践:** 通过 `pipeline_dop` session 变量来控制。

    ```sql
    -- 将当前会话的查询并行度设置为 8
    SET pipeline_dop = 8;

    -- 执行大型 ETL
    INSERT INTO ...;
    ```

通过以上组合拳，可以确保大型 ETL 任务在 StarRocks 中稳定、高效地运行，同时不干扰其他业务的正常查询。