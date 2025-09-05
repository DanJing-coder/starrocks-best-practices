# 物化视图 (Materialized View)

物化视图 (MV) 是 StarRocks 中一项强大的查询加速技术。它通过预先计算并存储查询结果，使得在处理复杂、高频的查询时，可以直接从物化视图中读取预计算好的数据，从而绕过对基表的复杂计算，实现数量级的性能提升。

## 1. 物化视图的原理

物化视图的本质是一个**物理上存在的、存储了特定查询结果的表**。当用户提交一个查询时，StarRocks 的优化器会自动判断该查询是否能被某个物化视图满足。如果可以，优化器会**透明地重写 (Transparent Rewrite)** 查询，将其导向物化视图，而不是原始的基表。这个过程对用户完全透明，用户无需修改任何 SQL。

```mermaid
graph TD
    subgraph 用户查询
        A[SELECT city, SUM(sales) FROM orders GROUP BY city]
    end

    subgraph StarRocks 内部
        B{优化器: 查询能否被重写?} -- 是 --> C[重写查询为: SELECT * FROM mv_city_sales];
        B -- 否 --> D[扫描基表 orders];
        C --> E[扫描物化视图 mv_city_sales];
    end

    E --> F[返回结果]
    D --> F
```

## 2. 物化视图的类型

StarRocks 支持两种类型的物化视图，以适应不同的数据新鲜度和业务场景。

### 2.1 异步物化视图 (Asynchronous MV)

这是最常用、最灵活的物化视图类型。

*   **特点:**
    *   异步物化视图是一个独立的物理表，与基表解耦。
    *   它的数据刷新不是实时的，需要通过配置的刷新策略来定期更新。
*   **刷新策略:**
    *   `ASYNC` (异步刷新): 根据指定的调度策略（如 `START ... EVERY ...`）周期性地刷新。
    *   `MANUAL` (手动刷新): 需要用户手动执行 `REFRESH MATERIALIZED VIEW` 命令来刷新。
*   **适用场景:**
    *   **加速复杂 Join:** 将多个维度表与事实表预先 Join 成一张宽表。
    *   **预聚合大数据集:** 对海量明细数据进行复杂的预聚合，如计算 UV、留存率等。
    *   **数据湖加速:** 为外部数据源（如 Hive, Iceberg）创建物化视图，将热数据缓存到 StarRocks 中，实现对数据湖的查询加速。
    *   对数据新鲜度有一定容忍度（分钟级到小时级）的场景。

**示例：创建一个按天调度的异步物化视图**
```sql
CREATE MATERIALIZED VIEW mv_daily_sales
DISTRIBUTED BY HASH(sale_date)
REFRESH ASYNC START('2023-01-01 01:00:00') EVERY(1 DAY)
AS SELECT
    sale_date,
    region,
    SUM(sale_amount) as total_sales
FROM orders
GROUP BY sale_date, region;
```

### 2.2 同步物化视图 (Synchronous MV / Rollup)

同步物化视图在早期版本中被称为 `ROLLUP INDEX`。

*   **特点:**
    *   它不是一个独立的表，而是附属于基表的一种**预聚合索引**。
    *   其数据与基表数据**完全同步**。当基表数据发生写入、更新或删除时，同步物化视图的数据会原子性地、同步地更新。
*   **限制:**
    *   只能基于单张基表创建。
    *   聚合函数有限，通常只支持 `SUM`, `MIN`, `MAX`, `COUNT` 等。
*   **适用场景:**
    *   对单表进行不同维度的预聚合。
    *   对数据新鲜度要求极高，需要聚合结果与基表实时保持一致的场景。

**示例：为基表添加一个同步物化视图**
```sql
-- 在建表时定义
CREATE TABLE user_activity (
    event_date DATE,
    user_id INT,
    event_type VARCHAR(20),
    ...
)
...
PROPERTIES (
    "rollup_index" = "mv_user_event_count(event_date, user_id, COUNT(1))"
);

-- 或为已存在的表添加
ALTER TABLE user_activity ADD ROLLUP mv_user_event_count(event_date, user_id, COUNT(1));
```

## 3. 最佳实践

*   **优先选择异步物化视图:** 异步物化视图功能更强大，支持多表 Join 和更复杂的聚合函数，是绝大多数场景下的首选。

*   **保持定义简单:** 一个物化视图最好只服务于一类特定的查询模式。避免创建过于复杂的、试图满足所有查询的“万能”物化视图。

*   **确保查询可被重写:**
    *   查询中引用的列必须是物化视图中存在的列。
    *   查询中的聚合函数必须能从物化视图的聚合函数推导出来。例如，查询 `AVG(price)` 可以被基于 `SUM(price)` 和 `COUNT(price)` 的物化视图重写。
    *   `WHERE` 条件中的过滤列最好也包含在物化视图中。

*   **监控刷新状态:** 对于异步物化视图，需要定期检查其刷新状态，确保数据按时更新。
    ```sql
    -- 查看物化视图定义和状态
    SHOW MATERIALIZED VIEWS;

    -- 查看异步刷新任务的执行历史
    SELECT * FROM information_schema.tasks;
    SELECT * FROM information_schema.task_runs;
    ```

*   **使用 `EXPLAIN` 验证:** 在对一个慢查询进行优化时，如果创建了物化视图，务必使用 `EXPLAIN` 命令来验证该查询是否成功地被重写到了物化视图上。
    ```sql
    EXPLAIN SELECT ...;
    ```
    在执行计划中，如果 `Scan` 算子扫描的表是你的物化视图（如 `mv_daily_sales`），则说明重写成功。

## 4. 类型选择总结

| 特性 | 异步物化视图 (Asynchronous MV) | 同步物化视图 (Synchronous MV / Rollup) |
| :--- | :--- | :--- |
| **数据新鲜度** | 分钟级 ~ 小时级 (取决于刷新策略) | **实时** |
| **支持 Join** | **是** (核心优势) | 否 (仅限单表) |
| **聚合函数** | 支持绝大多数聚合函数 | 有限 (SUM, MIN, MAX, COUNT) |
| **资源消耗** | 刷新时消耗资源，对导入无影响 | 对导入有轻微性能影响 (需同步更新) |
| **适用场景** | 宽表预聚合、复杂指标计算、数据湖加速 | 单表多维度实时聚合 |
