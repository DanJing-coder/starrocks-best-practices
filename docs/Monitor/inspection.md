# 集群巡检

定期的集群巡检是保障系统长期稳定运行、提前发现潜在风险的重要手段。一份标准化的巡检清单可以帮助运维人员系统性地检查集群的健康状况，确保所有关键组件和服务都处于正常状态。

建议根据集群的重要性和负载情况，执行每日或每周的例行巡检。

## 1. 巡检清单

本清单涵盖了从集群宏观状态到节点微观指标的各个层面。

### 1.1 集群整体状态

| 检查项 | 命令/方法 | 正常状态标准 | 异常处理 |
| :--- | :--- | :--- | :--- |
| **FE 节点状态** | `SHOW FRONTENDS;` | 所有节点的 `Alive` 和 `Join` 均为 `true`；有且仅有一个节点的 `IsMaster` 为 `true`。 | 检查离线节点的网络和进程，参考故障处理章节。 |
| **BE 节点状态** | `SHOW BACKENDS;` | 所有节点的 `Alive` 均为 `true`。 | 检查离线节点的网络和进程，参考故障处理章节。 |
| **BE 节点负载均衡** | `SHOW BACKENDS;` | 各个 BE 节点的 `TabletNum` 数量应大致均衡，差异不应过大（例如超过 20%）。 | 检查 `SHOW PROC '/cluster_balance';`，确认集群均衡功能正常。 |
| **Tablet 健康状态** | `SHOW PROC '/statistic';` | `abnormal_tablets_num` 的值应为 0。 | 执行 `ADMIN SHOW REPLICA STATUS` 找到异常副本，并进行修复。 |

### 1.2 节点级别状态 (在每个节点上执行)

| 检查项 | 命令/方法 | 正常状态标准 | 异常处理 |
| :--- | :--- | :--- | :--- |
| **FE/BE 进程状态** | `ps -ef \| grep starrocks` | 能找到 `StarRocksFe` 或 `starrocks_be` 进程。 | 检查进程是否被意外终止，查看对应日志排查原因。 |
| **FE/BE 端口监听** | `netstat -ntlp` | FE 的 `8030`, `9020`, `9030` 和 BE 的 `8040`, `9050`, `9060` 端口处于 `LISTEN` 状态。 | 检查进程是否正常启动。 |
| **磁盘空间** | `df -h` | 所有数据盘的使用率应低于 80%。 | 参考 磁盘空间不足 章节进行处理。 |
| **系统负载** | `top` 或 `uptime` | `load average` 应远低于 CPU 核数。 | 分析高负载原因，是查询、导入还是 Compaction 导致。 |
| **时间同步** | `ntpstat` 或 `chronyc tracking` | 显示 `synchronised to` 且 `offset` 很小。 | 检查 NTP 服务是否正常。 |
| **日志错误** | `tail -n 500 fe/log/fe.log` <br/> `tail -n 500 be/log/be.INFO` | 日志中不应出现持续的 `ERROR` 或 `FATAL` 级别的错误。 | 根据错误信息定位具体问题。 |

### 1.3 业务与性能状态

| 检查项 | 命令/方法 | 正常状态标准 | 异常处理 |
| :--- | :--- | :--- | :--- |
| **近期导入任务** | `SHOW LOAD ORDER BY CreateTime DESC LIMIT 20;` | 近期的导入任务状态应为 `FINISHED`。 | 关注 `CANCELLED` 状态的任务，根据 `ErrorMsg` 排查原因。 |
| **Routine Load 状态** | `SHOW ROUTINE LOAD;` | 所有 Routine Load 任务的 `State` 应为 `RUNNING`。 | 检查 `OtherMsg` 字段，排查 Kafka 连接或数据质量问题。 |
| **Compaction 状态** | 监控 `starrocks_be_tablet_max_compaction_score` 指标 | Compaction Score 应保持在较低水平（如 &lt; 100）。 | 分数持续过高说明 Compaction 积压，需优化导入策略或增加资源。 |
| **慢查询** | 分析 `fe.audit.log` 或监控系统 | 不应出现非预期的、耗时过长的查询。 | 使用 `Profile` 分析慢查询的执行计划，进行 SQL 优化。 |
| **表健康度** | `ADMIN CHECK TABLET (tbl_name) PROPERTIES("type" = "consistency");` | `InconsistentTabletNum` 应为 0。 | 找到不一致的副本并使用 `ADMIN REPAIR` 进行修复。 |

