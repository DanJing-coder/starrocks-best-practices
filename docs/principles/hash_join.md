# Hash Join 原理

Hash Join 是 StarRocks 中最常用、最高效的 Join 实现方式。它通过构建哈希表，将等值 Join 操作转化为高效的哈希查找，极大地提升了查询性能。理解其内部原理，有助于我们编写更高效的 Join SQL，并诊断相关的性能问题。

## 1. Hash Join 的基本流程

一个典型的 Hash Join 过程分为两个阶段：**Build (构建) 阶段** 和 **Probe (探查) 阶段**。

*   **Build Phase:**
    1.  优化器会选择一个表作为 **Build Table** (构建表)，通常是两个表中较小的一个（经过过滤后）。
    2.  BE 节点会扫描 Build Table 的数据，并根据 Join Key 计算哈希值。
    3.  将 Join Key 和对应的行数据存入一个内存中的哈希表（`HashTable`）中。

*   **Probe Phase:**
    1.  另一个表则作为 **Probe Table** (探查表)。
    2.  BE 节点会流式地扫描 Probe Table 的数据，并同样根据 Join Key 计算哈希值。
    3.  用计算出的哈希值去哈希表中查找。如果找到了匹配的 Key，则将 Probe Table 的行与哈希表中存储的 Build Table 的行拼接起来，形成 Join 结果。

```mermaid
graph TD
    subgraph Build Phase (小表)
        ScanOrders["Scan orders (小表)"] --> BuildHashTable["构建哈希表<br/>(基于 o_orderkey)"];
    end

    subgraph Probe Phase (大表)
        ScanLineitem["Scan lineitem (大表)"] --> ProbeHashTable["探查哈希表<br/>(基于 l_orderkey)"];
    end

    BuildHashTable -- "哈希表构建完成" --> ProbeHashTable;
    ProbeHashTable --> Result["输出 Join 结果"];

    style BuildHashTable fill:#f9f,stroke:#333,stroke-width:2px
```

## 2. 分布式 Hash Join

在分布式环境中，数据分布在多个 BE 节点上。StarRocks 会根据表的统计信息和成本估算，选择不同的数据分发策略来执行 Hash Join。

### 2.1 Broadcast Join (广播 Join)

*   **适用场景:** 当 Build Table 非常小（例如，小于几十 MB）时。
*   **工作原理:**
    1.  将完整的 Build Table（小表）广播到所有参与 Probe Table（大表）扫描的 BE 节点上。
    2.  每个 BE 节点都在本地独立地构建哈希表，并用本地的大表数据进行 Probe。
*   **优点:** 避免了对大表进行网络 shuffle，网络开销小。
*   **缺点:** 如果小表不够小，广播的成本会很高，并且会在每个 BE 节点上都占用一份内存来构建哈希表。

### 2.2 Shuffle Join (重分布 Join)

*   **适用场景:** 当两个表都比较大，不适合广播时。这是最常见的分布式 Join 方式。
*   **工作原理:**
    1.  根据 Join Key 对 Build Table 和 Probe Table 的数据进行哈希重分布（Shuffle）。
    2.  确保拥有相同 Join Key 的数据会被发送到同一个 BE 节点上。
    3.  每个 BE 节点接收到属于自己的数据后，在本地执行标准的 Hash Join 流程。
*   **优点:** 可以处理任意大小的表的 Join，并且 Join 的计算压力被均匀地分散到所有 BE 节点上。
*   **缺点:** 需要对两个表都进行网络 shuffle，网络开销较大。

### 2.3 Colocate Join

*   **适用场景:** 如果两个表在建表时使用了相同的分桶键，并且分桶数相同，就可以触发 Colocate Join。
*   **工作原理:** 由于数据在导入时就已经按照 Join Key 预先分布好了，执行 Join 时**完全不需要进行网络 shuffle**。每个 BE 节点直接在本地执行 Join 操作即可。
*   **优点:** 性能最高的 Join 方式，因为它消除了网络传输的瓶颈。
*   **缺点:** 对数据建模有要求，需要提前规划。

### 2.4 Bucket Shuffle Join

