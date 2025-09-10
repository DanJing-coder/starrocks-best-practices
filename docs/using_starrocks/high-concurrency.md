# 高并发场景最佳实践

在高并发场景下（例如，面向大量用户的在线报表、实时看板、高 QPS 的 API 查询服务），对 StarRocks 的查询响应时间 (Latency) 和吞吐量 (QPS) 有着极高的要求。本章将系统性地介绍如何通过数据建模、物化视图、架构设计和查询优化等一系列手段，来应对高并发场景的挑战。

## 1. 核心思想：减少计算，减少 I/O

应对高并发的核心思想是在查询执行的每个环节都尽可能地减少计算量和 I/O 开销，或者直接跳过计算。

*   **减少 I/O:** 通过分区裁剪、分桶裁剪、前缀索引等方式，在物理层面读取最少的数据。
*   **减少计算:** 通过预聚合（物化视图）、避免运行时函数、高效算子等方式，在计算层面执行最少的操作。

## 2. 数据建模：奠定高性能基石

一个优秀的数据模型是实现高并发查询的根本。

### 2.1 分区、分桶与排序键的协同作用

*   **分区键 (Partition Key):**
    *   **目的:** 加速时间范围过滤，管理数据生命周期。
    *   **实践:** 必须使用时间列作为分区键。在查询时，务必在 `WHERE` 条件中带上分区键的范围过滤，实现分区裁剪。这是最高效的数据过滤方式。
    *   **示例:**
        ```sql
        -- 查询最近一天的数据，StarRocks 只会扫描对应的分区
        SELECT ... FROM user_behavior WHERE event_time >= date_sub(now(), INTERVAL 1 DAY);
        ```

*   **排序键 (Sort Key):**
    *   **目的:** 加速基于排序列前缀的过滤和范围查询。
    *   **实践:** 将最高频的等值或范围查询过滤字段放在排序键的最前面。对于高并发的点查场景（如 `WHERE user_id = ?`），将 `user_id` 作为排序键的第一列，性能会得到极大提升。
    *   **示例:**
        ```sql
        -- user_id 是排序键的第一列，可以快速定位
        CREATE TABLE user_profile (
            user_id BIGINT,
            tag_id INT,
            ...
        )
        ORDER BY (user_id, tag_id)
        ...;
        ```

*   **分桶键 (Bucket Key):**
    *   **目的:** 均匀分布数据，避免倾斜。在高并发场景下，它还有**分桶裁剪**的作用。
    *   **实践:** 当 `WHERE` 条件中包含对分桶键的等值过滤时，StarRocks 可以只扫描该 Key 所在的一个分桶（Tablet），极大地减少了扫描范围。因此，对于高并发点查场景，**使用查询的 ID 列作为分桶键**是绝佳实践。
    *   **示例:**
        ```sql
        -- user_id 同时是排序键和分桶键，查询效率最高
        CREATE TABLE orders (
            order_id BIGINT,
            user_id BIGINT,
            ...
        )
        PRIMARY KEY (order_id)
        DISTRIBUTED BY HASH(order_id) BUCKETS 32; -- 使用 order_id 分桶

        -- 此查询会同时利用主键索引和分桶裁剪
        SELECT * FROM orders WHERE order_id = 12345;
        ```

### 2.2 主键模型：为点查而生

主键模型天然适合高并发的**点查**和**批量更新**场景。

