# ProxCenter — Proxmox VE 8.x / 9.x 管理面板

**简体中文 | [English](README.en.md)**

[![License](https://img.shields.io/github/license/yjscloud/ProxCenter?color=blue)](LICENSE) [![Release](https://img.shields.io/github/v/release/yjscloud/ProxCenter?sort=semver&color=success&label=release)](../../releases) [![CI](https://github.com/yjscloud/ProxCenter/actions/workflows/ci.yml/badge.svg)](https://github.com/yjscloud/ProxCenter/actions/workflows/ci.yml) [![Stars](https://img.shields.io/github/stars/yjscloud/ProxCenter?style=flat)](../../stargazers) ![Python](https://img.shields.io/badge/python-3.11%2B-3776ab) ![React](https://img.shields.io/badge/react-18-61dafb)

对接 Proxmox VE 8.x / 9.x 的自托管 Web 管理面板。虚拟机和 LXC 容器的全生命周期管理、
cloud-init 模板流水线、网络与防火墙、监控大盘、快照备份、浏览器里直接开 VNC 控制台，加上
多用户权限、操作审计，以及几项安全运维能力（SSH 防爆破、端口异常检测、基线加固）。

装成 systemd 服务，机器重启自己起来：

```bash
git clone https://github.com/yjscloud/ProxCenter.git
cd ProxCenter
sudo ./deploy.sh
```

最后一屏会打印面板地址和初始口令，口令只显示这一次。想跑容器看
[Docker 部署](#docker-部署)，两种方式都写在 [一、部署](#一部署) 里。

> 关键词：Proxmox VE 管理面板 · PVE 面板 · LXC 容器管理 · cloud-init 模板 ·
> 自托管虚拟化平台 · Proxmox alternative UI

技术栈：Python 3.11+ / FastAPI / httpx，React 18 + TypeScript + Vite，MySQL 8。

在线演示：<https://prox.yjscloud.com>

![控制台仪表盘](docs/screenshots/dashboard.png)

## 联系与反馈

<img src="docs/screenshots/wechat.png" alt="微信联系方式" width="240">

需要帮助、发现功能有问题、或者想提新需求，都欢迎扫码加微信找我。部分功能还没经过充分测试，
可能无法正常使用，遇到问题直接说。

## 目录

- [一、部署](#一部署)：[准备 Token](#准备-proxmox-api-token) · [授权](#授权) ·
  [裸机部署](#裸机部署推荐) · [Docker 部署](#docker-部署) · [上 HTTPS](#上-https) ·
  [服务管理](#服务管理)
- [二、功能](#二功能) · [三、配置项](#三配置项) · [四、项目结构](#四项目结构) ·
  [五、测试](#五测试) · [六、排查问题](#六排查问题) · [七、安全说明](#七安全说明) ·
  [八、规划](#八规划)

---

## 一、部署

### 准备 Proxmox API Token

面板用 API Token 跟 Proxmox 通信。在 PVE 上执行：

```bash
pveum user add panel@pve --comment "ProxCenter panel"
pveum user token add panel@pve panel --privsep 0
```

输出里的 `full-tokenid`（形如 `panel@pve!panel`）填面板的 Token ID，`value` 填 Token Secret。

### 授权

```bash
pveum acl modify / --user panel@pve --roles PVEVMAdmin,PVEDatastoreUser,PVESDNUser,PVEAuditor,PVEVMUser
```

要按最小权限给，就按需拆开：

| 功能 | 角色 |
|---|---|
| 只看监控 | `PVEAuditor` |
| 开关机、控制台 | `PVEVMUser` |
| 创建 / 删除 / 改配置 / 快照 | `PVEVMAdmin` |
| 备份、ISO 与模板存储 | `PVEDatastoreUser`（要写用 `PVEDatastoreAdmin`） |
| 网桥 / VLAN | `PVESDNUser` |

> 控制台要另填一个 PVE 账号密码。Proxmox 不允许 API Token 访问 `vncproxy`，只认用户密码
> 换来的 ticket。不填只是控制台用不了，其他功能都正常。

### 裸机部署（推荐）

装的是 systemd 服务，机器重启自己起来、进程挂了自动拉起，改完代码
`systemctl restart` 就生效。面板与数据库都直接跑在宿主机上，长期用这种最省心。

```bash
git clone https://github.com/yjscloud/ProxCenter.git
cd ProxCenter
sudo ./deploy.sh
```

一次装完 Python 依赖、前端产物、数据库和 systemd 服务，全程不提问：端口 `8080`、库名
`proxcenter_panel`、账号 `proxcenter`，`SECRET_KEY` 与管理员口令随机生成，最后一屏打印
面板地址和初始口令，口令只显示这一次。重复执行不会破坏已有配置。

要自己指定参数就直接传，仍然不提问：

```bash
sudo ./deploy.sh --port 9000 --mysql-root-password '<root 口令>' \
                 --db-name proxcenter_panel --db-user proxcenter --db-password '<库口令>'
```

常用参数：`--port` 换端口，`--service` 换 systemd 服务名，`--user` 换运行用户（默认
`root`），`--skip-frontend` 复用现有 `dist/`（机器上没 Node 时用），`--no-systemd` 只准备
环境不装服务（无需 root），`--reconfigure` 逐项确认，`--help` 看全部参数。

> `SECRET_KEY` 生成之后别再改，换了它库里已存的 PVE Token、SMTP 口令全都解不开。`.env`
> 已存在时，脚本只覆盖命令行上显式给出的键。

想前台跑着看日志（不装服务）：`npm run build && ./start-prod.sh`。`dist/` 存在时 FastAPI
会在 8080 上同时提供前端页面和 `/api`，前后端同源，VNC 控制台的 WebSocket 直接可用。

### Docker 部署

不想在宿主机上装 Python / Node / MySQL 就走容器，宿主机只要有 Docker：

```bash
curl -fsSLO https://raw.githubusercontent.com/yjscloud/ProxCenter/main/docker-compose.yml
docker compose up -d
```

打开 `http://你的服务器IP:8080`，账号 `admin`，口令 `ProxCenter@2026`。这个口令得改。

三个口令都在 `docker-compose.yml` 里，搜 `★ 改这里`。口令行长这样：

```yaml
ADMIN_PASSWORD: ${ADMIN_PASSWORD:-ProxCenter@2026}
```

`:-` 是 compose 的「取默认值」记号，`.env` 或环境变量给了就用那个、没给才用后面这段；
`-`、`$`、`{`、`}` 都只是语法，真正的口令是 `ProxCenter@2026` 那一段，改的时候只动它：

```yaml
ADMIN_PASSWORD: ${ADMIN_PASSWORD:-MyPassw0rd2026}
```

要改的是 `ADMIN_PASSWORD`（面板登录）、`DB_PASSWORD`（连数据库）、`MYSQL_ROOT_PASSWORD`
（MySQL 管理员）。也可以不碰这个文件，在同目录放个 `.env`，等号后直接写口令，优先级更高。

有两个坑先讲在前面：

- 口令只在第一次初始化时生效。`ADMIN_PASSWORD` 只在库里还没有管理员时用来建号，
  MySQL 也只在数据目录为空时读 `MYSQL_PASSWORD`。跑起来之后再改，要么
  `docker compose down -v` 重建（数据会没），要么进库 `ALTER USER`（命令在
  `docker-compose.yml` 末尾）。改登录口令请登录后在「个人中心 → 修改密码」改。
- `SECRET_KEY` 别动。它既是 JWT 签名密钥，也是库里密文（PVE Token、SMTP 口令）的
  加密根。写死在公开仓库等于把钥匙公示，所以容器首次启动随机生成一份存进 `panel_data`
  卷；已有数据后改掉它，那些密文就都解不开了。

镜像默认构建 amd64（Proxmox VE 本身只有 x86_64），从 GHCR 拉。换 Docker Hub：
`PROXCENTER_IMAGE=docker.io/yjscloud/proxcenter:latest docker compose up -d`。
升级：`docker compose pull && docker compose up -d`。

### 上 HTTPS

面板自己不提供 TLS。要暴露到公网，用 Nginx 或 Caddy 在 443 上终结，反代到 8080。WebSocket
必须一起代理，否则控制台连不上：

```nginx
server {
    listen 443 ssl http2;
    server_name panel.example.com;
    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;        # 控制台要用的两条
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;    # 让面板知道外面已是 https
        proxy_read_timeout 3600s;                      # 控制台是长连接
        proxy_buffering off;
    }
}
```

面板侧同时打开强制 HTTPS，否则直连 8080 还是明文：

```
FORCE_HTTPS=true
FORWARDED_ALLOW_IPS=127.0.0.1
```

`FORWARDED_ALLOW_IPS` 只填反代地址，别放宽。放宽之后谁都能伪造
`X-Forwarded-Proto: https` 绕过跳转。Docker 部署时把这两项写进 `.env` 或 compose。

### 服务管理

`./deploy.sh` 装的是 systemd 服务，机器重启会自己起来，进程挂了也会自动重启：

| 操作 | 命令 |
|---|---|
| 状态 / 启停 | `systemctl status\|start\|stop\|restart proxcenter` |
| 开机自启 | `systemctl enable proxcenter` |
| 跟随日志 | `journalctl -u proxcenter -f` |

改完代码，只动前端 `npm run build` 就够，动后端要 `systemctl restart proxcenter`。
确认服务起来了：`curl http://127.0.0.1:8080/api/health`。

> 用 Docker 部署的话这一节可以跳过，容器本身带 `restart: unless-stopped`。

---

## 二、功能

### 虚拟机

四步创建向导（VMID、系统、磁盘与网卡、cloud-init），支持空白新建、从模板克隆、从 cloud 镜像
导入。开关机（优雅关机带超时和强制停止兜底）、重启、挂起、恢复、删除；在线改 CPU / 内存 /
名称 / 标签 / 开机自启 / 保护模式，磁盘扩容、迁存储、跨节点迁移。列表可勾选多台批量执行，逐台
回报，第 3 台失败不影响其余，也能只重试失败的。重置客户机里的用户口令优先走 Guest Agent
（即时生效），没装 agent 或已关机就走 cloud-init 写 `cipassword` 并重新生成 config drive。

### 容器（LXC）

容器在 PVE 里是另一套 API 端点，面板里也是平行的一套页面。三步创建向导，模板来自节点上内容
类型含 `vztmpl` 的存储（一个都没有时会给出 `pveam download` 命令）。生命周期、快照（不含内存
状态）、克隆（只有全量，PVE 不支持容器的链接克隆）、迁移、控制台；rootfs 和挂载点扩容、新增
挂载点、迁存储；网卡增删，IP 直接写在网卡配置里，改完要重启。

重置容器内的 root 口令走「SSH → 受管主机」。容器没有 Guest Agent，PVE 也没有「在容器里执行
命令」的接口，只能借该宿主机的 SSH 凭据跑 `pct exec`。宿主没配凭据时弹窗会说明，并建议你进
容器控制台自己 `passwd`。

### 模板（cloud-init 流水线）

从 cloud 镜像一键建模板，后端按序执行、每步之间等任务完成：建空壳虚拟机 → `importdisk` 导入
镜像 → 定位卷 → 挂成 `scsi0` 并配置启动顺序 → 挂 cloud-init 驱动 → 按需扩容 → 转模板。任何
一步失败都会自动删掉临时虚拟机，不留半成品。建好之后可用「从模板部署」批量开机，克隆时自动
注入主机名、SSH 公钥和 IP。

> 镜像必须放在 dir / NFS / CIFS 类型的存储上（`importdisk` 要求文件级访问）。LVM、ZFS 这类
> 块存储不能当来源，但可以当导入后的目标。

### 网络与防火墙

节点级 Linux Bridge / Bond / VLAN 的增删改，改动先进「待应用」，点「应用配置」才生效。这样
和 Proxmox 本身一致，避免改错网桥直接把节点网络断掉。

防火墙封装的是 Proxmox 原生防火墙，不是另起一套规则引擎，所以在面板里配的规则和 PVE 界面、
`pve-firewall` 看到的是同一份数据。三个作用域（集群 / 节点 / 虚拟机容器，qemu 与 lxc 自动
识别），规则支持出入站、ACCEPT / DROP / REJECT、协议、端口、来源目标（IP、CIDR、`+集合名`）、
PVE 预置宏、限定网卡、日志级别与排序。安全组是集群级规则集合，挂一条引用规则即可用上、改组
即改所有引用方；IP 集合存可复用地址段；规则模板能一次刷到多台机器（覆盖或追加）并逐台回报，
机器网卡没开 `firewall=1` 时会明确提示规则不会生效。权限分 `firewall.view` /
`firewall.manage`（自己名下的虚拟机）/ `firewall.cluster`（集群级与安全组，默认仅管理员）三档。

### SSH 登录安全

读的是面板所在主机的 SSH 日志，集群里其他宿主机的日志读不到，页面会写明数据来自哪台。
日志来源按 `/var/log/secure` → `/var/log/auth.log` → `journalctl -u ssh -u sshd` 三级回退，
只统计真正的认证失败，按 sshd 的 PID 去重，健康检查和端口扫描的噪声不算进去。失败来源按 IP
聚合，可一键封禁、标记可信、加忽略名单；fail2ban 的 jail、封禁数、解封与手动封禁都在页面上，
自定义策略只写面板自己的 `jail.d/panel-<jail>.local`，不碰 `jail.local`。告警走监控已有的飞书
和邮件通道：某 IP 失败超阈值、陌生 IP 登录成功都会通知，攻击停了会发恢复通知。

在「受管主机」里填地址、用户、私钥或口令（用 `SECRET_KEY` 加密落库）后，可以在远端做同样的
事；首次连接要确认 SSH 指纹，之后指纹变了直接拒绝。权限分 `ssh.view`（默认人人可见）与
`ssh.manage`（封禁、改策略，默认仅管理员）。

### 安全基线与端口巡检

两者共用一个架构。检测对象既可以是本机（面板所在主机，直接读系统文件），也可以是受管主机
（复用 SSH 通道，在远端跑一条只读命令把数据取回来本地解析），本地与远端共用同一份判定逻辑，
结论口径一致。对应的权限是 `baseline.view` / `baseline.manage` 与 `ports.view` /
`ports.manage`，后两个默认仅管理员。

基线检查覆盖七类：SSH 配置、口令策略、防火墙、时间同步、账号安全（空口令、UID 0）、关键内核
参数。评分按严重级别加权（高危 3、中危 2、低危 1）给 A～D 等级，检测不到的项不计入分母，权限
不足不会被冤枉扣分。一键加固只写面板自己命名的文件，SSH 改完立刻 `sshd -t` 校验、sysctl 改完
复读 `/proc`，校验不过自动回滚。关闭 SSH 口令认证这类可能把人锁在门外的项不纳入一键加固，
必须逐项确认。

端口巡检用 `ss -tulpn`（老系统退回 `netstat`）列出协议、监听地址、归属进程和暴露范围；监听在
非回环地址的算「对外开放」，并结合同一次采集到的防火墙状态，没有活动防火墙时风险级别整体
上调。可疑进程走反弹 shell 启发式：`/dev/tcp` 重定向、`nc -e`、`socat exec:`、脚本里的 socket
与 dup2、`curl|sh` 等，再叠加上下文特征（shell 持有对外连接、可执行文件在 `/tmp`、可执行文件
已被删除、已知挖矿进程名）。策略里可以配「预期端口」和「进程白名单」正则压误报。

> 有件事得说清楚：端口巡检是启发式，不是杀毒引擎。每条命中都会列出命中了哪条规则，面板也不会
> 据此杀进程。「对外开放」只代表监听在非回环地址，能不能真被访问还看防火墙和上游网络，所以
> 报告里把防火墙状态一并给出，由人判断。集群里的 Proxmox 节点想体检或巡检，把它当一台受管主机
> 加进来就行，PVE API 没有「在节点本机执行 shell」的接口。

### 应急响应

- 可疑虚拟机一键隔离：先取证快照 → 再断网 → 再关机 → 顺手加 VM 保护。顺序是刻意的，
  反过来机器一关现场就没了。每步独立执行、单独回报，取证失败不会阻止断网但会标红。断网是逐张
  网卡置 `link_down=1`，在原始配置串上增删那一段，`bridge`、`tag`、`macaddr` 原样保留。
- 备份防删：把备份卷登记为受保护并尽量给 PVE 卷打上 `protected` 旗标，面板的删除接口会
  拒删受保护的备份。勒索软件就算拿到管理员会话也删不掉，必须先在界面上解除保护。另外定期把
  登记过的备份和 PVE 实际内容对一遍，不见了或元数据变了就告警。

> 边界：真正的不可变（WORM）只能由存储侧保证（PBS retention、S3 Object Lock、只读挂载），
> 只靠 PVE API 做不到。快照是崩溃一致性的磁盘副本，取不到内存镜像；`link_down` 只切断
> PVE 虚拟网卡，PCI 直通 / SR-IOV 网卡不受控制。PVE 不返回存储内容的校验和，所以备份指纹是
> `volid|size|ctime` 的哈希，能发现删除和替换，发现不了静默位翻转。

### AI 排查助手

把平台已有的巡检结果（安全基线 / 端口与进程 / 登录审计 / 告警 / 变更记录 / 历史指标）交给大
模型做归因，回答的是「先修哪一条」。它不是一次性摘要，而是一条可追问的会话：选一台受管主机 →
先读平台数据，必要时登录主机跑只读命令 → 边查边答 → 结论落成带 `source_ref` 的报告，每条都
指回原始检查项，能自己核对。

只读是默认档。工具是有限的参数化命令模板，没有「随便执行一条命令」的万能入口，参数有正则与
路径白名单，不用 sudo。勾选「授权 AI 在目标主机执行命令」之后，模型才能自行组合只读命令（如
`ps aux | grep nginx`），每一段的首个可执行文件都必须在只读白名单内，且禁止 `;` `&&` `||`、
重定向与命令替换，`/etc/shadow` 这类另有黑名单拦截。要改动系统的命令一律先展示、由你逐条批准
才执行，`rm -rf /`、`mkfs`、`dd`、关机重启这类即便批准也直接拦下。

远程终端与它共用一个画面：浏览器内的交互式 SSH 终端（xterm.js 按需加载），你自己敲的命令、AI
跑的命令与输出按发生顺序排在一起，不用另开窗口对照「AI 到底在我机器上做了什么」。数据可见
范围跟着权限走（普通用户只看自己名下虚拟机的告警 / 备份 / 巡检结果，SSH 登录分析要
`ssh.view`），每次运行的模型、步数、token 与逐条工具调用都落在「排查记录」里，可回看、可导出
CSV（一行 = 一次工具调用）。另有 Token 消耗入口，按 1 / 7 / 30 天看用量总额、输入输出构成与
按模型明细。

需要 `ai.exec`（授权执行命令）与 `ai.terminal`（打开远程终端）两个权限，默认仅管理员。终端等于
把该主机的登录凭据交给使用者，助手的执行能力也比其它页面强得多。

> 有件事得说清楚：模型给的是归因建议，不是结论，每条都带 `source_ref` 指向原始检查项，请自行
> 核对。命令白名单与黑名单由后端代码实时生成，「能力说明」里看到的就是执行时校验的同一份规则。
> 授权只对当次会话有效，换主机或新建会话都会重置；写命令的审批有 120 秒超时，超时即视为拒绝。

### 审计、监控、备份与控制台

- 主机登录审计：`last` / `lastb` 解析出账号、终端、来源 IP、时间与状态，另有开机记录和
  auth.log 里的 sudo、su 提权。事件按每台主机一个游标增量汇入 `audit_log`，和面板自身的操作
  在同一张表里，后台每 5 分钟跑一次，重复汇入不会重复写。读不到 VM 内部的登录日志，但能按
  VM 的 IP 匹配各主机的登录记录，回答「这台 VM 有没有被用来登录宿主机」。
- 监控大盘：VM 总数与运行分布、CPU / 内存 / 存储环形图、节点一览、最近任务、资源占用
  Top 8；节点实时指标走 `/ws/metrics`（5 秒一推，断线自动重连并回落到 10 秒轮询）；磁盘容量
  按节点根分区历史线性外推，给日均增长率和预计写满天数；节点与虚拟机各有 RRD 曲线。
- 快照与备份：快照创建（可选含内存状态）、回滚、删除与跨虚拟机视图；立即备份（snapshot /
  suspend / stop 三种模式）、浏览备份卷、恢复到指定 VMID、删除；可视化创建 PVE 定时备份任务。
- 控制台：浏览器内 noVNC 图形控制台，支持自动重连、全屏、发送 Ctrl+Alt+Del，后端做
  WebSocket 双向透传，PVE 的 Web 界面不用暴露到公网。

### 用户、权限与配额

| 角色 | 能做什么 |
|---|---|
| `admin` | 全部权限，含用户管理、连接配置、删虚拟机、集群级防火墙 |
| `operator` | 创建 / 开关机 / 控制台 / 快照 / 备份 / 克隆 / 改配置，管自己名下机器的防火墙，看 SSH 统计；不能管用户、不能删虚拟机、不能改集群级防火墙 |
| `viewer` | 只读 |

- 自助注册 + 管理员审批：注册后账号是 `pending` 状态登不了，审批时一次把角色和权限分配好。
  邮箱必填，审批结果会发邮件（邮件是旁路，发不出去只记审计）。
- 所有写操作（含失败的）进审计日志，记用户、动作、目标、结果、详情、来源 IP，可按条件筛。
- 防呆：不能删、禁用或降级最后一个管理员，不能删当前登录账号。
- 配额是一个全局的虚拟机数量上限，不是按用户的。在「设置 → 虚拟机创建默认值 → 可下发
  虚拟机数量」填总数，已用 = 现有虚拟机总数（含模板）。填 0 = 普通用户完全不能建、管理员不受
  限，留空 = 不限。拦截覆盖 `POST /api/vms` 与 `POST /api/vms/{node}/{vmid}/clone` 两个入口，
  只拦前者的话反复克隆就能绕过。
- 设置里的连接配置可以在线改，存 MySQL，保存即生效不用重启，Token Secret 前端拿不到明文。
  「环境自检」会问 Proxmox 要当前凭据的有效权限，逐项列出 API 可达性、节点可见性、存储、
  虚拟机、控制台凭据是否正常，并把异常转成能直接执行的修复命令。

---

## 三、配置项

`backend/.env`（Docker 部署时用同名环境变量传进去，完整示例见 `backend/.env.example`）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SECRET_KEY` | 占位值 | 必填。签发登录 JWT，同时是库里密文的加密根，至少 32 位随机。留占位值或太短会拒绝启动 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / 空 | 首次启动创建的管理员。口令至少 12 位，空或弱口令会拒绝启动 |
| `FORCE_HTTPS` | `false` | 明文 HTTP 一律 308 跳 https，HTTPS 响应带 HSTS，仅本机回环豁免 |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | 信任哪些来源的 `X-Forwarded-Proto`，只填反代地址 |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCKOUT_MINUTES` | `5` / `15` | 登录失败几次就锁定，账号和来源 IP 双计数 |
| `ACCESS_TOKEN_EXPIRE_MINUTES` / `REFRESH_TOKEN_EXPIRE_DAYS` | `720` / `14` | 令牌有效期，后者等于一次登录最多能用多久 |
| `TOTP_REQUIRED_ROLES` | 空 | 强制开两步验证的角色，填 `admin` 表示管理员必须先绑定 TOTP |
| `RATE_LIMIT_ENABLED` / `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_AUTH_PER_MINUTE` | `true` / `300` / `30` | 限流开关、每 IP 每分钟的普通请求与敏感入口（登录 / 注册 / 找回密码 / 刷新 / 2FA）上限 |
| `STEP_UP_REQUIRED` / `STEP_UP_WINDOW_MINUTES` | `true` / `5` | 危险操作是否要二次确认，以及确认的有效窗口 |
| `PVE_HOST` / `PVE_PORT` | 空 / `8006` | Proxmox 地址（不带协议）与 API 端口 |
| `PVE_TOKEN_ID` / `PVE_TOKEN_SECRET` | 空 | 形如 `panel@pve!panel` 与 Token 的 UUID |
| `PVE_VERIFY_SSL` | `true` | 出站是否校验 PVE 证书。关掉等于把 Token 暴露给中间人 |
| `PVE_TRUST_ENV` | `false` | 是否让请求走环境变量里的 `HTTP_PROXY` / `HTTPS_PROXY` |
| `PVE_CONSOLE_USER` / `PVE_CONSOLE_PASSWORD` | 空 | 控制台用的 PVE 账号密码，留空则控制台不可用 |
| `CORS_ORIGINS` | `http://localhost:5173` | 允许的前端来源，逗号分隔 |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `127.0.0.1` / `3306` / 空 | MySQL 连接，库名必填 |
| `DB_POOL_SIZE` | `8` | 连接池上限 |

面板只支持 MySQL，建库后表结构启动时自动创建：

```sql
CREATE DATABASE proxcenter_panel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

`.env` 里的值只是初始默认值，启动后也能在「设置」页在线改，在线配置优先级更高。邮件（SMTP）
配置没有环境变量，只在「设置 → 邮件通知」里填，口令用 `SECRET_KEY` 加密落库，接口只回
`password_set`，明文不回传前端。

---

## 四、项目结构

```
proxcenter/
├── Dockerfile / docker-compose.yml / docker-entrypoint.sh   容器化与一键部署
├── deploy.sh                  裸机一键部署，幂等，可重复执行
├── start.sh / start-prod.sh   开发模式（含 Vite） / 生产模式（后端托管 dist/）
├── backend/
│   ├── run.py                 启动入口
│   ├── .env.example           配置示例
│   └── app/
│       ├── main.py            FastAPI 应用、路由挂载、异常处理
│       ├── pve.py             Proxmox API 客户端（token + ticket 双认证）
│       ├── vmconfig.py        虚拟机 / 容器配置的构建与解析
│       ├── bulk.py            批量操作编排
│       ├── security.py        JWT 会话、RBAC 权限模型、审计辅助
│       ├── store.py           MySQL：用户、审计日志、连接配置
│       └── routers/           每个页面对应一个模块：vms / lxc / templates / console /
│                              tasks / network / baseline / portguard / isolation /
│                              backups / users / audit / config
└── src/
    ├── api/                   axios 客户端、类型、接口封装
    ├── hooks/                 认证、toast、任务等待、WebSocket
    ├── components/ · pages/   布局、通用 UI 组件与页面
    ├── i18n/                  中英文文案
    └── styles/                深色主题设计系统
```

---

## 五、测试

```bash
cd backend
../.venv/bin/python -m pip install -r requirements-dev.txt
../.venv/bin/python -m pytest        # 约 1000 个用例
```

三层测试，都不需要真实 Proxmox 环境：纯逻辑（配置拼装、权限矩阵、字段别名、批量操作的部分
失败与归属校验）；模拟 Proxmox（起一个假 HTTP 服务器，验证认证头、响应解包、任务轮询、错误到
状态码的映射）；接口全链路（TestClient 打通请求到响应，覆盖 RBAC、审计、防火墙三档权限、
SSH 日志解析与告警、远程主机、基线判定、端口启发式、口令重置各通道）。

> API 用例会连一个独立的 `<DB_NAME>_test` 库，连不上 MySQL 或没有建库权限时自动跳过，
> 不会碰业务库。

前端：

```bash
npm run typecheck     # tsc --noEmit
npm run build         # tsc -b && vite build
npm run verify        # 以上三步一次跑完，另含 i18n 一致性检查
```

没有 Nginx 也想验收构建产物，可以起内置的静态服务器（带 `/api` 和 WebSocket 反向代理）：
`npm run build && npm run serve:dist`（<http://localhost:8090>）。

对接的是 PVE 的 REST API，8.x 和 9.x 走同一套代码，没有按版本分支的功能。已在 PVE 8.4 和 9
上实测通过虚拟机、容器的创建、启停和控制台。版本号只用于展示，不需要跟着 PVE 升级改代码。

---

## 六、排查问题

**面板能登录，但虚拟机、存储列表全是空的。**
先点「设置 → 环境自检」。这是 Proxmox API Token 最容易踩的坑：在 Web 界面创建 Token 时默认
勾选「特权分离」，这样的 Token 一开始没有任何权限。需要特权的读取返回 403，而 `/storage`
这类接口干脆返回 200 加空数组，看起来就像面板坏了。自检会向 PVE 要该凭据的有效权限，并列出
该执行哪条命令补上：

```bash
pveum acl modify / --tokens 'root@pam!panel' --roles PVEVMAdmin
pveum acl modify / --tokens 'root@pam!panel' --roles PVEDatastoreUser
pveum acl modify / --tokens 'root@pam!panel' --roles PVEAuditor   # 节点指标需要 Sys.Audit
```

判断特征：`pveum token list` 里 `privsep` 为 1，且 `/access/permissions` 返回空。

**连接报 502，但 ping 得通 Proxmox。** 检查跑面板的机器有没有设 `HTTP_PROXY` /
`HTTPS_PROXY`，面板默认不继承这些变量。确实要经过代理才把 `PVE_TRUST_ENV` 设为 `true`，
否则把 Proxmox 地址加进 `NO_PROXY`。

**配置是对的，但连不上集群。** 连接配置的优先级是「数据库 > `.env`」，之前用别的地址保存过
的话 `.env` 里的新值不生效。去「设置」页改，或删掉 `settings` 表里的 `pve_connection` 记录再
重启。Proxmox 不可达不会阻止面板启动，只在日志里留一条警告，这样才有机会进界面改回来。

**控制台打不开**：Proxmox 的设计限制，API Token 访问不了 `vncproxy`，要在设置里补一个 PVE
账号密码（建议只给 `PVEVMUser`）。**连上但黑屏**：云镜像默认不向图形控制台输出启动日志，
面板建的模板会自动配 `serial0` 和 `vga: serial0`，手工建的模板要在 PVE 里补上。

**模板构建卡在 importdisk**：镜像必须放在 dir / NFS / CIFS 存储上，放在 LVM 或 ZFS 会失败，
失败时面板会自动清理临时虚拟机。

**Docker 部署，容器起不来或反复重启**：多半是数据库口令对不上。`docker compose logs panel |
tail -30` 找 `Access denied` / `Can't connect`，改法见 [Docker 部署](#docker-部署) 里那两条
注意事项。

**主机安全页面读不到数据**：容器里 `/var/log`、`/proc` 属于容器而不是宿主机，页面会说明，
需要时按 `docker-compose.yml` 里注释的挂载项只读挂进去。

---

## 七、安全说明

密钥和口令。`SECRET_KEY` 留占位值或短于 32 位会直接拒绝启动；`ADMIN_PASSWORD` 空着、
短于 12 位或是 `admin123` 这类弱口令同样拒绝启动。这两个后端会拦，别偷懒。

必须套 HTTPS。登录凭据和 API Token 在 HTTP 上是明文。打开 `FORCE_HTTPS=true`，由
Nginx / Caddy 在 443 上终结 TLS。反代要带 `X-Forwarded-Proto`，`FORWARDED_ALLOW_IPS` 只保留
反代地址，否则公网请求可以自称 https 绕过跳转。同时保持 `PVE_VERIFY_SSL=true`（默认就是），
避免面板和 PVE 之间被中间人截走 Token。另外 `--privsep 1` 配合精确的 ACL 能让面板只碰它该碰的
资源，PVE 的 8006 端口也就不用对外暴露，流量全部经面板后端转发。

密钥类配置不回传前端。`GET /api/config/connection` 只返回 `token_secret_set`，更新时留空即
保持原值；SMTP 口令同样只回 `password_set`。管理员也看不到别人的 Webhook 与云密钥。

登录防护有三层。登录页的人机验证排在密码校验之前（脚本摸不到「密码对不对」这个信号），而
验证码没过不计入失败次数，否则拿一张错图反复提交就能把任意账号锁死。密码层面按账号和来源 IP
双计数，连续失败锁定若干分钟，计数落 MySQL、重启不清零。再往外是全局限流，按来源 IP 统计
`/api/*`，敏感入口单独一条更紧的线，超限返回 429。限流只信可信反代传来的
`X-Forwarded-For`，客户端自己伪造这个头绕不过去。

会话可撤销，写操作过 CSRF。登录签发 access + refresh 两个令牌，refresh 放在 `HttpOnly`
Cookie 里，JavaScript 读不到、XSS 也偷不走；登出会撤销服务端会话、当次令牌立刻失效，「个人
中心 → 登录设备」能逐个踢下线，「退出所有设备」或管理员踢人会令该账号所有已发出的令牌作废，
改密码同样踢掉其它设备。写请求要带 `X-CSRF-Token`（值取自同样下发但故意可读的 `panel_csrf`
Cookie），跨站页面读不到它、伪造不出来；WebSocket 握手同样用 Cookie 鉴权并校验 `Origin`，
令牌不再出现在 URL 里。

两步验证与二次确认。`TOTP_REQUIRED_ROLES=admin` 表示管理员必须先绑定认证器才能用面板，
绑定一次性给出 8 张恢复码、只显示一次，密钥用 `SECRET_KEY` 加密落库。删虚拟机、改连接凭据、
增删账号、改集群级防火墙、批量下发规则、写 fail2ban 策略这些操作，即便 token 还在有效期内也
不够，后端返回 `403 + X-Step-Up: required` 要求重新输密码（开了两步验证还要动态码）。敏感读取
也进审计：查看连接配置、邮件配置、翻阅审计日志本身都会记一条。「谁把集群 Token 抄走了」这类
问题只能靠读操作的痕迹回答。

---

## 八、规划

下一步想做的，按重要性排，不代表排期：

- SDN 网络。现在「网络」页管的是节点级 bridge / bond / VLAN，PVE 8.x / 9.x 的 SDN
  （zone / vnet / subnet / controller / IPAM）还没有入口。它是集群级对象，一份配置作用于整个
  集群，所以底线是「读」永远可用、「写」必须有 diff 预览和二次确认，且不提供「一键重建 SDN」
  这类不可回滚的动作。
- 计费与用量。指标历史已经在落库，缺的是「按谁、按多少、值多少钱」。最容易做错的是口径：
  PVE 给的网络流量是累计计数器，会因重启、迁移、驱动重置而归零，必须靠采样差分并丢弃计数器
  回退的样本，否则会算出负数或暴涨的流量。
- 其它候选：多租户与资源池、报表订阅、备份可验证（对接 PBS）、告警通道扩展（企业微信 /
  钉钉 / Telegram / 通用 Webhook）、Prometheus 指标导出、审计外送 SIEM、LDAP / OIDC 单点登录、
  亮色主题与 PWA。

每条的具体理由和验收标准写在 issue 里。

---

## 许可证

本项目以 [Apache-2.0](LICENSE) 许可发布。
