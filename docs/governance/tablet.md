# Tablet 治理

Tablet 是 StarRocks 中数据存储和管理的基本单元。随着业务的增长和数据的累积，集群中的 Tablet 数量会不断增加。对 Tablet 进行有效的治理，是保障集群长期健康、稳定和高性能运行的核心运维工作之一。

本章将重点介绍 Tablet 治理的关键方面，并提供一套自动化的巡检脚本，帮助您高效地管理 Tablet。

## 1. 核心治理目标

Tablet 治理主要关注以下几个方面：

*   **健康度 (Health):** 确保所有 Tablet 的副本都处于健康（`OK`）状态。异常的副本（如 `VERSION_ERROR`, `SCHEMA_ERROR`）会影响数据的可靠性和查询的稳定性。
*   **均衡度 (Balance):** 确保 Tablet 在所有 BE 节点之间均匀分布。数据倾斜会导致部分节点负载过高，成为整个集群的性能瓶颈。
*   **合理性 (Sanity):** 确保 Tablet 的数量在合理范围内。单个表或分区有过多的 Tablet 会增加 FE 的元数据管理负担和调度开销。

## 2. 自动化巡检与健康度报告

手动排查成千上万个 Tablet 的状态是不现实的。为了解决这个问题，我们提供了一个专门的健康度报告脚本 `healthy_report.py`，它可以自动化地巡检集群中所有 Tablet 的状态，并生成一份详细、直观的 HTML 报告。

### 脚本功能

`healthy_report.py` 专注于对 Tablet 进行深度分析，其核心功能包括：

*   **Tablet 副本健康度:** 逐一检查所有表的副本，详细列出状态非 `OK` 的副本信息，帮助您快速定位问题副本。
*   **Colocate Group 健康度:** 检查 Colocate 表分组的副本均衡状态，高亮显示不稳定的 Group。
*   **Tablet 分布均衡度:** 分析 Tablet 在各个 BE 节点上的分布情况，并计算标准差，量化数据倾斜程度。
*   **HTML 报告:** 生成对用户友好的 HTML 报告，高亮异常项，让问题一目了然，便于分析和分享。

### 使用说明

#### 步骤 1: 下载脚本

```bash
wget https://raw.githubusercontent.com/DanJing-coder/database-tools/main/starrocks/healthy_report.py
```

#### 步骤 2: 安装依赖

脚本依赖 `PyMySQL` 库来连接 StarRocks。

```bash
pip3 install PyMySQL
```

#### 步骤 3: 运行脚本

执行脚本并传入 FE 的连接信息。脚本会在当前目录下生成名为 `sr_healthy_report.html` 的文件。

```bash
python3 healthy_report.py --host <your_fe_host> --port <your_fe_query_port> --user <your_user> --password <your_password>
```

**参数说明:**
*   `--host`: FE 节点的 IP 地址。
*   `--port`: FE 节点的查询端口 (默认为 9030)。
*   `--user`: StarRocks 用户名。
*   `--password`: 用户密码。

#### 步骤 4: 查看报告

用浏览器打开在脚本同级目录下生成的 `sr_healthy_report.html` 文件，即可查看详细的健康度报告。

报告会清晰地列出不健康的 Tablet 副本、不均衡的 Colocate Group 等信息，并提供相关的 SQL 查询语句，方便您进行下一步的排查和修复。

## 3. 辅助工具

### 3.1 Tablet 治理与分桶优化工具 (`StarRocksBuckets`)

`StarRocksBuckets` 是一个强大的命令行工具，用于分析和优化 StarRocks 表的分桶策略。它能够连接到您的集群，分析表的实际数据量，并自动生成用于调整分桶数、甚至修改分桶键的 DDL 语句，是进行 Tablet 治理的利器。

> **版本兼容性说明:**
> 该工具推荐在 **StarRocks 3.3** 及以上版本使用。部分高级功能（如修改分桶键）依赖于较新版本的 StarRocks 内核，在低版本中可能不支持。