*   **适用场景:** 当 Probe Table (大表) 已经按照 Join Key 分桶，但 Build Table (小表) 没有采用相同的分桶策略（例如，小表是随机分桶，或者分桶键不同）时。
*   **工作原理:** 这是对标准 Shuffle Join 的一种优化。优化器识别到大表的数据已经按 Join Key 分布在各个 BE 节点上，因此**只需要将小表的数据进行 shuffle**，发送到大表对应分桶所在的 BE 节点。大表本身则完全避免了网络传输。
*   **优点:** 相比于需要 shuffle 两张表的标准 Shuffle Join，极大地减少了网络开销，性能提升显著。
*   **缺点:** 仍然需要 shuffle 小表，性能不如 Colocate Join。

## 3. 哈希表的实现与优化

StarRocks 的哈希表实现经过了大量优化，以应对大数据量和高并发。

*   **分区哈希表 (Partitioned Hash Table):** 为了降低锁竞争和提升并发能力，StarRocks 会将一个大的哈希表在逻辑上切分成多个小的分区（Partition），每个分区由一个独立的锁来保护。Probe 线程可以并行地访问不同的分区。

*   **溢写 (Spill to Disk):** 当内存不足以容纳整个哈希表时，StarRocks 支持将部分哈希表数据溢写到磁盘上。
    *   **工作原理:** 在 Build 阶段，如果发现内存不足，会将部分数据分区写入临时文件。在 Probe 阶段，会先处理内存中的分区，然后再分批加载磁盘上的分区进行处理。
    *   **影响:** 溢写可以保证大查询的成功执行，但会引入磁盘 I/O，显著降低 Join 性能。

## 4. 最佳实践与诊断

*   **使用 `EXPLAIN` 查看 Join 策略:**
    `EXPLAIN` 的输出会明确显示 Join 的类型 (`BROADCAST` 或 `SHUFFLE`)。
    ```
    HASH JOIN(SHUFFLE)
    ```
    通过这个信息，可以判断优化器的选择是否符合预期。

*   **监控内存与溢写:**
    *   在 Query Profile 中，可以查看 `HashJoinBuild` 和 `HashJoinProbe` 算子的详细信息。
    *   关注 `MemoryUsage` 指标，如果它接近 `exec_mem_limit`，说明内存压力较大。
    *   如果 `Spill` 相关的指标大于 0，说明发生了溢写，这是需要重点优化的信号。

*   **优化建议:**
    *   **收集准确的统计信息:** CBO 依赖统计信息来决定使用 Broadcast 还是 Shuffle Join。过时的统计信息可能导致优化器选择次优的计划。
    *   **利用 Colocate Join:** 对于频繁 Join 的大表，应在数据建模阶段就规划好 Colocate Group。
    *   **增加过滤条件:** 在 `WHERE` 子句中增加对 Build Table 的过滤条件，可以有效减小哈希表的大小，甚至可能将一个 Shuffle Join 优化为 Broadcast Join。
    *   **调整 Session 变量:** 对于内存不足导致溢写的大查询，可以临时调高 `exec_mem_limit`。

---

参考资料: StarRocks 技术内幕：[Hash Join 实现](https://zhuanlan.zhihu.com/p/593611907)

## 5. 其他 Join 类型

### 5.1 Nested Loop Join (嵌套循环 Join)

*   **描述:** 这是一种“最后的手段”，当其他高效的 Join 算法（如 Hash Join）因 Join 条件的限制而无法使用时，优化器才会选择它。
*   **适用场景:**
    *   **非等值连接 (Non-Equi Join):** 例如 `t1.id > t2.id` 或 `t1.col BETWEEN t2.start AND t2.end`。
    *   **某些复杂的 `OR` 条件。**
*   **工作原理:** 其基本思想是嵌套循环，对于外层表的每一行，遍历内层表的所有行来检查 Join 条件是否满足。虽然 StarRocks 内部有优化（如块嵌套循环 Block-Nested Loop Join），但其计算复杂度（O(M*N)）仍然非常高。
*   **性能影响:** 性能极差，尤其是在处理大表时。应极力避免触发 Nested Loop Join。
*   **诊断:**
    *   在 `EXPLAIN` 的输出中，会明确显示 `NESTLOOP JOIN`。
    *   如果发现它，通常意味着需要重写 SQL 或优化数据模型。例如，有时可以将非等值 Join 转换为等值 Join 和范围过滤的组合，以利用更高效的 Hash Join。