# 聚合算子原理

聚合（Aggregation）是数据分析中最常见的操作之一。StarRocks 的聚合算子经过了高度优化，能够高效地处理海量数据的 `GROUP BY`、`COUNT(DISTINCT)` 等聚合查询。其核心在于根据数据量和基数，自适应地选择不同的聚合策略和数据结构。

## 1. 聚合的阶段

一个分布式的聚合查询通常分为两个阶段：

1.  **本地预聚合 (Local Aggregation):**
    *   在每个 BE 数据扫描节点上，数据在本地进行第一轮预聚合。
    *   这会极大地减少需要通过网络传输的数据量，是分布式聚合性能的关键。
    *   例如，一个 `GROUP BY city` 的查询，每个 BE 节点会先计算出本节点内各个城市的聚合值。

2.  **最终聚合 (Final Aggregation):**
    *   各个 BE 节点将预聚合的结果通过网络 shuffle 到一个或多个 BE 节点上。
    *   在这些节点上，对来自不同节点的预聚合结果进行最终的合并，得到最终的聚合结果。

```mermaid
graph TD
    subgraph BE 节点 1
        Scan1[Scan Data] --> LocalAgg1(Local Aggregate)
    end
    subgraph BE 节点 2
        Scan2[Scan Data] --> LocalAgg2(Local Aggregate)
    end
    subgraph BE 节点 3
        Scan3[Scan Data] --> LocalAgg3(Local Aggregate)
    end

    subgraph BE 节点 4 (聚合节点)
        FinalAgg(Final Aggregate)
    end

    LocalAgg1 -- Shuffle --> FinalAgg
    LocalAgg2 -- Shuffle --> FinalAgg
    LocalAgg3 -- Shuffle --> FinalAgg
    FinalAgg --> Result[输出结果]
```

## 2. 聚合数据结构与策略

StarRocks 会根据 `GROUP BY` Key 的数据类型和基数，智能地选择最优的数据结构来存储聚合的中间结果。

### 2.1 整型 Key：`Int` & `Array`

当 `GROUP BY` 的 Key 是整型（如 `TINYINT`, `INT`, `BIGINT`）时，StarRocks 会优先使用数组或哈希表。

*   **`Array` (数组):**
    *   **适用场景:** 当 Key 的取值范围不大时（例如 `GROUP BY gender`，只有几个值）。
    *   **工作原理:** StarRocks 会创建一个数组，数组的下标直接对应 Key 的值。这种方式避免了哈希计算和冲突，性能极高。
*   **`Int` (哈希表):**
    *   **适用场景:** 当 Key 的取值范围较大，但实际出现的 Key 基数不高时。
    *   **工作原理:** 使用一个专门为整型优化的哈希表来存储聚合结果。

### 2.2 字符串 Key：`String` & `Serialized`

当 `GROUP BY` 的 Key 是字符串类型时，处理会更复杂。

*   **`String` (哈希表):**
    *   **适用场景:** Key 的长度较短，且基数不是特别高。
    *   **工作原理:** 使用一个为字符串优化的哈希表。
*   **`Serialized` (序列化哈希表):**
    *   **适用场景:** 当 `GROUP BY` 的 Key 包含多个字段，或者包含变长的 `VARCHAR` 字段时。
    *   **工作原理:** 将多个 Key 字段序列化成一个连续的二进制串，然后将这个二进制串作为哈希表的 Key。这避免了对多个字段分别进行哈希计算和比较，在多列 `GROUP BY` 场景下性能更优。

### 2.3 低基数优化 (`LowCardinality`)

当 `GROUP BY` 的 Key 是字符串类型，但优化器通过统计信息判断其基数非常低时（例如 `GROUP BY province`），StarRocks 会启用低基数优化。

*   **工作原理:**
    1.  在内存中为每个不同的字符串 Key 构建一个全局字典，将每个字符串映射为一个从 0 开始的整数 ID。
    2.  在聚合时，使用这些整数 ID 作为 Key，从而将对字符串的聚合操作转化为对整型的聚合操作。
*   **优点:** 极大地提升了低基数字符串的聚合性能，因为它利用了前面提到的、最高效的 `Array` 聚合方式。

## 3. `COUNT(DISTINCT)` 的优化

`COUNT(DISTINCT)` 是一个非常消耗资源的聚合操作。StarRocks 提供了多种优化手段。

*   **`Bitmap`:**
    *   **适用场景:** 当去重列是整型，且取值范围不大时。
    *   **工作原理:** 使用位图（Bitmap）数据结构。每个位代表一个数值，如果该数值出现，则将对应的位置为 1。
    *   **优点:** 性能极高，内存占用小，且支持跨节点的高效合并。
*   **`HLL` (HyperLogLog):**
    *   **适用场景:** 当去重列的基数非常大，或者是非整型时。
    *   **工作原理:** 一种概率性数据结构，可以用极小的内存空间估算超大集合的基数。
    *   **优点:** 内存占用固定且极小。
    *   **缺点:** 结果是估算值，存在一定误差（通常在 1% 左右）。

*   **`EXPLAIN` 查看聚合策略:**
    通过 `EXPLAIN` 命令，可以清晰地看到优化器为聚合算子选择了哪种数据结构和策略。
    ```
    AGGREGATE (update serialize): `count`(...)
    |  ...
    |  AGGREGATE (merge serialize): `count`(...)
    ```
    这里的 `serialize` 就表示优化器选择了序列化的哈希表策略。

---

参考资料: StarRocks 技术内幕：[聚合函数实现](https://zhuanlan.zhihu.com/p/592058276)