*   **优势:** 其底层实现为主键索引，对于 `WHERE primary_key = ...` 这样的查询，可以实现毫秒级的快速响应。
*   **持久化主键索引 (v3.1+):** 对于超大规模表，开启持久化主键索引 (`"enable_persistent_index" = "true"`) 可以将索引从内存转移到磁盘（推荐 SSD），在降低巨大内存开销的同时，依然保持极高的点查性能。
*   **行列混存 (Hybrid Table):** 为了将点查性能推向极致，可以为主键模型表开启行列混存。
    *   **原理:** 在标准的列式存储之外，额外增加一份行式存储。对于 `SELECT * FROM ... WHERE pk = ?` 这样的点查，系统可以直接从行存中通过一次 I/O 读取整行数据，避免了多次列式 I/O，延迟更低。更多信息请参考行列混存表。
    *   **代价:** 会占用更多的存储空间
    *   **适用场景:** 对点查延迟有极端要求（如亚毫秒级），且可以接受更高存储成本的场景。
    *   **开启方式:** FE开启 `ADMIN SET FRONTEND CONFIG ("enable_experimental_rowstore" = "true");`，在建表时通过 `PROPERTIES` 指定 `"storage_type" = "column_with_row"`。
        ```sql
        CREATE TABLE orders_hybrid (
            order_id BIGINT,
            user_id BIGINT,
            ...
        )
        PRIMARY KEY (order_id)
        DISTRIBUTED BY HASH(order_id)
        PROPERTIES (
            "storage_type" = "column_with_row"
        );
        ```
    *   **开启短路读 (Short-circuit Read):** 为了进一步加速行列混存表的点查，推荐开启短路读。
        *   **原理:** 启用后，对于符合条件的点查，查询会绕过常规的执行引擎，直接通过短路路径扫描行存数据，提供最低的查询延迟。
        *   **开启与验证:**
            ```sql
            -- 检查是否开启
            SHOW VARIABLES LIKE '%enable_short_circuit%';
            -- 为会话开启
            SET enable_short_circuit = true;
            ```
        *   **生效条件:** 查询的 `WHERE` 子句必须包含所有主键列，且操作符为 `=` 或 `IN`。
        *   **验证方式:** 查看查询的 `EXPLAIN` 计划，如果其中包含 `Short Circuit Scan: true`，则说明短路读已生效。

## 3. 物化视图：预计算的艺术

对于固定的聚合查询模式（如 BI 报表、看板），物化视图是终极加速手段。

*   **原理:** 将复杂的聚合、多表 Join 的结果预先计算并存储起来。查询时，StarRocks 会自动改写查询，直接从物化视图中读取结果，将耗时数秒甚至数分钟的复杂查询降至亚秒级。
*   **实践:**
    1.  识别出业务中最高频、最耗时的聚合查询。
    2.  为这些查询模式创建异步物化视图。
    3.  分区和分桶策略尽量与基表对齐，以提升刷新效率。
*   **示例：** 假设有一个高频查询是统计每日各城市的产品销量。
    ```sql
    -- 原始查询 (可能很慢)
    SELECT sale_date, city, product_id, SUM(sale_amount)
    FROM sales_records
    GROUP BY sale_date, city, product_id;

    -- 创建物化视图
    CREATE MATERIALIZED VIEW daily_city_product_sales_mv
    REFRESH ASYNC EVERY(INTERVAL 1 HOUR)
    AS
    SELECT sale_date, city, product_id, SUM(sale_amount) as total_sales
    FROM sales_records
    GROUP BY sale_date, city, product_id;
    ```
    创建后，所有符合该模式的查询都会被自动加速，无需修改任何应用代码。

## 4. Query Cache：缓存查询中间结果

对于高并发的聚合查询场景，Query Cache 是一项强大的加速功能。它通过在内存中缓存聚合的中间结果，让后续相同或类似的查询能够复用这些结果，从而避免重复的数据扫描和计算。

*   **原理：缓存中间聚合结果**
    Query Cache 依赖于 Pipeline 执行引擎的 **Per-Tablet 计算** 模式。
    *   **Per-Tablet 计算:** 当单个 BE 节点上待访问的 Tablet 数量大于或等于查询的实际并发度时，一个 Pipeline Driver 能够以 Tablet 为单位进行计算。此时 Query Cache 才会启用。
    *   **缓存中间结果:** 在聚合查询的第一阶段，如果 `OlapScanNode` 和 `AggregateNode` 在同一个执行片段 (Fragment) 中，`AggregateNode` 产生的 Per-Tablet 计算结果就会被缓存到内存中。
    *   **结果复用:** 当后续相同或类似的聚合查询到达时，StarRocks 可以直接复用这些缓存的中间结果，从而跳过对这部分数据的磁盘读取和重复计算，显著降低查询延迟和资源消耗。

*   **适用场景与优势**
    *   **高并发聚合查询:** 在大量用户对复杂数据集执行相同或类似聚合查询的场景下（如 BI 看板），优势尤为明显。
    *   **数据相对静态:** 与其他缓存一样，它在数据不频繁更新的场景下效果最好。数据写入后，相关缓存会自动失效。
    *   **减少 I/O 和计算:** 通过复用中间结果，直接避免了从磁盘读取数据的开销，降低了 CPU 消耗。

