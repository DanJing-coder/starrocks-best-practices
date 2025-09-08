# 存算一体 (Shared-nothing)

## 架构说明

存算一体架构下，整个系统的核心只有 FE (Frontend)、BE (Backend) 两类进程，数据存储在 BE 节点磁盘上，不依赖任何外部组件，方便部署与维护。FE 和 BE 模块都可以在线水平扩展，元数据和业务数据都有副本机制，确保整个系统无单点。StarRocks 提供 MySQL 协议接口，支持标准 SQL 语法。用户可通过 MySQL 客户端方便地查询和分析 StarRocks 中的数据。


## 组件介绍

### FE (Frontend)

FE 是 StarRocks 的前端节点,负责管理元数据,管理客户端连接,进行查询规划,查询调度等工作。每个 FE 节点都会在内存保留一份完整的元数据,这样每个 FE 节点都能够提供无差别的服务。

FE 有三种角色: Leader FE, Follower FE 和 Observer FE。Follower 会通过 Paxos 的 Berkeley DB Java Edition (BDBJE) 协议自动选举出一个 Leader。三者区别如下:

*   **Leader**:
    *   从 Follower 中自动选出,进行选主需要集群中有半数以上的 Follower 节点存活。如果 Leader 节点失败,Follower 会发起新一轮选举。
    *   提供元数据读写服务。只有 Leader 节点会对元数据进行写操作,Follower 和 Observer 只有读取权限。Follower 和 Observer 将元数据写入请求路由到 Leader 节点,Leader 更新完数据后,会通过 BDB JE 同步给 Follower 和 Observer。必须有半数以上的 Follower 节点同步成功才算作元数据写入成功。
*   **Follower**:
    *   有元数据读取权限,无写入权限。通过回放 Leader 的元数据日志来异步同步数据。
    *   参与 Leader 选举,必须有半数以上的 Follower 节点存活才能进行选主。
*   **Observer**:
    *   主要用于扩展集群的查询并发能力,可选部署。
    *   不参与选主,不会增加集群的选主压力。
    *   通过回放 Leader 的元数据日志来异步同步数据。

**注意**: FE 节点之间的时钟相差不能超过 5s, 建议使用 NTP 协议校准时间。

### BE (Backend)

BE 是 StarRocks 的后端节点,负责数据存储、SQL 执行等工作。

*   **数据存储**: BE 节点都是完全对等的,FE 按照一定策略将数据分配到对应的 BE 节点。BE 负责将导入数据写成对应的格式存储下来,并生成相关索引。
*   **SQL 计算**: 一条 SQL 语句首先会按照具体的语义规划成逻辑执行单元,然后再按照数据的分布情况拆分成具体的物理执行单元。物理执行单元会在对应的数据存储节点上执行,这样可以实现本地计算,避免数据的传输与拷贝,从而能够得到极致的查询性能。


## 部署规划

### 架构建议

*   **FE**: Follower 节点要求为奇数个,不建议部署太多。通常 3 个 FE 即可满足绝大部分业务需求 (1 个 Leader, 2 个 Follower)。如果想扩展查询并发能力,可以增加 Observer 节点。
*   **BE**: 节点个数根据业务规划、读写性能要求等来确定。存算一体模式下最少需要 3 个 BE 节点以满足默认的三副本容灾需求。
*   **CN**: 在存算一体模式下为可选部署。

### 部署方式

*   **独立部署**: 机器资源充足的情况下,建议 FE 节点和 BE 节点独立部署。
*   **混合部署**: 若机器资源有限 (如只有三台机器),可选择 3FE + 3BE 混合部署。此时需注意 `be.conf` 中 `mem_limit` 参数的设置,为 FE JVM 预留足够内存。

**注意**:

*   集群中所有 FE 节点的 `http_port` 需要相同,所以同集群多个 FE 不能混部在一台机器上。
*   不建议在 StarRocks 集群的机器上再部署其他服务应用。

## 环境准备与部署

