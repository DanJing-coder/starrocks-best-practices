# SQL 查询治理

SQL 查询治理是确保 StarRocks 集群稳定、高效运行的关键环节。不规范的 SQL 查询可能导致资源耗尽、性能下降甚至集群崩溃。本章将介绍如何通过 SQL 黑名单机制和自动化工具来管理和优化集群中的查询。

## 1. SQL 黑名单机制 (SQL Blacklist)

StarRocks 提供了 SQL 黑名单功能，允许管理员通过正则表达式来拦截并禁止执行特定的 `SELECT` 和 `INSERT` 语句。这对于防止已知的高风险查询或不规范的 SQL 模式非常有用。

### 1.1 启用 SQL 黑名单

默认情况下，SQL 黑名单功能是关闭的。您需要先启用它。

#### 方式一：动态修改 (临时生效)

通过 `ADMIN SET FRONTEND CONFIG` 命令在线开启，无需重启 FE，但配置在 FE 重启后会失效。

```sql
ADMIN SET FRONTEND CONFIG ("enable_sql_blacklist" = "true");
```

#### 方式二：修改 `fe.conf` (持久化)

在所有 FE 节点的 `fe/conf/fe.conf` 文件中添加以下配置项，然后重启所有 FE 节点使其永久生效。

```properties
enable_sql_blacklist = true
```

### 1.2 管理黑名单规则

启用功能后，您可以通过以下命令来管理黑名单规则。这些规则会持久化在 FE 元数据中，并自动同步到所有 FE 节点。

#### 添加规则

使用 `ADD SQLBLACKLIST` 命令添加一条正则表达式规则。

```sql
-- 示例：禁止所有不带 WHERE 条件的 SELECT 查询
ADD SQLBLACKLIST "select .* from [^w]*;";

-- 示例：禁止对 `user_profile` 表进行 `count(*)` 查询
ADD SQLBLACKLIST "select count\\(\\*\\) from user_profile";
```

**匹配规则说明:**
*   SQL 黑名单目前只支持 `SELECT` 和 `INSERT` 语句。
*   在进行匹配前，StarRocks 会移除 SQL 语句中的注释，并将语句转换为小写。
*   正则表达式会匹配整个转换后的 SQL 语句。

#### 查看规则

使用 `SHOW SQLBLACKLIST` 查看当前所有生效的黑名单规则及其 `id`。

```sql
SHOW SQLBLACKLIST;
```

#### 删除规则

使用 `DELETE SQLBLACKLIST` 并指定规则的 `id` 来删除。

```sql
-- 删除 id 为 2 的规则
DELETE SQLBLACKLIST 2;
```

### 1.3 最佳实践与注意事项

*   **谨慎使用:** SQL 黑名单功能强大，但应谨慎使用，避免误杀正常业务查询。正则表达式的编写需要非常小心。
*   **测试先行:** 在生产环境启用前，务必在测试环境充分验证黑名单规则。
*   **逐步收紧:** 先从最明确、风险最高的 SQL 模式开始拦截，然后根据审计日志逐步增加规则。
*   **结合审计日志:** 结合审计日志 (`fe.audit.log`) 分析常见的异常查询模式，从而制定更精准的黑名单规则。
*   **错误提示:** 被黑名单拦截的查询会收到 `ERROR 1064 (HY000): errCode = 2, detailMessage = sql match black list` 的错误提示。

## 2. 资源隔离与大查询熔断 (资源组)

除了使用黑名单被动拦截外，更主动、更精细的治理方式是使用**资源组 (Resource Group)**。资源组是 StarRocks 实现多租户资源隔离和查询熔断的核心机制。

**核心功能:**
*   **资源隔离:** 为不同的用户或业务划分独立的资源池，限制其可用的 CPU 和内存资源，避免单个业务的异常查询影响整个集群的稳定性。
*   **大查询熔断:** 为资源组设置查询的资源消耗阈值（如 CPU 时间、扫描行数、内存使用量）。一旦组内某个查询超过阈值，系统会自动将其 `KILL` 掉，防止"坏查询"拖垮集群。

### 2.1 创建和配置资源组

通过 `CREATE RESOURCE GROUP` 命令来创建资源组，并设置其资源限制、熔断阈值和分类器。