*   **限制与不适用场景**
    *   **Shuffle 操作:** 如果在聚合之前对数据进行了 Shuffle 操作（例如，`GROUP BY` 的列不是分桶键），则 Query Cache 无法生效。
    *   **部分 DISTINCT 查询:** 当 `cbo_cte_reuse` 开启时，包含 `avg(distinct)` 或多个 `DISTINCT` 聚合函数的查询，其执行计划可能会将 `OlapScanNode` 和 `AggregateNode` 分离到不同 Fragment 中，导致 Query Cache 不被启用。
    *   **高基数列聚合:** 对高基数列进行分组或去重，可能会产生非常大的中间结果。这类查询在运行时会动态绕过 Query Cache。
    *   **结果大小限制:** 单个 Tablet 的计算结果如果超过 `query_cache_entry_max_bytes` 或 `query_cache_entry_max_rows` 阈值，该查询后续的计算将不再使用 Query Cache，转而使用 Passthrough 机制。
    *   **低命中率惩罚:** 在缓存命中率低的场景下，启用 Query Cache 反而会带来额外的性能开销。

*   **如何使用与配置**
    #### 开启方式
    Query Cache 默认关闭，可以通过多种方式开启：
    ```sql
    -- 1. 全局开启 (对所有后续会话生效)
    SET GLOBAL enable_query_cache = true;
    -- 2. 会话级别开启 (仅对当前会话生效)
    SET enable_query_cache = true;
    -- 3. SQL 级别开启 (仅对单条 SQL 生效，优先级最高)
    SELECT /*+ SET_VAR(enable_query_cache=true) */ city, SUM(order_amount) 
    FROM orders 
    WHERE create_time >= '2023-11-01' 
    GROUP BY city;
    ```
    #### 关键配置参数
    可以在 BE 的 `be.conf` 文件中配置 Query Cache 的行为，或通过 `ADMIN SET CONFIG` 动态修改。
    *   `query_cache_capacity`: BE 节点上用于 Query Cache 的总内存大小，默认 512 MB。
    *   `query_cache_entry_max_bytes`: 单个 Tablet 计算结果可被缓存的最大大小。
    *   `query_cache_entry_max_rows`: 单个 Tablet 计算结果可被缓存的最大行数。
    #### 监控与验证
    可以通过多种方式观测 Query Cache 的工作状态和效果。

    *   **查询 Profile:** 在查询的 Profile 中，如果 `AggregateNode` 成功利用了 Query Cache，其下方会展示 `CacheOperator` 的统计信息，明确显示了缓存的命中情况。

    *   **Prometheus 指标:** StarRocks 通过 BE 的 metrics 接口暴露了丰富的 Query Cache 指标，可以在 Prometheus 中采集和监控。
        *   `starrocks_be_query_cache_usage`: 缓存已使用的容量（字节）。
        *   `starrocks_be_query_cache_capacity`: 缓存总容量（字节）。
        *   `starrocks_be_query_cache_usage_ratio`: 缓存使用率。
        *   `starrocks_be_query_cache_lookup_count`: 查询尝试使用缓存的总次数。
        *   `starrocks_be_query_cache_hit_count`: 缓存命中次数。
        *   `starrocks_be_query_cache_hit_ratio`: 缓存命中率。高命中率是 Query Cache 发挥作用的关键标志。

    *   **BE API 接口:** 可以直接访问 BE 的 HTTP 接口获取更详细的缓存统计信息。
        ```
        http://<be_host>:<be_http_port>/api/query_cache/stat
        ```

## 5. 架构层面：提升吞吐与可用性

### 5.1 FE 负载均衡

单个 FE 节点的连接数和查询规划能力是有限的。在高并发场景下，必须部署多个 FE 节点，并通过负载均衡器对外提供服务。

*   **实践:** 在 3 个或更多 FE 节点前架设一个四层负载均衡器（如 Nginx, HAProxy, F5），为 JDBC/MySQL 端口 (9030) 和 HTTP 端口 (8030) 提供统一的虚拟 IP (VIP)。
*   **优点:**
    *   **高可用:** 单个 FE 宕机不影响服务。
    *   **负载均衡:** 将客户端连接和查询规划的压力均匀分散到所有 FE 节点。
    *   **简化配置:** 客户端只需连接 VIP，无需关心后端 FE 拓扑。

