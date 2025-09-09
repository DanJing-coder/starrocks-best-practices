---
sidebar_position: 10
---

# StarRocks 原理

深入理解 StarRocks 的内部工作原理，可以帮助您更好地进行性能调优、故障排查和系统设计。本章将揭示 StarRocks 在查询处理、数据导入、存储优化等方面的核心技术与设计思想。

*   **[查询处理](./query_processing.md):** 探索一条 SQL 查询在 StarRocks 内部的完整生命周期，从解析、分析、优化到最终执行的全过程。
*   **[数据导入](./data_ingestion.md):** 了解 StarRocks 如何高效地处理和写入来自不同数据源的数据。
*   **[Compaction](./compaction.md):** 揭示 StarRocks 背后默默无闻的数据管家——Compaction 机制，如何通过合并数据版本来提升查询性能。
*   **[CBO 优化器](./optimizer.md):** 深入了解 StarRocks CBO 优化器的核心组件，包括 Join Reorder、Runtime Filter 等。
*   **[Hash Join 实现](./hash_join.md):** 探索 StarRocks 中 Hash Join 算子的实现细节。
*   **[Join Reorder](./join_reorder.md):** 了解 StarRocks 如何通过 Join Reorder 技术找到多表关联的最优执行顺序。
*   **[Runtime Filter](./runtime_filter.md):** 学习 Runtime Filter 如何在运行时动态生成过滤条件，大幅减少 Join 操作中的数据扫描量。
*   **[Aggregate 算子](./aggregate_operator.md):** 了解 StarRocks 中聚合算子的实现原理。