参考 [环境检查](./deploy_checklist.md)

### 部署社区版存算一体集群

#### 1. 获取部署文件

您可以通过 Docker 镜像或直接下载二进制包的方式获取部署文件。

**通过 Docker (推荐)**

```bash
# 1. 拉取镜像 (以 Ubuntu 镜像为例)
# 将 <image_tag> 替换为您要下载的镜像的 Tag,例如 3.1.0
docker pull starrocks/artifacts-ubuntu:<image_tag>

# 2. 从镜像中拷贝出部署文件
docker run --rm starrocks/artifacts-ubuntu:<image_tag> \
tar -cf - -C /release . | tar -xvf -
```

**直接下载**

从 [StarRocks 官网](https://www.starrocks.io/zh-CN/download/community) 下载社区版二进制包。

#### 2. 部署 FE 节点

1.  **分发部署文件**: 将 `fe` 目录分发至所有要部署 FE 的机器上。
2.  **创建元数据目录**:
    ```bash
    mkdir -p /path/to/meta
    ```
3.  **修改配置**: 编辑 `conf/fe.conf` 文件。
    *   `meta_dir`: 修改为实际的元数据目录路径。
    *   `priority_networks`: 如果机器有多个 IP,需要设置此参数以保证节点间通信正常。
    *   `JAVA_OPTS`: 根据机器内存调整 JVM 参数。
4.  **启动第一个 FE 节点**:
    ```bash
    ./bin/start_fe.sh --daemon
    ```
5.  **验证 FE 启动**:
    *   查看日志 `log/fe.log`。
    *   执行 `jps` 查看 `StarRocksFe` 进程。
    *   通过浏览器访问 `http://<fe_ip>:8030` (默认端口)。
6.  **添加其他 FE 节点 (高可用)**:
    *   使用 MySQL 客户端连接到已启动的 FE 节点: `mysql -h <fe_ip> -P 9030 -u root`
    *   添加 Follower 或 Observer 节点:
        ```sql
        ALTER SYSTEM ADD FOLLOWER "<follower_ip>:<edit_log_port>";
        ALTER SYSTEM ADD OBSERVER "<observer_ip>:<edit_log_port>";
        ```
    *   在新节点上重复步骤 1-3,然后使用 `--helper` 参数启动新节点以同步元数据:
        ```bash
        ./bin/start_fe.sh --helper <running_fe_ip>:<rpc_port> --daemon
        ```

#### 3. 部署 BE 节点

1.  **分发部署文件**: 将 `be` 目录分发至所有要部署 BE 的机器上。
2.  **创建数据目录**:
    ```bash
    mkdir -p /path/to/storage
    ```
3.  **修改配置**: 编辑 `conf/be.conf` 文件。
    *   `storage_root_path`: 修改为实际的数据目录路径。
    *   `priority_networks`: 如果机器有多个 IP,需要设置此参数。
4.  **添加 BE 节点到集群**:
    *   使用 MySQL 客户端连接到 FE:
        ```sql
        ALTER SYSTEM ADD BACKEND "<be_ip>:<heartbeat_service_port>";
        ```
5.  **启动 BE 节点**:
    ```bash
    ./bin/start_be.sh --daemon
    ```
6.  **验证 BE 启动**:
    *   通过 MySQL 客户端查看 BE 状态: `SHOW PROC '/backends' G`
    *   在机器上执行 `ps -ef | grep starrocks_be` 查看进程。

#### 4. 部署 Broker (可选)

Broker 用于访问外部数据源 (如 HDFS)。

1.  **分发部署文件**: 将 `apache_hdfs_broker` 目录分发至要部署的机器。
2.  **启动 Broker**:
    ```bash
    ./apache_hdfs_broker/bin/start_broker.sh --daemon
    ```
3.  **添加 Broker 到集群**:
    *   使用 MySQL 客户端连接到 FE:
        ```sql
        ALTER SYSTEM ADD BROKER <broker_name> "<broker_ip>:<broker_port>";
        ```