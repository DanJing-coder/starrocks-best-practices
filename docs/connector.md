# 集群接入与数据导入

本章将详细介绍业务应用如何接入 StarRocks 集群进行查询，以及如何通过各种工具和 API 将数据高效地导入 StarRocks。

## 1. 应用查询接入

### 1.1 JDBC 连接

StarRocks 完全兼容 MySQL 协议，因此任何支持 MySQL 的客户端或应用程序都可以通过 JDBC 连接到 StarRocks。

*   **驱动:** 使用标准的 `mysql-connector-java` 驱动。
    ```xml
    <!-- Maven 依赖 -->
    <dependency>
        <groupId>mysql</groupId>
        <artifactId>mysql-connector-java</artifactId>
        <version>8.0.28</version> <!-- 建议使用 8.0.x 版本 -->
    </dependency>
    ```
*   **连接方式推荐**

    为了实现 FE 节点的高可用和负载均衡，避免单点故障，我们推荐以下两种连接方式：

    #### 方式一（首选）：使用反向代理
    通过在多个 FE 节点前架设一个四层负载均衡（如 Nginx, HAProxy, F5），为所有 FE 节点提供一个统一的虚拟 IP (VIP) 或域名。这是最推荐的生产环境实践，具体配置可参考下一节 FE 接入高可用。
    *   **优点:** 客户端配置最简单，与 FE 节点的增减完全解耦，运维方便。
    *   **连接串 (URL):** `jdbc:mysql://<proxy_host>:<proxy_port>/<database>`

    #### 方式二（备选）：使用 JDBC LoadBalance
    如果部署环境不方便架设反向代理，可以利用 MySQL JDBC 驱动自带的客户端负载均衡功能。
    *   **优点:** 无需额外部署代理组件，由驱动程序负责在多个 FE 节点间进行负载均衡。
    *   **连接串 (URL):** `jdbc:mysql:loadbalance://<fe_host1>:<port1>,<fe_host2>:<port2>/<database>`

*   **在连接串中设置 Session 变量**
    对于某些需要为整个连接池设置的会话变量（如 `query_timeout`），可以在 JDBC URL 中通过 `sessionVariables` 参数进行配置。
    *   **优点:** 无需在每次获取连接后都执行 `SET` 命令，简化了代码逻辑。
    *   **连接串 (URL) 示例:**
        `jdbc:mysql://<proxy_host>:<proxy_port>/<database>?sessionVariables=query_timeout=3600,pipeline_dop=4`

*   **最佳实践：使用连接池**
    在生产环境中，**必须**使用连接池（如 Druid, HikariCP）来管理 JDBC 连接，以避免频繁创建和销毁连接带来的开销，并有效控制并发连接数。

    **Druid 配置示例 (使用反向代理模式):**
    ```properties
    spring.datasource.url=jdbc:mysql://<proxy_host>:<proxy_port>/my_db?useUnicode=true&characterEncoding=UTF-8&sessionVariables=query_timeout=3600
    spring.datasource.username=root
    spring.datasource.password=
    spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver
    spring.datasource.type=com.alibaba.druid.pool.DruidDataSource
    # ... 其他 Druid 配置
    spring.datasource.druid.initial-size=5
    spring.datasource.druid.min-idle=5
    spring.datasource.druid.max-active=20
    spring.datasource.druid.max-wait=60000
    ```

### 1.2 FE 接入高可用

为了避免单点故障和简化客户端配置，生产环境强烈建议使用反向代理（如 Nginx, HAProxy, F5）为多个 FE 节点提供一个统一的虚拟 IP (VIP) 或域名。

**Nginx 配置示例:**

以下配置展示了如何使用 Nginx 同时为 FE 的 MySQL 端口 (9030) 和 HTTP 端口 (8030) 提供负载均衡。

```nginx
# /etc/nginx/nginx.conf

# TCP/Stream 负载均衡 (用于 JDBC/MySQL 客户端)
stream {
    upstream starrocks_fe_mysql {
        # 轮询策略
        # least_conn; # 或使用最少连接策略
        server 192.168.1.1:9030;
        server 192.168.1.2:9030;
        server 192.168.1.3:9030;
    }

    server {
        listen 9030; # 暴露给客户端的端口
        proxy_pass starrocks_fe_mysql;
        proxy_connect_timeout 10s;
    }
}

# HTTP 负载均衡 (用于 Stream Load, Web UI)
http {
    upstream starrocks_fe_http {
        server 192.168.1.1:8030;
        server 192.168.1.2:8030;
        server 192.168.1.3:8030;
    }

    server {
        listen 80; # 暴露给客户端的端口
        location / {
            proxy_pass http://starrocks_fe_http;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }
    }
}
```
客户端只需连接 Nginx 的地址和端口即可，实现了 FE 的高可用和负载均衡。

## 2. 数据导入 API

### 2.1 Stream Load API

Stream Load 是通过 HTTP 协议向 StarRocks 导入数据的同步方式。它适用于导入本地文件或数据流，数据量级在几 GB 以内。

**使用 `curl` 的示例:**

*   **导入 CSV 数据:**
    ```bash
    curl --location-trusted -u user:password \
        -H "label:csv_test_1" \
        -H "column_separator:," \
        -T my_data.csv \
        # 推荐使用反向代理地址（<proxy_host>）
        http://<proxy_host>:80/api/my_db/my_tbl/_stream_load
    ```
**关键 HTTP 头:**
*   `label`: 导入任务的唯一标识，建议每次导入都生成一个新的 label，用于防重和问题排查。
*   `format`: 数据格式，如 `csv` (默认) 或 `json`。
*   `column_separator`: CSV 数据的列分隔符。

