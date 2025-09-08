# 存算分离 (Shared-data)

## 架构说明

自 3.0 版本起，StarRocks 支持存算分离架构。在存算分离的模式下，StarRocks 将数据存储在兼容 S3 协议的对象存储（例如 AWS S3、OSS 以及 MinIO）或 HDFS 中，而本地盘作为热数据缓存，用以加速查询。通过存储计算分离架构，您可以降低存储成本并且优化资源隔离。除此之外，集群的弹性扩展能力也得以加强。在查询命中缓存的情况下，存算分离集群的查询性能与存算一体集群性能一致。


## 部署概述

存算分离集群的部署方式与存算一体类似，主要区别在于：

*   **计算节点**: 存算分离集群需要部署 **CN (Compute Node)** 节点而非 BE 节点。CN 节点是无状态的，负责计算，不存储数据。
*   **存储配置**: 部署时需要配置远端存储信息，如对象存储的 Bucket、Endpoint、Access Key/Secret Key 等。

StarRocks 官方文档提供了详细的存算分离部署指南，请参考：
[**StarRocks 存算分离部署文档**](https://docs.starrocks.io/docs/deployment/shared_data/)

## 使用 Mirrorship Manager 部署 (企业版)

PDF 文档中详细描述了使用企业版工具 **Mirrorship Manager** 来部署存算分离集群的图形化界面操作。以下是该过程的高度概括：

1.  **安装 Mirrorship Manager**:
    *   下载并解压 `Mirrorship-EE-x.x.x.tar.gz`。
    *   执行 `install.sh` 脚本来生成并启动 Web 服务。

2.  **访问 Web 界面并初始化配置**:
    *   通过浏览器访问 Mirrorship Manager 的端口 (默认为 `19321`)。
    *   **配置 MySQL**: 首次访问需要配置一个 MySQL 数据库，用于存储 Mirrorship Manager 的元数据。
    *   **选择节点**: 批量填入所有需要部署 StarRocks 服务的机器 IP 地址。

3.  **选择集群类型**:
    *   在 "安装或迁移" 步骤中，选择 "安装新的集群"。
    *   在 "集群类型" 中，选择 "**存算分离**"。

4.  **配置并安装 FE 节点**:
    *   配置 FE 的元数据目录 (`meta_dir`) 和日志目录。
    *   **配置远端存储**: 这是存算分离部署的关键步骤。根据您使用的云厂商或存储类型，选择对应的存储介质类型 (如 AWS S3, OSS, HDFS, MinIO 等)，并填写详细的连接信息，包括：
        *   存储空间路径 (Bucket / Path)
        *   地域 (Region)
        *   连接地址 (Endpoint)
        *   访问密钥 (Access Key / Secret Key)

5.  **配置并安装 CN 节点**:
    *   点击 `+` 添加一个或多个 CN 节点。
    *   配置每个 CN 节点的安装目录、日志目录和数据缓存目录 (`storage_path`)。

6.  **配置并安装 Broker**:
    *   建议在所有计算节点上都安装 Broker，用于访问外部数据源。

7.  **配置并安装 Center Service**:
    *   Center Service 是 Mirrorship Manager 的一部分，负责监控报警等服务。按需配置邮件服务等。

8.  **完成部署并激活 License**:
    *   完成所有配置后，开始一键部署。
    *   部署完成后，页面会提供临时的 `root` 用户密码。
    *   首次登录后，需要上传有效的 License 文件来激活集群。

**注意**: 以上是根据 PDF 内容对企业版图形化部署流程的摘要。具体的界面截图和每一个配置项的详细说明，请参考 `StarRocks 最佳实践之集群部署.pdf` 的第 38 页到第 49 页。对于社区版用户，请务必参考上文提供的官方文档链接进行手动部署。