*   **Nginx 配置示例 (TCP 负载均衡):**
    ```nginx
    stream {
        upstream starrocks_fe_mysql {
            least_conn; # 使用最少连接策略
            server <fe1_ip>:9030;
            server <fe2_ip>:9030;
            server <fe3_ip>:9030;
        }

        server {
            listen 9030; # 暴露给客户端的统一端口
            proxy_pass starrocks_fe_mysql;
        }
    }
    ```

### 5.2 BE 水平扩展

StarRocks 的计算能力与 BE 节点的总 CPU 核数成正比。当现有集群无法满足 QPS 需求时，最直接有效的方式就是**水平扩展 BE 节点**。增加 BE 节点可以线性地提升集群的整体查询处理能力。

### 5.3 资源隔离

高并发查询通常是资源消耗可预测的短查询。为了避免它们被临时的、重量级的 Ad-hoc 分析查询影响，可以使用资源组进行隔离。

*   **实践:** 创建不同的资源组，为高并发业务分配固定的 CPU 和内存资源，确保其查询的稳定性。

### 5.4 关键参数调优：设置 `pipeline_dop = 1`

在高并发场景下，核心目标是提升系统总体的吞吐量 (QPS)，而非压榨单个查询的极致性能。默认的 `pipeline_dop`（通常为 0，即自动设置）会为每个查询分配较多的 CPU 核心，这在并发量高时会导致严重的线程切换开销，反而降低整体吞吐。

*   **实践:** 通过 `SET GLOBAL` 将 `pipeline_dop` 设置为 `1`。这会强制每个查询在单个 BE 节点上只使用一个核心执行，极大减少了 CPU 调度开销，使得集群能够稳定处理更高的并发请求。
    ```sql
    -- 设置全局 pipeline_dop 为 1
    SET GLOBAL pipeline_dop = 1;
    ```
*   **原理:** 将并行执行的模型切换为串行执行，避免了大量短查询之间的 CPU 资源争抢。虽然单个查询的执行时间可能会有微秒或毫秒级的增加，但系统整体的 QPS 会有数倍的提升。这对于高并发点查或小范围聚合场景是至关重要的优化。

## 6. 查询端优化

*   **使用连接池:** 客户端应用**必须**使用连接池 (Druid, HikariCP) 来管理数据库连接，避免频繁创建和销毁连接带来的巨大开销。
*   **Prepared Statement (预处理语句):** 对于只有 `WHERE` 条件中的值不同的高频、固定模式 SQL，使用 `PreparedStatement` 是一个关键的性能优化手段。
    *   **原理:** 当客户端（如 JDBC）首次发送一个 `PreparedStatement` 请求时，StarRocks FE 会对这个 SQL 模板进行解析、规划和优化，并将其生成的**执行计划**缓存起来。后续所有使用该 `PreparedStatement` 的执行请求（`EXECUTE`），都会直接复用这个缓存的执行计划，只需替换占位符 `?` 的值即可。
    *   **优势:**
        *   **降低 FE CPU 消耗:** 它完全跳过了 SQL 解析、查询规划和优化的开销，在高 QPS 场景下能显著降低 FE 的 CPU 负载。
        *   **降低查询延迟:** 减少了查询生命周期中的多个步骤，使得端到端延迟更低。
        *   **防止 SQL 注入:** 提供了更高的安全性。
    *   **实践:** 客户端应用**必须**通过 JDBC 的 `PreparedStatement` 接口来使用此功能。为了真正开启 StarRocks FE 端的执行计划缓存，需要在客户端的 JDBC 连接串中添加 MySQL 驱动的 `useServerPrepStmts=true` 参数。它对于高并发的点查（如 `SELECT ... FROM ... WHERE pk = ?`）和固定模式的小范围聚合查询效果尤为显著。
        *   **JDBC 连接串示例:**
            ```
            jdbc:mysql://<fe_ip>:<fe_query_port>/<db_name>?useServerPrepStmts=true
            ```
*   **使用 Hint/Session 变量:** 对于个别特殊的查询，可以使用 Hint (`/*+ SET_VAR(...) */`) 来临时调整执行参数（如并行度 `pipeline_dop`），进行精细化调优，而不影响全局配置。