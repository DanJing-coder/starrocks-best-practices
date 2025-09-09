# 磁盘管理 (SOP)

磁盘是 StarRocks BE 节点存储数据的物理介质，其健康状况和容量直接影响集群的稳定性和性能。本章将提供标准的磁盘管理操作流程（SOP），包括为 BE 节点扩容磁盘和安全地下线磁盘。

## 1. 磁盘扩容 (Adding a Disk)

当 BE 节点的现有磁盘容量不足时，可以通过添加新磁盘的方式进行在线扩容。StarRocks 会自动将数据均衡到新添加的磁盘上，整个过程对业务无感。

### 操作步骤

#### 步骤一：准备并挂载新磁盘

1.  将一块新的物理磁盘（推荐 SSD）挂载到 BE 节点服务器上。
2.  对其进行格式化（例如，使用 `xfs` 文件系统）。
3.  将其挂载到一个新的目录，例如 `/data2`。
    ```bash
    sudo mkfs.xfs /dev/sdb1
    sudo mkdir /data2
    sudo mount /dev/sdb1 /data2
    ```
4.  为了保证系统重启后挂载依然生效，需要将挂载信息写入 `/etc/fstab`。

#### 步骤二：创建数据目录并授权

在新的挂载点下，创建一个用于 StarRocks 存储的子目录，并确保 `starrocks` 用户拥有读写权限。

```bash
sudo mkdir -p /data2/starrocks/be
sudo chown -R starrocks:starrocks /data2/starrocks
```

#### 步骤三：修改 BE 配置

1.  编辑该 BE 节点的配置文件 `be/conf/be.conf`。
2.  找到 `storage_root_path` 配置项。
3.  将新的数据目录路径追加到末尾，用分号 `;` 分隔。**注意路径末尾不要带斜杠 `/`**。

    ```properties
    # be.conf
    # 原有配置
    storage_root_path = /data1/starrocks/be
    
    # 修改后的配置
    storage_root_path = /data1/starrocks/be;/data2/starrocks/be
    ```

#### 步骤四：重启 BE 进程

重启该 BE 节点使配置生效。

```bash
# 在 be 目录下
./bin/stop_be.sh
./bin/start_be.sh --daemon
```

### 验证

1.  **查看 BE 状态:**
    通过 MySQL 客户端连接到 FE，执行 `SHOW BACKENDS;`。观察该 BE 节点的 `TotalCapacity` 和 `AvailCapacity` 是否已经包含了新磁盘的容量。
    更详细地，可以通过 `SHOW PROC '/backends/<backend_id>'` 查看该 BE 节点的磁盘列表，确认新路径已加入且其 `State` 字段为 `ONLINE`。
2.  **监控数据均衡:**
    StarRocks 的后台均衡线程会自动开始将部分数据从旧磁盘迁移到新磁盘。您可以通过以下方式观察：
    *   通过 `SHOW PROC '/backends/<backend_id>'` 查看该 BE 节点扩容的磁盘路径的容量和 Tablet 数目变化。
    *   在 Grafana 监控大盘上，观察该 BE 节点下不同磁盘路径的使用率变化。
    *   登录到 BE 服务器，使用 `df -h` 或 `du -sh` 命令定期查看新旧数据目录的大小变化。

## 2. 磁盘下线 (Decommissioning a Disk)

当某块磁盘出现故障或需要更换时，可以将其安全下线。下线过程会将该磁盘上的所有数据自动迁移到同一 BE 节点下的其他健康磁盘上。StarRocks 提供了两种下线方式，社区版通过修改配置文件并重启 BE 来实现，企业版支持在线下线，无需重启。

### 2.1 社区版下线方式 (修改配置并重启)

此方式通过修改 `be.conf` 文件并重启 BE 进程来触发数据迁移。

#### 操作步骤

假设我们要下线 `/data2/starrocks/be` 这个路径。

##### 步骤一：修改 BE 配置

