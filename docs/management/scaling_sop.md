# 集群扩缩容 (SOP)

随着业务的发展，对 StarRocks 集群进行扩容或缩容是常见的运维操作。本章将提供标准的扩缩容操作流程（SOP），并提供一份详细的检查清单，确保扩缩容过程平滑、安全。

## 1. 扩缩容方式

*   **横向扩缩容 (Horizontal Scaling):** 通过增加或减少集群中的节点数量来调整集群的整体处理能力和存储容量。这是分布式系统中最常用、最推荐的扩缩容方式。
*   **纵向扩缩容 (Vertical Scaling):** 通过增加或减少单个节点的硬件资源（如 CPU、内存）来调整其处理能力。

## 2. 扩缩容前置检查清单 (Pre-Scaling Checklist)

在进行任何扩缩容操作（尤其是添加新节点或升级资源）之前，请务必对照以下清单进行逐一检查，以防止因环境不一致或配置遗漏导致的问题。

### 2.1 环境与配置检查

- [ ] 参考 [环境初始化 checklist](../deployment/deploy_checklist.md) 检查。
- [ ] **StarRocks 版本一致性:** 确认新节点上部署的 StarRocks 版本与现有集群**完全一致**。
- [ ] **StarRocks 配置文件:** 确认新节点的 FE/BE 配置文件 (`fe.conf`/`be.conf`) 是基于现有节点修改而来，保证了端口、路径等核心配置的统一性。

### 2.2 依赖与连通性检查

- [ ] **Kerberos 认证:** 如果集群启用了 Kerberos：
    - [ ] `krb5.conf` 文件是否已正确配置并分发到新节点？
    - [ ] `keytab` 文件是否已分发到新节点，并确保 `starrocks` 用户有读取权限？
    - [ ] 新节点的 `principal` 是否已创建并加入到相关的服务权限中？
- [ ] **UDF 函数:** 如果使用了 Java UDF：
    - [ ] 相关的 JAR 包是否已拷贝到新 BE 节点的指定目录 (`be/lib/udf/` 或自定义路径)？
- [ ] **外部数据目录 (Catalog):** 如果使用了 Hive/Iceberg/Hudi 等外部数据目录：
    - [ ] 新节点是否可以无障碍访问外部的元数据服务（如 Hive Metastore）和存储系统（如 HDFS NameNode, S3 Endpoint）？
    - [ ] 相关的配置文件（如 `core-site.xml`, `hdfs-site.xml`）是否已放置在新节点？
    - [ ] 检查新节点与外部服务之间的网络防火墙或安全组策略。
- [ ] **Broker:** 如果使用了 Broker Load：
    - [ ] 是否已在新 BE 节点上部署了 Broker，或者新节点能正常访问现有的 Broker？

### 2.3 资源与容量检查

- [ ] **纵向扩容 (Vertical Scaling):**
    - [ ] **JVM 内存 (FE):** 升级 FE 内存后，**必须**同步调大 `fe.conf` 中的 JVM 堆内存设置 (`JAVA_OPTS` 里的 `-Xmx` 参数)，否则新加的内存无法被利用。
    - [ ] **BE 内存:** 升级 BE 内存后，建议相应调整 `be.conf` 中的 `mem_limit`，为 StarRocks 进程分配更多内存。
- [ ] **横向缩容 (Decommissioning):**
    - [ ] 缩容 BE 前，务必通过 `SHOW BACKENDS;` 确认剩余节点的磁盘总容量和可用空间，是否足够容纳被迁移的数据。
    - [ ] 缩容 FE Follower 前，确认剩余 Follower 节点数仍为奇数且满足多数派（> N/2）要求，以保证选举正常。

### 2.4 监控与接入层检查

- [ ] **监控系统:**
    - [ ] 新节点的 IP 是否已添加到 Prometheus 的 `scrape_configs` 中？
    - [ ] 新节点是否已加入到相关的 Grafana 监控大盘？
    - [ ] 新节点是否已纳入告警规则的覆盖范围？