```sql
-- 为 BI 报表用户创建一个资源组
CREATE RESOURCE GROUP rg_bi
TO 
    -- 分类器：可以直接将用户或角色绑定到资源组
    -- user: 按用户名匹配
    -- role: 按角色匹配
    -- query_type: 按查询类型 (select, insert) 匹配
    -- source_ip: 按客户端 IP 匹配
    (user='bi_user', role='bi_role')
PROPERTIES (
    "cpu_core_limit" = "10",
    "mem_limit" = "30%",
    "concurrency_limit" = "10",
    "big_query_cpu_second_limit" = "600",
    "big_query_scan_rows_limit" = "1000000000",
    "big_query_mem_limit" = "10737418240"
);
```

**核心参数说明:**
*   `cpu_core_limit`: CPU 核数限制。这是一个软限制，表示该组在任何时候都能保证获得的最小 CPU 核数，但在集群空闲时可以超出此限制。
    *   **如何设置:** 为了合理分配 CPU 资源，可以分析审计日志中各个用户的总 CPU 耗时，并按比例进行分配。
    *   **示例:**
        ```sql
        -- 1. 分析最近30天各用户的总 CPU 耗时及其占比
        SELECT 
            user,
            SUM(cpuCostNs) / 1e9 AS total_cpu_seconds,
            (SUM(cpuCostNs) / (SELECT SUM(cpuCostNs) FROM starrocks_audit_db__.starrocks_audit_tbl__ WHERE state IN ('EOF','OK') AND timestamp >= now() - interval 30 day)) * 100 AS cpu_usage_percentage
        FROM starrocks_audit_db__.starrocks_audit_tbl__
        WHERE state IN ('EOF','OK')
            AND timestamp >= now() - interval 30 day
        GROUP BY user
        ORDER BY total_cpu_seconds DESC
        LIMIT 20;

        -- 2. 假设BE节点为64核，根据查询结果可按比例分配。
        -- 例如，某用户占比16%时，可分配 64 * 16% ≈ 10 个核心。
        -- 在 PROPERTIES 中设置: "cpu_core_limit" = "10"
        ```
*   `mem_limit`: 内存使用上限。这是一个硬限制，表示该组所有查询总共能使用的最大内存，以占集群总内存的百分比表示。
    *   **如何设置:** 通常建议将所有业务资源组的 `mem_limit` 总和设置为一个较大比例（如 90%），为操作系统和其他进程预留一部分内存。
*   `concurrency_limit`: 最大并发数限制。当资源组内的并发查询数超过此值时，后续查询将进入排队等待。
    *   **如何设置:** 分析审计日志中每个用户在分钟级别的最大并发数，并以此为依据设置一个合理的上限（如最大并发的 1.5 倍）。
    *   **示例:**
        ```sql
        -- 1. 分析最近30天各用户在每分钟的最大查询并发数
        WITH UserConcurrency AS (
            SELECT 
                user,
                DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i') AS minute_bucket,
                COUNT(*) AS query_concurrency
            FROM starrocks_audit_db__.starrocks_audit_tbl__
            WHERE state IN ('EOF', 'OK')
                AND timestamp >= now() - interval 30 day
            GROUP BY user, minute_bucket
        )
        SELECT 
            user,
            MAX(query_concurrency) as max_concurrency_per_minute
        FROM UserConcurrency
        GROUP BY user
        ORDER BY max_concurrency_per_minute DESC
        LIMIT 20;

        -- 2. 假设某用户的分钟级最大并发为8，可以设置并发限制为 8 * 1.5 ≈ 12。
        -- 在 PROPERTIES 中设置: "concurrency_limit" = "12"
        ```
*   `big_query_cpu_second_limit`: 大查询的 CPU 时间熔断阈值（单位：秒）。
    *   **如何设置:** 此阈值用于防止查询长时间占用 CPU 资源。最佳实践是分析审计日志，找到正常查询的 P95 或 P99 `queryTime`，并在此基础上设置一个合理的上限（如 P99 的 1.5 到 2 倍）。
    *   **示例:**
        ```sql
        -- 1. 分析目标用户（如 'bi_user'）的 P99 查询时间
        SELECT percentile_approx(queryTime, 0.99) / 1000 AS p99_query_time_seconds
        FROM starrocks_audit_db__.starrocks_audit_tbl__
        WHERE user = 'bi_user' AND state IN ('EOF','OK');
        -- 假设查询结果为 300 秒。

        -- 2. 在 PROPERTIES 中设置熔断阈值为 P99 的 2 倍
        "big_query_cpu_second_limit" = "600"
        ```