1.  编辑该 BE 节点的配置文件 `be/conf/be.conf`。
2.  在 `storage_root_path` 配置项中，**删除**需要下线的路径。

    ```properties
    # be.conf
    # 原有配置
    storage_root_path = /data1/starrocks/be;/data2/starrocks/be
    
    # 修改后的配置
    storage_root_path = /data1/starrocks/be
    ```
    > 警告:** 去除该路径后，上面的数据都会丢失，如果存在单副本表，禁止该操作，建议通过下线 be 方式下线该磁盘。

##### 步骤二：重启 BE 进程

重启该 BE 节点以触发数据迁移。

```bash
# 在 be 目录下
./bin/stop_be.sh
./bin/start_be.sh --daemon
```

#### 步骤三：监控迁移进度

BE 重启后，会立即开始将 `/data2/starrocks/be` 目录下的 Tablet 在其他节点通过其他副本 Clone 恢复。

*   **查看日志:** 观察 `be/log/be.INFO` 日志，可以搜索 `drop path` 相关的日志来跟踪进度。
*   **查看进度:** 定期使用 `SHOW PROC '/statistic` 命令检查对应 db 下面的 UnhealthyTabletNum，直到 0 表示 Clone 完成。
*   迁移速度取决于磁盘 I/O 性能和数据量，可能需要数小时甚至更长时间。

#### 步骤四：清理配置和磁盘

**确认迁移完成:** 当待下线目录的数据基本迁移完毕后，可以停止 BE 进程。

### 2.2 企业版下线方式 (在线)

企业版支持使用 SQL 命令在线下线指定 BE 节点的磁盘，整个过程无需重启 BE 节点，对业务无感。执行该语句后，StarRocks 会将该磁盘上的数据副本异步地迁移到当前 BE 节点的其他可用磁盘上。

#### 操作步骤

1.  **执行下线命令:**
    使用 MySQL 客户端连接到 FE，对需要下线的磁盘执行 `ALTER SYSTEM DECOMMISSION DISK` 命令。

    ```sql
    -- 语法
    ALTER SYSTEM DECOMMISSION DISK "<disk_path>" [,...] ON BACKEND "<be_host>:<heartbeat_service_port>";

    -- 示例：下线单个磁盘
    ALTER SYSTEM DECOMMISSION DISK "/disk1" ON BACKEND "xxx.xx.xx.xxx:9050";

    -- 示例：同时下线多个磁盘
    ALTER SYSTEM DECOMMISSION DISK "/data2/starrocks/be", "/data3/starrocks/be" ON BACKEND "192.168.1.10:9050";
    ```
    > **注意:** 该命令是一个异步操作。执行成功仅代表下线任务已提交。

2.  **监控迁移进度:**
    您可以通过 `SHOW PROC` 命令查看数据迁移的进度。

    ```sql
    -- be_id 是下线磁盘所在 BE 节点的 ID
    SHOW PROC '/backends/<be_id>';
    ```
    在返回结果的磁盘列表中，找到正在下线的磁盘路径：
    *   `State` 字段会变为 `DECOMMISSIONING`。
    *   观察 `TabletNum` 字段。当该字段的值降为 `0` 时，表示数据已全部迁移完成。
    *   您也可以登录到 BE 服务器，定期使用 `du -sh <disk_path>` 命令检查待下线目录的大小，它会逐渐减小。

3.  **取消下线 (可选):**
    如果在迁移过程中需要中止下线操作，可以使用 `ALTER SYSTEM CANCEL DECOMMISSION DISK` 命令。该命令会停止数据迁移，并将磁盘状态恢复为 `ONLINE`。

    ```sql
    -- 语法
    ALTER SYSTEM CANCEL DECOMMISSION DISK "<disk_path>" [,...] ON BACKEND "<be_host>:<heartbeat_service_port>";

    -- 示例：取消单个磁盘的下线
    ALTER SYSTEM CANCEL DECOMMISSION DISK "/disk1" ON BACKEND "xxx.xx.xx.xxx:9050";
    ```