### 2.2 Flink Connector

`flink-connector-starrocks` 是官方推荐的将 Flink 数据流实时写入 StarRocks 的方式，它提供了 Exactly-Once 的语义保证。

**Flink SQL DDL 示例:**

```sql
CREATE TABLE starrocks_sink (
    `user_id` INT,
    `event_time` TIMESTAMP,
    `event_type` VARCHAR,
    `revenue` DOUBLE
) WITH (
    'connector' = 'starrocks',
    -- 推荐使用反向代理地址（<proxy_host>）
    'jdbc-url' = 'jdbc:mysql://<proxy_host>:9030',
    'load-url' = '["<proxy_host>:80"]',
    'database-name' = 'my_db',
    'table-name' = 'my_tbl',
    'username' = 'user',
    'password' = 'password',
    'sink.label-prefix' = 'flink_job_1', -- 导入 Label 的前缀，确保唯一
    'sink.properties.format' = 'json',   -- 通过 Stream Load 导入时的数据格式
    'sink.properties.strip_outer_array' = 'true'
);

-- 将 Kafka 数据流写入 StarRocks
INSERT INTO starrocks_sink
SELECT
    user_id,
    event_time,
    event_type,
    revenue
FROM kafka_source_table;
```

## 3. Kubernetes 环境下的实践

在 Kubernetes (K8s) 环境中，当 StarRocks 通过 [StarRocks Operator](https://docs.starrocks.io/zh/docs/deployment/k8s/operator_manual/) 部署后，Operator 会自动为 FE 和 BE 创建对应的 Service 资源。利用 K8s 的服务发现机制，我们可以方便地从集群内部或外部访问 StarRocks。

假设 StarRocks 通过 StarRocks Operator 部署在 K8s 的 `starrocks-ns` 命名空间下，其 FE 服务名为 `starrocks-fe-svc`。

### 3.1 集群内部访问

对于同样部署在 K8s 集群内部的应用（如 Flink 作业、微服务等），可以直接通过 FE 的 `ClusterIP` Service DNS 地址进行访问。这是最推荐的内部通信方式。

*   **服务 DNS 格式:** `<service-name>.<namespace>.svc.cluster.local`
*   **示例地址:**
    *   **JDBC/MySQL:** `starrocks-fe-svc.starrocks-ns.svc.cluster.local:9030`
    *   **HTTP/Stream Load:** `starrocks-fe-svc.starrocks-ns.svc.cluster.local:8030`

#### 示例 1: Flink on K8s 接入 StarRocks

当 Flink 作业也部署在 K8s 中时，其 Connector 配置应使用完整的服务 DNS 地址。

**Flink Connector 配置:**
```properties
...
'jdbc-url' = 'jdbc:mysql://starrocks-fe-svc.starrocks-ns.svc.cluster.local:9030',
'load-url' = '["starrocks-fe-svc.starrocks-ns.svc.cluster.local:8030"]',
...
```

#### 示例 2: Pod 内应用使用 Stream Load

任何运行在 K8s Pod 中的应用程序，都可以通过 FE 服务的 DNS 地址发起 Stream Load 请求。

**Python 示例:**
```python
import requests

# K8s 内部服务 DNS
fe_host = "starrocks-fe-svc.starrocks-ns.svc.cluster.local"
fe_http_port = 8030
db = "my_db"
table = "my_tbl"

url = f"http://{fe_host}:{fe_http_port}/api/{db}/{table}/_stream_load"
# ... (其余部分与非 K8s 环境相同)
```

### 3.2 集群外部访问

如果需要将 StarRocks 服务暴露给 K8s 集群外部的应用（如本地的 DBeaver、BI 工具），最佳实践是为 FE Service 创建对外暴露的端点。

#### 方案一：使用 `LoadBalancer` Service (推荐)

这是最简单直接的方式，适用于公有云环境。可以修改 StarRocks Operator 创建的 FE Service，或单独创建一个 `LoadBalancer` 类型的 Service。

**为 MySQL 端口 (9030) 创建 LoadBalancer Service:**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: starrocks-fe-mysql-lb
  namespace: starrocks-ns
spec:
  type: LoadBalancer
  ports:
  - port: 9030
    targetPort: 9030
  selector:
    # 确保 selector 与 StarRocks Operator 创建的 FE Pod 标签一致
    app.kubernetes.io/name: starrocks-fe
```
部署后，云厂商会自动分配一个公网 IP，客户端通过此 IP 即可访问。

#### 方案二：使用 `Ingress` (HTTP) + `NodePort` (TCP)

在没有 `LoadBalancer` 的环境（如私有化部署），或需要通过域名访问时，可以使用此方案。

1.  **为 HTTP 端口 (8030) 创建 Ingress:**
    ```yaml
    apiVersion: networking.k8s.io/v1
    kind: Ingress
    metadata:
      name: starrocks-fe-ingress
      namespace: starrocks-ns
    spec:
      rules:
      - host: starrocks.example.com
        http:
          paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: starrocks-fe-svc
                port:
                  number: 8030
    ```
    外部应用即可通过 `http://starrocks.example.com` 访问 Stream Load 和 Web UI。

2.  **为 MySQL 端口 (9030) 创建 NodePort Service:**
    将 FE Service 类型改为 `NodePort`，或单独创建一个 `NodePort` Service。K8s 会在每个 Node 上暴露一个随机端口（如 30000-32767），外部客户端通过 ` <node_ip>:<node_port>` 访问。

> **注意:** `NodePort` 方案存在单点故障风险（如果连接的 Node 宕机），生产环境建议在 `NodePort` 前端再架设一套高可用的四层负载均衡（如 LVS, HAProxy）。