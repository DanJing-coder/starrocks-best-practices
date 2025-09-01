# 集群配置

合理的配置是保证 StarRocks 集群稳定、高效运行的关键。StarRocks 提供了灵活的配置方式，允许用户在不同层级、通过不同方式调整集群行为。本章将详细介绍 FE、BE 的配置方式以及 Session 变量的设置方法。

## 1. 配置层级

StarRocks 的配置主要分为三个层级：

*   **FE 配置:** 控制 Frontend 节点的行为，如元数据管理、查询调度策略等。
*   **BE 配置:** 控制 Backend 节点的行为，如存储路径、内存限制、Compaction 策略等。
*   **Session 变量:** 控制当前会话的行为，如查询超时时间、执行内存限制等。对 SQL 性能影响最直接。

## 2. FE 配置

FE 的配置分为静态配置和动态配置。

### 2.1 静态配置 (fe.conf)

静态配置是指导 FE 进程启动和长期运行的基础参数。

*   **配置文件:** `fe/conf/fe.conf`
*   **修改方式:**
    1.  编辑 `fe.conf` 文件。
    2.  重启 FE 进程使配置生效。
*   **适用场景:** 适用于需要持久化、在 FE 启动时就必须确定的参数，如 `meta_dir`、`http_port` 等。
*   **示例:**
    ```properties
    # 元数据存储目录
    meta_dir = /data/starrocks/fe/meta

    # HTTP 服务端口
    http_port = 8030
    ```

### 2.2 动态配置 (ADMIN SET CONFIG)

动态配置允许在 FE 运行时在线修改部分参数，无需重启进程。

*   **修改方式:** 通过 MySQL 客户端连接到 FE，使用 `ADMIN SET FRONTEND CONFIG` 命令。
*   **适用场景:** 适用于临时调整、测试或紧急变更某些运行时参数。
*   **如何识别:** 可以通过 `ADMIN SHOW FRONTEND CONFIG;` 命令查看所有 FE 参数，其中 `IsMutable` 列为 `true` 的参数支持动态修改。
*   **注意事项:**
    *   动态修改的参数在 FE 重启后会失效。
    *   如需持久化，**必须**将配置项同步写入所有 FE 节点的 `fe.conf` 文件中。
*   **示例:**
    ```sql
    -- 动态调整元数据回收站的过期时间为 1 天 (86400 秒)
    ADMIN SET FRONTEND CONFIG ("catalog_trash_expire_second" = "86400");

    -- 查看当前配置
    ADMIN SHOW FRONTEND CONFIG LIKE 'catalog_trash_expire_second%';
    ```

## 3. BE 配置

与 FE 类似，BE 的配置也分为静态和动态两种。

### 3.1 静态配置 (be.conf)

静态配置是指导 BE 进程启动和长期运行的基础参数。

*   **配置文件:** `be/conf/be.conf`
*   **修改方式:**
    1.  编辑 `be.conf` 文件。
    2.  重启 BE 进程使配置生效。
*   **适用场景:** 适用于需要持久化、在 BE 启动时就必须确定的参数，如 `storage_root_path`、`be_port` 等。
*   **示例:**
    ```properties
    # 数据存储目录，可配置多个，用分号 ; 隔开
    storage_root_path = /data1/starrocks/be;/data2/starrocks/be

    # BE 心跳服务端口
    heartbeat_service_port = 9050
    ```

### 3.2 动态配置 (SQL 命令)

动态配置允许在 BE 运行时在线修改部分参数，无需重启进程。

*   **修改方式:** 通过更新 `information_schema.be_configs` 系统表实现 BE 配置变更。
*   **如何识别:** 可以通过 `SELECT * FROM information_schema.be_configs;` 查看所有 BE 参数，其中 `MUTABLE` 列为 `true` 的参数支持动态修改。
*   **适用场景:** 适用于临时调整、测试或紧急变更某些运行时参数。
*   **注意事项:**
    *   动态修改的参数在 BE 重启后会失效。
    *   如需持久化，**必须**将配置项同步写入所有 BE 节点的 `be.conf` 文件中。