4.  **完成操作与物理移除:**
    当确认 `TabletNum` 已为 0 后，表示数据已全部迁移完成。此时，可以安全地禁用、卸载并从服务器上移除旧磁盘。

    ```properties
    # 删除需要下线的磁盘路径，在低峰期重启be完全去掉该磁盘
    # be.conf
    # 原有配置
    storage_root_path = /data1/starrocks/be;/data2/starrocks/be
    
    # 修改后的配置
    storage_root_path = /data1/starrocks/be
    ```

### 2.3 企业版禁用磁盘 (应对物理故障)

当某块磁盘物理损坏，数据已无法读取时，可以使用 `DISABLE DISK` 命令将其强制禁用。此操作会将该磁盘上的所有 Tablet 标记为坏副本，并触发系统在其他健康的 BE 节点上进行副本克隆来恢复数据。

> **警告:** 此为高危操作，仅适用于磁盘已确认永久性损坏的场景。它与 `DECOMMISSION` 的区别在于，`DECOMMISSION` 是在磁盘健康的情况下，将数据平滑迁移到**同一 BE 节点**的其他磁盘；而 `DISABLE` 是将数据副本在**不同 BE 节点**之间进行恢复。

#### 操作步骤

##### 步骤一：调整错误磁盘容忍度

在禁用磁盘之前，您需要将该 BE 节点的动态参数 `max_percentage_of_error_disk` 设置为 `100`，以允许系统在有坏盘的情况下继续服务。

```bash
update information_schema.be_configs set value = 100 where name = 'max_percentage_of_error_disk' and BE_ID=<be_id>;
```

##### 步骤二：执行禁用磁盘命令

使用 `ALTER SYSTEM DISABLE DISK` 命令来禁用一个或多个磁盘。

```sql
-- 语法
ALTER SYSTEM DISABLE DISK "<disk_path>" [,...] ON BACKEND "<be_host>:<heartbeat_service_port>";

-- 示例
ALTER SYSTEM DISABLE DISK "/data/starrocks/be/storage_data_2" ON BACKEND "192.168.1.10:9050";
```
*   `disk_path`: 待禁用磁盘的路径。单个路径需要用双引号包裹，多个路径用逗号分隔。
*   `be_host`: 待禁用磁盘所在 BE 节点的 IP 地址或 FQDN。
*   `heartbeat_service_port`: 待禁用磁盘所在 BE 节点的心跳服务端口。

##### 步骤三：监控副本恢复

禁用磁盘后，该磁盘上的数据副本将变为不可用。StarRocks 会通过在其他可用的 BE 节点上执行全量 Clone 操作来修复丢失的副本。
*   您可以通过 `SHOW PROC '/statistic';` 查看 `unhealthy_tablets_num` 的变化，当其降为 0 时表示恢复完成。
*   这个过程会消耗较多的网络和 I/O 资源，请耐心等待。

##### 步骤四：物理替换与重新上线

1.  **替换磁盘:** 当副本恢复完成后，您可以安全地关闭 BE 节点，物理替换损坏的磁盘。
2.  **修改配置:** 在重新启动 BE 之前，编辑 `be/conf/be.conf` 文件，从 `storage_root_path` 配置项中**移除旧的坏盘路径**。如果新磁盘挂载到了新的路径，请将新路径添加进去。
3.  **重启 BE:** 启动 BE 进程，使其以新的磁盘配置加入集群。

## 3. 最佳实践

*   **逐个操作:** 对多块磁盘进行操作时，建议一块一块地进行，完成一块的扩容或下线并验证成功后，再进行下一块。
*   **预留空间:** 在执行磁盘下线前，请确保同一 BE 节点下的其他磁盘有足够的剩余空间来容纳待迁移的数据。
*   **业务低峰期操作:** 磁盘下线会触发大量数据迁移，消耗较多 I/O 资源。建议在业务低峰期进行此操作。
*   **监控告警:** 务必配置磁盘使用率告警，当使用率超过阈值（如 80%）时及时进行扩容。