## 2. 巡检自动化建议

手动的例行巡检耗时耗力且容易遗漏。我们强烈建议将核心巡检项自动化，通过脚本定期执行，并将结果汇总成报告。

### 2.1 自动化脚本

为了更高效、更全面地进行巡检，我们提供了一个基于 Python 的自动化巡检脚本 `starrocks-doctor.py`。该脚本可以连接到集群，自动执行**集群整体状态**的大部分核心检查项，并以清晰的表格形式输出巡检报告，高亮显示异常指标。

**脚本功能:**

该脚本主要覆盖了巡检清单中 "1.1 集群整体状态" 的核心内容，包括：

*   **FE/BE 节点状态:** 检查所有节点的 `Alive` 状态。
*   **BE 节点磁盘健康与均衡:** 检查每个 BE 节点的磁盘使用率、总 Tablet 数量，并计算 Tablet 数量的均衡度（标准差）。
*   **Tablet 健康状态:** 检查集群中是否存在状态异常的 Tablet。
*   **Colocate 表状态:** 检查 Colocate 表的副本分布是否均衡。

#### 使用说明

1.  **下载脚本**
    ```bash
    wget https://raw.githubusercontent.com/DanJing-coder/database-tools/main/starrocks/starrocks-doctor.py
    ```

2.  **安装依赖**
    脚本依赖 `PyMySQL` 和 `prettytable` 库。
    ```bash
    pip3 install PyMySQL prettytable
    ```

3.  **授予执行权限**
    ```bash
    chmod +x starrocks-doctor.py
    ```

4.  **运行脚本**
    执行脚本并传入 FE 的连接信息。
    ```bash
    python3 starrocks-doctor.py --fe_host <your_fe_host> --fe_query_port 9030 --user <your_user> --password <your_password>
    ```

5.  **定时执行 (Crontab)**
    可以将巡检脚本加入到 `crontab` 中，实现每日自动巡检，并将报告输出到日志文件。
    ```crontab
    # 每天上午 9 点执行巡检
    0 9 * * * /usr/bin/python3 /path/to/starrocks-doctor.py --fe_host ... >> /path/to/logs/sr_check.log 2>&1
    ```

#### 示例输出
```
*************************************
* StarRocks Cluster Health Check Report *
* Time: 2023-11-22 10:00:00           *
*************************************

====== Frontend Status ======
+---------------+-----------------+----------+...
| Name          | IP              | Role     |...
+---------------+-----------------+----------+...
| starrocks-fe1 | 192.168.1.1     | FOLLOWER |...
+---------------+-----------------+----------+...
[OK] All FE nodes are alive.

====== Backend Status ======
+-----------+-----------------+-------+...
| BackendId | Host            | Alive |...
+-----------+-----------------+-------+...
| 10001     | 192.168.1.1     | true  |...
+-----------+-----------------+-------+...
[OK] All BE nodes are alive.
...
```

### 2.2 集成到监控系统

更专业的做法是将巡检逻辑集成到现有的监控告警体系中。

*   **Prometheus:** 可以使用 `blackbox_exporter` 来探测 FE/BE 的 HTTP 端口，或使用 `mysqld_exporter` 的自定义查询功能来执行 `SHOW` 命令，并将结果转换为 Prometheus 指标。
*   **Zabbix/Nagios:** 可以将上述 Shell 脚本作为自定义监控项，由 Zabbix Agent 定期执行并上报结果。

通过自动化巡检，可以极大地提升运维效率，将被动响应故障转变为主动发现和预防问题。