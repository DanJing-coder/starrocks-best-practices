# 集群部署

在完成了周全的[集群规划](./cluster-planning.md)后，本章将指导您完成 StarRocks 集群的部署。我们将以在 Linux 服务器上手动部署一个标准的三 FE、三 BE 存算一体集群为例，详细介绍每个步骤和最佳实践。

## 1. 环境准备

一个干净、配置正确的操作系统环境是集群稳定运行的基础。在开始部署前，请务必参考 **部署前环境检查清单**，在所有节点上逐一完成环境检查和配置，确保万无一失。

完成环境检查后，即可开始以下部署步骤。

## 2. 部署步骤

假设我们有三台服务器，IP 分别为 `192.168.1.1`, `192.168.1.2`, `192.168.1.3`。我们将在每台服务器上都部署一个 FE 和一个 BE。

### 2.1 下载并解压

在所有节点上，下载 StarRocks 的二进制包并解压。

```bash
# 切换到 starrocks 用户
su - starrocks

# 下载 (请从官网获取最新版本的链接)
wget https://releases.starrocks.io/starrocks/StarRocks-3.2.3.tar.gz

# 解压
tar -zxvf StarRocks-3.2.3.tar.gz
cd StarRocks-3.2.3
```

### 2.2 部署 FE 集群

1.  **配置 FE (`fe/conf/fe.conf`)**

    在**所有三台** FE 节点上，修改 `fe/conf/fe.conf` 文件，确保以下配置正确：
    *   `meta_dir`: 元数据存储目录。**必须**配置，并确保目录存在且 `starrocks` 用户有读写权限。
    *   `priority_networks`: 设置节点 IP 地址。这是**必须**的配置，用于节点间通信。

    ```properties
    # 示例配置
    meta_dir = /data/starrocks/fe/meta
    priority_networks = 192.168.1.0/24 # 使用 CIDR 格式指定 IP
    ```

2.  **启动第一个 FE 节点 (Leader)**

    在 `192.168.1.1` 上执行启动脚本。第一次启动的 FE 将成为 Leader。
    ```bash
    ./fe/bin/start_fe.sh --daemon
    ```
    检查 `fe/log/fe.log`，看到 `transfer to MASTER` 字样表示启动成功。

3.  **添加其他 FE 节点 (Follower)**

    使用 MySQL 客户端连接到已启动的 Leader FE。
    ```bash
    mysql -h 192.168.1.1 -P 9030 -u root
    ```
    在 MySQL 命令行中，执行 `ALTER SYSTEM ADD FOLLOWER` 添加另外两个 FE 节点。
    ```sql
    ALTER SYSTEM ADD FOLLOWER "192.168.1.2:9020";
    ALTER SYSTEM ADD FOLLOWER "192.168.1.3:9020";
    ```

4.  **启动其他 FE 节点**

    分别在 `192.168.1.2` 和 `192.168.1.3` 上执行启动脚本。
    ```bash
    ./fe/bin/start_fe.sh --daemon
    ```

5.  **验证 FE 集群**

    再次连接到任一 FE，执行 `SHOW FRONTENDS;`。如果看到三个 FE 节点，且 `IsMaster` 为 `true` 的有一个，`Join` 和 `Alive` 均为 `true`，则 FE 集群部署成功。

### 2.3 部署 BE 集群

1.  **配置 BE (`be/conf/be.conf`)**

    在**所有三台** BE 节点上，修改 `be/conf/be.conf` 文件：
    *   `storage_root_path`: 数据存储目录。**必须**配置，可以配置多个目录，用分号 `;` 隔开。确保目录存在且 `starrocks` 用户有读写权限。
    *   `priority_networks`: 同 FE 配置，设置节点 IP。

    ```properties
    # 示例配置，假设有两块数据盘
    storage_root_path = /data1/starrocks/be;/data2/starrocks/be
    priority_networks = 192.168.1.0/24
    ```

2.  **启动所有 BE 节点**

    在三台服务器上分别执行启动脚本。
    ```bash
    ./be/bin/start_be.sh --daemon
    ```
    检查 `be/log/be.INFO` 日志，确保没有严重错误。

3.  **添加 BE 节点到集群**

    连接到任一 FE，执行 `ALTER SYSTEM ADD BACKEND` 添加三个 BE 节点。
    ```sql
    ALTER SYSTEM ADD BACKEND "192.168.1.1:9050";
    ALTER SYSTEM ADD BACKEND "192.168.1.2:9050";
    ALTER SYSTEM ADD BACKEND "192.168.1.3:9050";
    ```

4.  **验证 BE 集群**

    执行 `SHOW BACKENDS;`。如果看到三个 BE 节点，且 `Alive` 均为 `true`，则 BE 集群部署成功。

## 3. 部署后验证

至此，一个完整的 StarRocks 集群已经部署完毕。您可以通过 Web UI (`http://<fe_ip>:8030`) 查看集群状态，或通过 MySQL 客户端执行一个简单的 DDL 和 DML 来验证集群功能是否正常。

```sql
-- 创建数据库
CREATE DATABASE test_db;
USE test_db;

-- 创建表
CREATE TABLE test_table (
    id INT,
    name VARCHAR(100)
)
DUPLICATE KEY(id)
DISTRIBUTED BY HASH(id) BUCKETS 3;

-- 插入数据
INSERT INTO test_table VALUES (1, 'starrocks'), (2, 'is'), (3, 'awesome');

-- 查询数据
SELECT * FROM test_table;
```

如果以上步骤均能成功执行，恭喜您，您的 StarRocks 集群已准备就绪！

---

接下来，我们将进入发挥 StarRocks 性能的关键环节——数据建模。