#### 3.1.1 前置准备：创建配置表

该工具通过一个外部 MySQL 表来管理 StarRocks 集群的连接信息。在使用前，您需要在您的 MySQL 数据库中创建此配置表，并填入要管理的 StarRocks 集群的连接信息。

```sql
CREATE TABLE `starrocks_information_connections` (
  `app` varchar(100) NOT NULL COMMENT '集群名称(英文), 用于 -s 参数指定',
  `nickname` varchar(100) DEFAULT NULL COMMENT '别名',
  `alias` varchar(100) DEFAULT NULL COMMENT '集群别名',
  `feip` varchar(200) NOT NULL COMMENT '集群连接地址(必填)F5,VIP,CLB,FE',
  `user` varchar(200) NOT NULL COMMENT '集群登录账号(必填) 建议是管理员角色的账号',
  `password` varchar(500) NOT NULL COMMENT '集群登录密码(必填)',
  `feport` int NOT NULL DEFAULT '9030' COMMENT '集群登录端口，默认9030',
  `address` varchar(500) DEFAULT NULL COMMENT 'MANAGER地址，如果填了MANAGER地址，那么将触发定时检查LICENSE是否过期(企业级)',
  `expire` int DEFAULT '30' COMMENT 'LICENSE是否过期(企业级)过期提醒倒计时，单位day',
  `status` int NOT NULL DEFAULT '0' COMMENT 'LICENSE是否过期(企业级)开关,0 off, 1 on',
  `fe_log_path` varchar(500) DEFAULT NULL COMMENT 'FE 日志目录',
  `be_log_path` varchar(500) DEFAULT NULL COMMENT 'BE 日志目录',
  `java_udf_path` varchar(500) DEFAULT NULL COMMENT 'BE 日志目录',
  `manager_access_key` varchar(500) DEFAULT NULL,
  `manager_secret_key` varchar(500) DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='StarRocks登录配置';
```

#### 3.1.2 核心功能与用法示例

**通用步骤:**

