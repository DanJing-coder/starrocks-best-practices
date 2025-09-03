# Runtime Filter 原理

Runtime Filter (运行时过滤器) 是 StarRocks 查询优化器中的一项关键技术，专门用于加速 Join 查询，尤其是在星型或雪花模型中。它通过在执行过程中动态生成过滤器，并将其下推到数据扫描节点，从而在早期阶段就过滤掉大量无用的数据，极大地减少了 I/O、网络传输和后续的计算开销。

## 1. 为什么需要 Runtime Filter？

在典型的分析型查询中，经常会遇到大表（事实表）与小表（维度表）的 Join。例如：

```sql
SELECT ...
FROM lineitem -- 事实表 (大)
JOIN orders ON lineitem.l_orderkey = orders.o_orderkey -- 维度表 (小)
WHERE orders.o_orderdate = '1994-01-01';
```

传统的执行方式是：
1.  扫描 `orders` 表，并根据 `WHERE` 条件过滤。
2.  扫描 `lineitem` 表（**全量扫描**）。
3.  将两个表的数据通过网络 shuffle 到 Join 节点进行关联。

这种方式的瓶颈在于，`lineitem` 表被全量扫描并参与了网络传输，即使其中大部分数据在 Join 后都会被丢弃。

Runtime Filter 正是为了解决这个问题而生。

## 2. 工作原理

Runtime Filter 的核心思想是“用小表的数据去过滤大表”。它将 Join 过程分为 **Build 端** (构建端，通常是小表) 和 **Probe 端** (探查端，通常是大表)。

```mermaid
graph TD
    subgraph BE 节点 1 (Build Side)
        ScanOrders["Scan orders<br />(o_orderdate = '1994-01-01')"] --> BuildFilter["1. 生成 Runtime Filter<br />(基于 o_orderkey)"];
    end

    subgraph BE 节点 2 (Probe Side)
        ScanLineitem["3. Scan lineitem<br />(应用 Filter)"] --> Join;
    end

    BuildFilter -- "2. 推送 Filter" --> ScanLineitem;
    ScanOrders -- "数据" --> Join;
    ScanLineitem -- "过滤后的数据" --> Join;
    Join --> Result["输出结果"];

    style BuildFilter fill:#f9f,stroke:#333,stroke-width:2px
```

1.  **生成 Filter (Build Phase):** 在执行 Join 的 Build 端（上图中的 `orders` 表），优化器会额外增加一个 `RuntimeFilter` 算子。它会根据 Join Key (`o_orderkey`) 的值，在内存中生成一个过滤器。
2.  **推送 Filter (Push Phase):** 这个生成好的过滤器会被推送（Push）到 Probe 端（`lineitem` 表）的 `Scan` 算子。
3.  **应用 Filter (Probe Phase):** `Scan` 算子在扫描 `lineitem` 表的数据时，会先用接收到的 Runtime Filter 对数据进行过滤。只有那些 Join Key 存在于过滤器中的数据才会被读取和向上层算子传递。

通过这种方式，`lineitem` 表在扫描阶段就过滤掉了大量不可能 Join 成功的数据，从而显著提升了整体查询性能。

## 3. Runtime Filter 的类型

StarRocks 会根据 Join Key 的数据类型、基数和成本模型，智能地选择不同类型的 Runtime Filter：

*   **IN Filter:**
    *   **原理:** 将 Build 端的所有 Join Key 值收集成一个集合。
    *   **适用场景:** 适用于 Build 端数据量和基数都非常小的情况。如果 Key 的数量过多，会消耗大量内存并增加网络传输开销。
*   **Bloom Filter (最常用):**
    *   **原理:** 将 Build 端的所有 Join Key 值构建成一个布隆过滤器。这是一种空间效率极高的概率性数据结构。
    *   **适用场景:** 适用于绝大多数场景，尤其是 Join Key 基数较高时。它能在内存占用和过滤效果之间取得很好的平衡。
*   **MIN/MAX Filter:**
    *   **原理:** 计算出 Build 端 Join Key 的最大值和最小值，形成一个范围。
    *   **适用场景:** 适用于数值类型或日期类型的 Join Key。它可以快速排除掉 Probe 端不在这个范围内的值。

优化器会根据成本自动选择最优的 Filter 类型，甚至可能同时使用多种 Filter（如 Bloom Filter + MIN/MAX Filter）以达到最佳过滤效果。

## 4. 如何观察 Runtime Filter

*   **`EXPLAIN` 命令:**
    在 `EXPLAIN` 的执行计划中，`Hash Join Node` 部分会显示 Runtime Filter 的详细信息，包括 Filter ID、生成节点、目标节点以及类型。
    ```
    runtime-filter: RF000[in] <- orders.o_orderkey
    ```
*   **Query Profile:**
    在 FE 的 Web UI 或通过 `SHOW PROFILE` 命令可以获取查询的 Profile。在 Profile 中搜索 `RuntimeFilter`，可以查看到每个 Filter 的构建时间、推送时间、大小以及实际的过滤效果（过滤了多少行数据）。这是分析 Runtime Filter 是否生效、效果如何的最直接方式。

---

参考资料: StarRocks 技术内幕：[Runtime Filter](https://zhuanlan.zhihu.com/p/605085563)