*   `big_query_scan_rows_limit`: 大查询的扫描行数熔断阈值。
    *   **如何设置:** 此阈值用于防止查询扫描过多数据，特别是当用户忘记加分区或索引过滤条件时。同样，可以分析审计日志中正常查询的 `scanRows`，并设置一个比 P99 值稍大的阈值。
    *   **示例:**
        ```sql
        -- 1. 分析目标用户的 P99 扫描行数
        SELECT percentile_approx(scanRows, 0.99) AS p99_scan_rows
        FROM starrocks_audit_db__.starrocks_audit_tbl__
        WHERE user = 'bi_user' AND state IN ('EOF','OK');
        -- 假设查询结果为 500,000,000 行。

        -- 2. 在 PROPERTIES 中设置熔断阈值为 P99 的 2 倍
        "big_query_scan_rows_limit" = "1000000000"
        ```
*   `big_query_mem_limit`: 单个查询的内存使用熔断阈值（单位：字节）。
    *   **如何设置:** 这是防止 OOM 的最关键参数。通过分析审计日志中正常查询的 `memCostBytes`，可以了解业务查询的内存使用模式。建议将此阈值设置为业务查询 P99 内存使用量的 1.5 到 2 倍。
    *   **示例:**
        ```sql
        -- 1. 分析目标用户的 P99 内存消耗
        SELECT percentile_approx(memCostBytes, 0.99) AS p99_mem_cost_bytes
        FROM starrocks_audit_db__.starrocks_audit_tbl__
        WHERE user = 'bi_user' AND state IN ('EOF','OK');
        -- 假设查询结果为 5,368,709,120 字节 (5GB)。

        -- 2. 在 PROPERTIES 中设置熔断阈值为 P99 的 2 倍 (10GB)
        "big_query_mem_limit" = "10737418240"
        ```

### 2.2 绑定用户到资源组

创建资源组后，需要将用户绑定到该组，这样该用户的查询就会受到该资源组的管控。有两种绑定方式：

1.  **通过分类器绑定 (推荐):** 在 `CREATE RESOURCE GROUP` 或 `ALTER RESOURCE GROUP` 时使用 `TO` 子句指定分类器，可以按用户名、角色、来源 IP 等多维度进行匹配。
2.  **通过用户属性绑定 (v2.5+):** 使用 `SET PROPERTY` 命令为用户单独指定资源组。如果一个用户同时满足分类器规则和用户属性，**用户属性的优先级更高**。

```sql
-- 方式二：为用户 'bi_user' 单独绑定到 'rg_bi' 资源组
SET PROPERTY FOR 'bi_user' 'resource_group' = 'rg_bi';
```

### 2.3 最佳实践

*   **按业务分类:** 为不同类型的业务（如 ETL、BI 报表、Ad-hoc 即席查询）创建不同的资源组。
*   **差异化配置:**
    *   为 Ad-hoc 查询用户组设置最严格的熔断阈值，防止用户因不熟悉数据或 SQL 技能不足写出“坏查询”。
    *   为 BI 报表用户组设置较宽松的阈值，保证报表的正常运行。
    *   为 ETL/Admin 用户组设置最宽松的阈值，确保数据导入和管理任务不受影响。
*   **持续监控:** 通过 `information_schema.resource_groups` 视图或 Grafana 监控大盘，持续观察各资源组的资源使用情况，并根据实际情况动态调整配置。

## 3. 手动 Kill 查询

当发现某个正在运行的查询严重影响集群性能时，管理员可以手动将其终止。

1.  **查找查询 ID:**
    通过 `SHOW PROCESSLIST;` 命令查看当前正在运行的所有查询，找到目标查询的 `Id`。

2.  **执行 KILL 命令:**
    使用 `KILL` 命令并传入connection ID。
    ```sql
    KILL QUERY <processlist_id>;
    ```
    > **注意:** `KILL` 命令并非立即生效，系统需要一些时间来中断查询并回滚已占用的资源。