*   **示例:**
    ```sql
    # 动态调整 trash 文件的过期时间为 1 天 (86400 秒)

    update information_schema.be_configs set value='86400' where name = 'trash_file_expire_time_sec';
    # 查看当前配置 
    select * from information_schema.be_configs where name = 'trash_file_expire_time_sec';
    ```

## 4. Session 变量

Session 变量用于控制当前用户会话的特定行为，对查询性能调优至关重要。它可以分为 Session 级别和 Global 级别。

### 4.1 Session 级别修改

只对当前连接会话生效，连接断开后失效。

*   **修改方式:** 使用 `SET` 命令。
*   **适用场景:** 针对特定的查询进行临时调优，避免影响其他业务。
*   **示例:**
    ```sql
    -- 将当前会话的查询超时时间设置为 1 小时
    SET query_timeout = 3600;

    -- 临时增加当前查询的执行内存限制
    SET exec_mem_limit = 8589934592; -- 8GB

    -- 查看当前会话的变量
    SHOW VARIABLES LIKE 'query_timeout';
    ```

### 4.2 SQL 级别修改 (Hint)

通过在 SQL 语句中使用 Hint (`/*+ ... */`)，可以为单条查询设置变量，其优先级最高，会覆盖 Session 和 Global 级别的同名变量。

*   **修改方式:** 使用 `SET_VAR` Hint。
*   **适用场景:** 针对某一条特定的、行为异常或需要特殊资源的 SQL 进行精细化控制，而不影响任何其他查询。
*   **示例:**
    ```sql
    -- 仅为这条 SELECT 查询设置 20GB 的执行内存和 16 的并行度
    SELECT /*+ SET_VAR(exec_mem_limit = 21474836480, pipeline_dop = 16) */
        repo_name,
        count()
    FROM
        github_events
    GROUP BY
        repo_name
    ORDER BY
        count() DESC
    LIMIT 10;
    ```

### 4.3 Global 级别修改

对所有后续新建的会话生效，但对当前已存在的会话不生效。

*   **修改方式:** 使用 `SET GLOBAL` 命令。
*   **适用场景:** 希望为所有业务设置一个统一的默认行为基线。
*   **注意事项:**
    *   Global 级别的修改只对后续新建的会话生效。
    *   Global 级别的修改在 FE 重启后会失效，如需持久化，请考虑写入 `fe.conf`。
*   **示例:**
    ```sql
    -- 将全局的查询超时时间设置为 1 小时
    SET GLOBAL query_timeout = 3600;

    -- 查看全局变量
    SHOW GLOBAL VARIABLES LIKE 'query_timeout';
    ```

### 4.4 用户级别修改 (User Property) (v3.3.3开始支持)

可以将 Session 变量作为用户属性进行设置，这样该用户每次创建新连接时，这些变量会自动生效，成为该用户的默认配置。

*   **修改方式:** 使用 `SET PROPERTY FOR` 命令。
*   **适用场景:** 为特定类型的用户（如数据分析师、ETL 用户）设置统一的资源限制或查询行为。
*   **注意事项:**
    *   这是**持久化**的配置，设置后永久生效，不受 FE 重启影响。
*   **示例:**
    ```sql
    -- 为 'analyst' 用户设置默认的查询超时时间为 2 小时
    SET PROPERTY FOR 'analyst' 'query_timeout' = '7200';

    -- 查看用户的属性
    SHOW PROPERTY FOR 'analyst';
    ```

---

**总结:**

*   **持久化配置:** 写入 `.conf` 文件并重启进程。这是最标准、最可靠的方式。
*   **临时/在线修改:** 使用动态修改命令 (`ADMIN SET ... CONFIG`, `UPDATE ...`)。修改后若需持久化，务必同步更新到配置文件中。
*   **查询调优优先级:** `Hint` > `Session SET` > `User Property` > `Global SET` > `fe.conf`。
*   **推荐调优方式:** 优先使用 Session 级别的 `SET` 或 SQL 级别的 `Hint`，精细化控制查询行为，避免对其他业务造成影响。