# 部署前环境检查清单

在正式部署 StarRocks 之前，一个干净、配置正确的操作系统环境是集群稳定运行的基础。请在所有计划部署 FE 和 BE 节点的服务器上，逐一完成以下环境检查和配置，确保万无一失。

## 1. 硬件与网络

- [ ] **硬件符合规划:** 确认所有节点的硬件配置（CPU、内存、磁盘）符合[集群规划](./cluster-planning.md)章节的要求。
- [ ] **[CPU 指令集支持](https://docs.starrocks.io/zh/docs/deployment/install_manually/#检查软硬件环境):** 确认 CPU 支持 **AVX2 和 sse4_2** 指令集。这是保证 StarRocks 向量化引擎发挥极致性能的前提。
    ```bash
    # 检查 AVX2
    cat /proc/cpuinfo | grep avx2
    # 检查 sse4_2
    cat /proc/cpuinfo | grep sse4_2
    ```
    > **验证:** 如果以上两条命令均有输出，则表示 CPU 支持。

- [ ] **网络连通性:** 确保所有 FE 和 BE 节点之间网络互通，没有防火墙阻挡。建议所有节点位于同一个万兆交换网段下。
- [ ] **[端口可用性](https://docs.starrocks.io/zh/docs/deployment/install_manually/#端口):** 确保 StarRocks 所需的默认端口未被占用，或已在防火墙中放行。
    *   **FE 默认端口:** `8030` (http), `9020` (rpc), `9030` (mysql)
    *   **BE 默认端口:** `8040` (http), `9050` (heartbeat), `9060` (brpc)
    ```bash
    # 检查端口是否被占用 (以 8030 为例)
    netstat -ntlp | grep 8030
    ```
- [ ] **防火墙策略检查:** 如果开启了防火墙，请确保集群所需端口已开放。
    ```bash
    # CentOS / RHEL
    sudo systemctl status firewalld
    # Ubuntu / Debian
    sudo ufw status
    ```

## 2. 操作系统配置

**推荐系统:** CentOS 7+ 或 Ubuntu 16.04+

- [ ] **专用用户已创建:** 创建一个专用的 `starrocks` 用户来运行 StarRocks 进程，避免使用 root 用户。
    ```bash
    sudo groupadd starrocks
    sudo useradd -g starrocks starrocks
    ```
- [ ] **SELinux 已关闭或设为 Permissive:** `enforcing` 模式可能会导致部署失败或性能问题。
    ```bash
    # 检查 SELinux 状态
    sestatus
    ```
    > **验证:** `SELinux status` 应为 `permissive` 或 `disabled`。如果为 `enforcing`，请修改 `/etc/selinux/config` 文件并**重启服务器**。

- [ ] **交换分区 (Swap) 已关闭:** Swap 会严重影响数据库性能，必须关闭。
    ```bash
    # 检查 Swap 状态
    free -m
    ```
    > **验证:** `Swap` 行的总量应为 0。如果不是，请执行以下操作：
    ```bash
    # 临时关闭
    sudo swapoff -a
    # 永久关闭 (注释掉 /etc/fstab 文件中所有 swap 相关的行)
    sudo sed -i '/swap/s/^/#/' /etc/fstab
    ```

- [ ] **文件句柄数已调高:** StarRocks 需要大量的并发连接和文件句柄。
    ```bash
    # 检查当前用户的限制
    ulimit -n
    ```
    > **验证:** 输出值应为 `65535` 或更高。如果不是，请执行以下操作：
    ```bash
    # 在 /etc/security/limits.conf 文件末尾添加
    echo "* soft nofile 65535" | sudo tee -a /etc/security/limits.conf
    echo "* hard nofile 65535" | sudo tee -a /etc/security/limits.conf
    ```
    > **注意:** 修改后需要重新登录用户才能生效。

- [ ] **透明大页 (THP) 已关闭:** THP 会导致内存管理开销，影响性能。
    ```bash
    # 检查 THP 状态
    cat /sys/kernel/mm/transparent_hugepage/enabled
    ```
    > **验证:** 输出应为 `[never]`。如果不是，请执行以下操作：
    ```bash
    # 临时关闭
    echo never | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
    # 永久关闭 (在 /etc/rc.local 中添加)
    echo 'if test -f /sys/kernel/mm/transparent_hugepage/enabled; then echo never > /sys/kernel/mm/transparent_hugepage/enabled; fi' | sudo tee -a /etc/rc.local
    sudo chmod +x /etc/rc.local
    ```

- [ ] **时间同步服务已启用:** 集群所有节点必须保持时间同步。
    ```bash
    # 检查服务状态 (以 chronyd 为例)
    sudo systemctl status chronyd
    # 或者检查 ntpd
    sudo systemctl status ntpd
    ```
    > **验证:** 服务应为 `active (running)` 状态。如果服务未运行，请安装并启动。

## 3. 软件依赖

- [ ] **[FE 节点 - JDK 已安装](https://docs.starrocks.io/zh/docs/deployment/install_manually/#安装-java-环境):** 推荐使用 **JDK 8 或 JDK 11**。
    ```bash
    # 检查 Java 版本
    java -version
    ```
    > **验证:** 确保 `java -version` 能正确输出版本信息。如果未安装，以 CentOS 为例：
    ```bash
    sudo yum install -y java-1.8.0-openjdk-devel
    ```

- [ ] **BE 节点 - 基础库已安装:** StarRocks BE 依赖一些基础库。
    ```bash
    # 以 CentOS 为例
    sudo yum install -y libaio numactl
    ```
- [ ] **MySQL 客户端已安装:** 用于连接和管理 StarRocks 集群。
    ```bash
    # 检查 mysql 命令
    which mysql
    ```
    > **验证:** 命令应能正确返回路径。如果未安装，以 CentOS 为例：
    ```bash
    sudo yum install -y mysql
    ```

---

## 4. 自动化环境检查脚本

为了简化环境检查过程，我们提供了一个自动化检查脚本，它可以快速扫描当前系统环境是否满足 StarRocks 的部署要求。该脚本参考了社区的最佳实践，其实现可参考 env_check.sh。

### 使用说明

1.  **下载脚本**
    ```bash
    wget https://raw.githubusercontent.com/DanJing-coder/database-tools/main/starrocks/scripts/env_check.sh
    ```
2.  **授予执行权限**
    ```bash
    chmod +x env_check.sh
    ```
3.  **运行脚本**
    ```bash
    sudo ./env_check.sh
    ```
4.  **检查结果**
    脚本会逐项检查系统配置，并输出 `[OK]` 或 `[FAIL]`。请确保所有检查项均为 `[OK]`，或根据 `[FAIL]` 的提示修复对应配置。