1.  **下载工具**
    从 [GitHub Releases](https://github.com/chengkenli/StarRocksBuckets/releases) 页面下载适合您操作系统的最新版本。

2.  **授予执行权限**
    ```bash
    chmod +x StarRocksBuckets
    ```

**1. 自动分析并调整分区桶数 (推荐)**

这是最常用的功能。工具会分析每个分区的数据量，并为 Tablet 大小不合理的分区自动生成 `ALTER TABLE` 语句，以调整其分桶数。

*   **命令:**
    ```bash
    # 分析 'my_cluster' 集群中 'test_db.my_table' 表，并自动生成调整语句
    ./StarRocksBuckets -s my_cluster -t test_db.my_table -a
    ```
*   **核心参数:**
    *   `-s <app>`: 指定要连接的集群，对应配置表中的 `app` 字段。
    *   `-t <schema.table>`: 指定要分析的目标表。
    *   `-a`: (AUTO OVERWRITE) 自动覆写模式，直接生成并打印 `ALTER TABLE` 语句。
    *   `-n <size_in_mb>`: (可选) 指定期望的 Tablet 大小 (MB)，默认为 1024。
*   **输出示例:**
    ```sql
    -- The bucket num of partition `p20231101` is 32, and the data size is about 100.00 GB, so the bucket num should be adjusted to 100.
    ALTER TABLE `test_db`.`my_table` MODIFY PARTITION p20231101 SET("bucket_size" = "100");
    ```

**2. 修改表的全局分桶数**

强制修改一个表所有分区的分桶数。**请谨慎使用此功能**，因为它不考虑各分区实际数据量，可能导致 Tablet 过大或过小。

*   **命令:**
    ```bash
    # 将 'my_table' 表的所有分区的分桶数统一修改为 64
    ./StarRocksBuckets -s my_cluster -t test_db.my_table -b 64
    ```
*   **核心参数:**
    *   `-b <BucketNum>`: 指定全局的目标分桶数。

**3. 修改指定分区的分桶数**

对单个或多个特定分区进行分桶数调整。

*   **命令:**
    ```bash
    # 将分区 p20240101 的分桶数设置为 100
    ./StarRocksBuckets -s my_cluster -t test_db.my_table -b 100 -p p20240101 -pset
    ```
*   **核心参数:**
    *   `-p <PartitionName>`: 指定要修改的分区名，多个分区用逗号分隔。
    *   `-pset`: 确认执行分区级别重设的标志。

**4. 修改表的分桶键**

这是一个非常强大的功能，允许您在线修改表的分桶键，以解决因分桶键选择不当导致的数据倾斜问题。

*   **命令:**
    ```bash
    # 将 'my_table' 表的分桶键修改为 'user_id'
    ./StarRocksBuckets -s my_cluster -t test_db.my_table -splitkey user_id
    ```
*   **核心参数:**
    *   `-splitkey <new_bucket_key>`: 指定新的分桶键列名。

## 4. Tablet 治理最佳实践

遵循以下最佳实践，可以帮助您从源头上保证 Tablet 的健康与均衡。

1.  **Tablet 大小**
    *   **核心原则：** 合理设置分桶数，使得单个 Tablet 的原始数据大小保持在 **1GB** 左右。这是最重要的衡量标准。过大的 Tablet 会影响均衡和修复的效率；过小的 Tablet 会导致元数据管理开销增大。

2.  **分区与分桶策略**
    *   **小分区处理：** 对于单个分区数据量很小（如小于 100MB）的表，可以考虑将分区粒度从“天”改为“月”，以增加单个分区的数据量。
    *   **小表处理：** 对于全表数据量都很小的表，可以考虑不分区，只分桶。
    *   **业务权衡：** 上述策略需结合业务需求。例如，如果业务需要按天同步数据且查询会带分区键进行过滤，即使数据量小，也应保留按天分区，但需相应调小分桶数。
    *   **动态分区：** 对于有时间序列特征的表，强烈建议使用动态分区，并根据业务需求合理设置数据保留时间（`dynamic_partition.end`）和提前创建的分区数（`dynamic_partition.history_partition_num`）。
    *   **无分区表：** 对于不分区的表，在建表时应预估未来数据增量，适当调大分桶数。

3.  **处理数据倾斜**
    *   当发现数据倾斜严重（如巡检报告中 Tablet 大小的标准差大于 10）时，应首先检查分桶键的选择是否合理。分桶键**必须**是基数足够高、分布足够离散的列。
    *   如果分桶键没有问题，但不同分区的数据量差异巨大，可以为数据量大的分区单独设置更多的分桶数。

4.  **高并发小表**
    *   对于数据量小（< 100MB）但并发查询高（QPS > 10）的表，可以考虑设置 3 个分桶以提升并发能力。

5.  **控制集群总 Tablet 数**
    *   过多的 Tablet 会增加 FE 的元数据管理负担和调度开销。除了在建表时合理设置分桶数，还应定期清理生产环境中不再使用的测试表和备份表。
    *   生产环境**不建议**使用单副本表，应使用默认的 3 副本。请注意，副本数会使总 Tablet 数成倍增加。

## 5. 集成到日常运维

建议将此脚本加入到 Crontab 中，实现每日或每周的自动巡检，并将生成的 HTML 报告发送给相关运维人员。

```bash
```crontab
# 每日凌晨 2 点生成健康度报告
0 2 * * * cd /path/to/script && /usr/bin/python3 healthy_report.py --host <your_fe_host> --port <your_fe_query_port> --user <your_user> --password <your_password> > /dev/null 2>&1
```

通过定期分析健康度报告，您可以主动发现并处理潜在的 Tablet 问题，防患于未然。