- [ ] **接入层:**
    - [ ] **FE 扩容后**，如果前端使用了反向代理（Nginx/HAProxy/F5），新 FE 节点的 IP 和端口是否已添加到代理的后端服务器池中？

## 3. 横向扩容 (添加节点)

### 3.1 扩容 BE 节点

1.  **准备新节点:** 按照上述检查清单，完成新服务器的所有环境准备。
2.  **部署 BE 软件:** 将现有集群的 `be` 目录完整地拷贝到新节点，并修改 `be/conf/be.conf`。
3.  **将 BE 添加到集群:** 使用 MySQL 客户端连接到 FE，执行 `ALTER SYSTEM ADD BACKEND` 命令。
    ```sql
    ALTER SYSTEM ADD BACKEND "<new_be_ip>:<heartbeat_service_port>";
    ```
4.  **启动 BE 进程:** 在新节点上启动 BE 进程。
5.  **验证与监控:** 执行 `SHOW BACKENDS;`，新节点的 `Alive` 状态应为 `true`。StarRocks 会自动开始数据均衡。

### 3.2 扩容 FE 节点

1.  **准备新节点:** 按照检查清单准备新服务器，特别是 JDK 的安装。
2.  **部署 FE 软件:** 拷贝 `fe` 目录并修改 `fe/conf/fe.conf`。
3.  **将 FE 添加到集群:** 推荐添加 **Observer** 节点以扩展读能力。
    ```sql
    ALTER SYSTEM ADD OBSERVER "<new_fe_ip>:<edit_log_port>";
    ```
4.  **启动 FE 进程:** 使用 `--helper` 参数启动新 FE 进程以同步元数据。
    ```bash
    ./bin/start_fe.sh --helper <running_fe_ip>:<rpc_port> --daemon
    ```
5.  **验证:** 执行 `SHOW FRONTENDS;`，新节点的 `Alive` 和 `Join` 状态应为 `true`。

## 4. 纵向扩容 (升级资源)

1.  **通知业务方:** 纵向扩容需要停机，请提前沟通。
2.  **停止节点进程:** 安全停止需要升级的 FE 或 BE 进程。
3.  **升级硬件:** 增加物理内存或更换 CPU。
4.  **修改配置 (关键步骤):**
    *   **升级 FE 内存后:** 必须相应调大 `fe.conf` 中的 `-Xmx`。
    *   **升级 BE 内存后:** 建议相应调整 `be.conf` 中的 `mem_limit`。
5.  **启动节点进程并验证。**

## 5. 横向缩容 (下线节点)

下线节点是高危操作，必须谨慎执行。

### 5.1 缩容 BE 节点

下线 BE 节点会触发大规模的数据迁移。

1.  **执行 DECOMMISSION:**
    *   使用 `ALTER SYSTEM DECOMMISSION BACKEND` 命令。
        ```sql
        ALTER SYSTEM DECOMMISSION BACKEND "<be_ip>:<heartbeat_service_port>";
        ```
    > **DECOMMISSION** 是一个异步操作。命令执行成功只代表下线流程已启动。

2.  **监控迁移进度:**
    *   反复执行 `SHOW BACKENDS;`，观察下线中节点的 `TabletNum`。当 `TabletNum` 降为 0 时，表示数据已全部迁走。这个过程可能需要数小时到数天。

3.  **确认下线:**
    *   当 `TabletNum` 为 0 后，该 BE 节点会自动从集群元数据中移除。
    *   确认节点已从 `SHOW BACKENDS;` 消失后，可以安全地停止该 BE 进程并关停服务器。

### 5.2 缩容 FE 节点

1.  **执行 DROP:**
    *   使用 `ALTER SYSTEM DROP FOLLOWER` 或 `ALTER SYSTEM DROP OBSERVER` 命令。
        ```sql
        ALTER SYSTEM DROP OBSERVER "<fe_ip>:<edit_log_port>";
        ```
2.  **停止进程:**
    *   命令执行成功后，即可停止被下线 FE 节点的进程。