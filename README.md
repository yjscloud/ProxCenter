# ProxCenter — Proxmox VE 8.x / 9.x 管理面板

对接 **Proxmox VE 8.x / 9.x** 的 Web 管理系统。提供虚拟机与 **LXC 容器**的全生命周期管理、
cloud-init 模板流水线、网络配置、监控大盘、快照备份、浏览器内控制台（VNC / 串口）
以及多用户权限与操作审计。

- 后端：Python 3.13 + FastAPI + httpx（异步）
- 前端：React 18 + TypeScript + Vite + TanStack Query + Recharts
- 存储：MySQL 8（面板用户、审计日志、连接配置）

---

## 一、快速开始

### 1. 准备 Proxmox API Token

面板通过 **API Token** 与 Proxmox 通信。在 PVE 上执行：

```bash
# 1) 建一个专用用户（不要直接用 root）
pveum user add panel@pve --comment "ProxCenter panel"

# 2) 建 token（--privsep 0 表示该 token 继承用户的全部权限）
pveum user token add panel@pve panel --privsep 0
```

命令会输出 token 的 UUID，形如：

```
┌──────────────┬──────────────────────────────────────────┐
│ key          │ value                                    │
╞══════════════╪══════════════════════════════════════════╡
│ full-tokenid │ panel@pve!panel                     │
│ value        │ 1a2b3c4d-5e6f-7890-abcd-ef1234567890     │
└──────────────┴──────────────────────────────────────────┘
```

`full-tokenid` 填到面板的 **Token ID**，`value` 填到 **Token Secret**。

### 3. 授权

面板需要管理虚拟机的权限，按集群路径授予：

```bash
# 授予管理虚拟机的权限（含创建、开关机、快照、控制台）
pveum acl modify / --user panel@pve --roles PVEVMAdmin,PVEDatastoreUser,PVESDNUser
```

最小权限拆分（更安全，按需选择）：

| 功能 | 需要的角色 |
|---|---|
| 查看监控、只读浏览 | `PVEAuditor` |
| 开机 / 关机 / 控制台 | `PVEVMUser` |
| 创建 / 删除 / 改配置 / 快照 | `PVEVMAdmin` |
| 备份、ISO 与模板存储 | `PVEDatastoreUser`（读写用 `PVEDatastoreAdmin`）|
| 网桥 / VLAN 管理 | `PVESDNUser` |

> **重要**：Proxmox 不允许用 API Token 打开 VNC / 串口控制台，这两类接口只接受
> 用户密码换取的 ticket。若要在浏览器里使用控制台，请在面板设置里**另外填写一个
> PVE 账号密码**（`console_user` / `console_password`）。不填则控制台功能不可用，
> 其余功能不受影响。

### 4. 启动

```bash
# --- 后端 ---
cd backend
python -m venv ../.venv

source ../.venv/bin/activate

pip install -r requirements.txt
cp .env.example .env
# 必填两项，否则后端会直接拒绝启动（.env.example 里都是空/占位值）：
#   SECRET_KEY     —— JWT 签名密钥 + 密文加密根，至少 32 位随机
#   ADMIN_PASSWORD —— 首次建号的管理员口令，至少 12 位
python -c "import secrets; print('SECRET_KEY=' + secrets.token_urlsafe(48))"
python -c "import secrets; print('ADMIN_PASSWORD=' + secrets.token_urlsafe(16))"
# 把上面两条输出填进 backend/.env
python run.py                      # 监听 0.0.0.0:8080
```

后端起来后访问 <http://localhost:8080/api/docs> 可看到自动生成的 API 文档。

```bash
# --- 前端 ---
cd ..            # 回到 proxcenter/
npm install
npm run dev      # 开发模式，监听 5173，已配置 /api 代理到 8080
```

打开 <http://localhost:5173>，用 `admin` + 你自己填的 `ADMIN_PASSWORD` 登录
（首次启动若库为空会按它建号；弱口令/空口令会被拒绝启动，已经不存在默认密码了）。

**登录后请立刻做两件事**：① 在「设置 → Proxmox 连接配置」填入 host / Token ID / Token Secret；
② 在「用户管理」里改掉管理员密码。

### 5. 生产部署

生产形态是**单端口同源**：FastAPI 同时提供 `/api`（含控制台的 WebSocket）
与前端构建产物 `dist/`，因此不需要额外的静态服务器或反向代理。

#### 方式一：一键部署（推荐）

```bash
git clone https://github.com/<你的用户名>/proxcenter.git
cd proxcenter
sudo ./deploy.sh --mysql-root-password '<MySQL root 口令>' \
                 --db-name proxcenter_panel \
                 --db-user proxcenter \
                 --db-password '<面板库口令>'
```

`deploy.sh` 依次完成下列事情，**幂等** —— 重复执行不会破坏已有配置：

| 步骤 | 做什么 |
|---|---|
| 1 | 检查 Python ≥ 3.11 / Node.js / systemd，创建 `.venv` 并安装后端依赖 |
| 2 | 首次运行时从 `.env.example` 生成 `backend/.env`，**随机生成 `SECRET_KEY` 与初始管理员口令**（在结尾打印一次） |
| 3 | 建库建号（给了 `--mysql-root-password` 时）、把 `DB_*` 写回 `.env`，并**用面板账号实连一次**做验证 |
| 4 | `npm install` + `npm run build` 产出 `dist/`（机器上没有 Node 时用 `--skip-frontend` 复用已有产物） |
| 5 | 生成 `/etc/systemd/system/proxcenter.service`、`enable --now`，最后请求 `/api/health` 自检并打印面板地址 |

常用参数：

| 参数 | 说明 |
|---|---|
| `--port 9000` | 换监听端口（同时写回 `.env`） |
| `--service pc-panel` | 换 systemd 服务名（同机多实例时用） |
| `--user deploy` | 服务运行用户（默认 `root`；用非 root 时要保证该用户对仓库目录与 `logs/` 可写） |
| `--skip-frontend` | 跳过构建，复用现有 `dist/`（服务器上没有 Node.js） |
| `--no-systemd` | 只准备虚拟环境 / 依赖 / `.env` / 前端产物，不装服务（无需 root） |
| `--help` | 看全部参数与示例 |

> **`SECRET_KEY` 一旦生成就不要再改**：它既是登录 JWT 的签名密钥，也是库里
> 密文（PVE Token、SMTP 口令等）的加密根 —— 换掉之后这些密文全部解不开。
> 正因如此，`.env` 已存在时脚本**只覆盖命令行显式给出的键**，不动其他值。

#### 方式二：手动部署（前台运行）

```bash
npm run build          # 产物在 dist/（需要 Node.js）
./start-prod.sh        # 后端直接托管 dist/ 并启动
```

首次运行时会从 `.env.example` 生成 `backend/.env` 并随机填充 `SECRET_KEY` 与
初始管理员口令（打印在屏幕上的「初始管理员账号」一行里，登录后请立即修改）
—— 后端会拒绝占位 `SECRET_KEY` 和弱口令建号，所以这一步不能省。它同样不会
覆盖已存在的 `.env`：升级已有部署时要自己确认里面的 `SECRET_KEY` 不是占位值、
`ADMIN_PASSWORD` 不是弱口令，否则服务会拒绝启动并在日志里说明原因。

需要常驻（不必登录终端、进程退出能自动拉起）就用 systemd，见下一节；只是临时
验证可以后台跑：

```bash
mkdir -p logs
nohup ./start-prod.sh > logs/panel.log 2>&1 &
```

后端启动时会检测 `dist/`：只要构建产物存在，FastAPI 就会在 8080 端口同时提供
前端页面与 `/api`，前端与后端**同源**，VNC / 串口控制台的 WebSocket 也能直接
工作。直接暴露到公网时不要只开 `http://<服务器IP>:8080` —— 请按下文的 Nginx
示例上 443 并打开 `FORCE_HTTPS=true`。

#### 方式三：交给独立的静态服务器

也可以把 `dist/` 交给 Nginx / Caddy，此时需把 `/api` 反向代理到后端 8080
端口，**注意**：控制台用的 WebSocket 必须一并代理，并让面板知道「外部走的
是 https」。Nginx 配置示例（生产：80 跳 443 + HSTS）：

```nginx
# ① 明文一律跳到 HTTPS
server {
    listen 80;
    server_name panel.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    # 浏览器一年内只走 https；注意 add_header 不跨层继承 —— 下面每个自带
    # add_header 的 location 都要重复声明一次。
    add_header Strict-Transport-Security "max-age=31536000" always;

    root /var/www/proxcenter/dist;
    index index.html;

    # 前端 SPA 路由回退
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API + WebSocket 统一代理到后端
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # 这三行是 VNC / 串口控制台能工作的前提
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # 关键：后端据此判断「外部已经是 https」，配合 FORCE_HTTPS=true 才不会
        # 来回跳转；该头只对 FORWARDED_ALLOW_IPS 内的对端（本机反代）生效。
        proxy_set_header X-Forwarded-Proto $scheme;

        add_header Strict-Transport-Security "max-age=31536000" always;  # 见上
        proxy_read_timeout 3600s;   # 控制台是长连接，别让它被掐断
        proxy_buffering off;
    }
}
```

面板侧同时打开强制 HTTPS（否则直连 8080 仍是明文）：

```bash
FORCE_HTTPS=true
FORWARDED_ALLOW_IPS=127.0.0.1   # 不要放宽，否则公网可伪造 X-Forwarded-Proto 绕过
```

### 6. 开机自启与服务管理（systemd）

交给 systemd 后，机器重启会自动拉起面板，进程异常退出也会自动重启 —— 这一点
是 `nohup` 做不到的（那个进程一旦退出就不会再回来）。

> 用 `deploy.sh` 部署的话，下面「①②」两件**已经自动做完了**（单元文件由脚本
> 按实际安装路径、端口与运行用户渲染）。这一节保留手工步骤，一是方便核对脚本
> 到底写了什么，二是给「换端口 / 换用户 / 换目录」时参照。

**① 创建服务单元** `/etc/systemd/system/proxcenter.service`：

```ini
[Unit]
Description=ProxCenter - Proxmox VE 管理面板 (FastAPI :8080)
After=network-online.target
Wants=network-online.target
Before=nginx.service

[Service]
Type=simple
User=root
WorkingDirectory=/data/proxcenter/backend
Environment=PYTHONUNBUFFERED=1
ExecStart=/data/proxcenter/.venv/bin/python /data/proxcenter/backend/run.py
Restart=always
RestartSec=5
# 该进程优雅退出较慢，15 秒后强制结束，避免重启时被拖住
TimeoutStopSec=15
KillSignal=SIGTERM
StandardOutput=append:/data/proxcenter/logs/panel.log
StandardError=append:/data/proxcenter/logs/panel.log

[Install]
WantedBy=multi-user.target
```

> 按实际安装目录调整路径（本例为 `/data/proxcenter`）；`WorkingDirectory`
> 与 `ExecStart` 对齐 `start-prod.sh`，`.env` 与数据目录在代码里是绝对路径，
> 不受工作目录影响。

**② 启用并启动**：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now proxcenter   # 开机自启 + 立即启动
```

**③ 常用命令**：

| 操作 | 命令 |
|---|---|
| 查看状态 | `systemctl status proxcenter` |
| 启动 / 停止 | `systemctl start proxcenter` / `systemctl stop proxcenter` |
| 重启 | `systemctl restart proxcenter` |
| 开机自启 / 取消 | `systemctl enable proxcenter` / `systemctl disable proxcenter` |
| 是否开机自启 | `systemctl is-enabled proxcenter` |
| 跟踪日志 | `journalctl -u proxcenter -f` |
| 最近 100 行日志 | `journalctl -u proxcenter -n 100` |
| 面板日志文件 | `tail -f logs/panel.log` |

> 服务名可省略 `.service` 后缀；以下示例均使用 `proxcenter`。

**④ 改完代码后生效**：

```bash
npm run build                              # 只改了前端：重新构建即可，无需重启
sudo systemctl restart proxcenter   # 改了后端：重启服务（约 2 秒恢复可用）
```

用 `deploy.sh` 部署的话，这两件事都由它代劳 —— 它会按改动范围重建前端、重启
服务，最后再打一次健康检查：

```bash
git pull && sudo ./deploy.sh                   # 前后端都可能改过：重新构建 + 重启 + 自检
git pull && sudo ./deploy.sh --skip-frontend   # 只动了后端：复用现有 dist/，快得多
```

**⑤ 验证是否真的起来了**：

```bash
systemctl is-active proxcenter      # 期望输出 active
curl http://127.0.0.1:8080/api/health      # 期望输出 {"status":"ok","pve_connected":true,...}
```

> 开着 `FORCE_HTTPS=true` 也不影响上面这条：从本机回环发起、且不带 `X-Forwarded-Proto`
> 的请求会被放行（健康检查 / 运维脚本）。从其它机器用明文访问则一律 `308` 跳 HTTPS。

用 Nginx 反代时，Nginx 同样需要开机自启：

```bash
sudo systemctl enable --now nginx
nginx -t && systemctl reload nginx         # 改完配置后校验并重载
```

---

## 二、功能

### 虚拟机管理

- **创建**：四步向导 —— 基本信息（自动取下一个可用 VMID）/ 系统配置（OS 类型、BIOS、
  机型、SCSI 控制器、CPU 类型、核心、插槽、内存）/ 磁盘与网络（可动态增删多块磁盘、
  多张网卡，支持 VLAN Tag、防火墙、格式化选择）/ Cloud-Init（用户、密码、SSH 公钥、
  多网卡 IP 配置、DNS）。支持三种创建方式：空白新建、从模板克隆、从 cloud 镜像导入。
- **电源操作**：开机、关机（优雅，带超时与强制停止兜底）、强制停止、重启、挂起、恢复。
- **配置修改**：在线改 CPU / 内存 / 名称 / 标签 / 描述 / 开机自启 / 保护模式；
  磁盘扩容（含在线扩容）、磁盘迁移到其他存储池、跨节点迁移（支持在线迁移）。
- **删除**：检测运行状态，运行中会拒绝并提示先关机。
- **批量操作**：列表勾选多台后，一次执行开机 / 关机 / 重启 / 强制停止 / 删除，
  以及需要填参数的**打标签**、**迁移到指定节点**、**创建快照**。见下节。

### 批量操作（虚拟机 / 容器）

一次请求对多台机器执行同一个动作，接口是 `POST /api/vms/bulk`：

```jsonc
{
  "action": "shutdown",              // start/stop/shutdown/reboot/suspend/resume/delete/tag/migrate/snapshot
  "targets": [{"node": "pve", "vmid": 100, "type": "qemu", "name": "web-01"}],
  "params": { "timeout": 60 }        // 按 action 取用，用不到就留空
}
```

几条与单机接口不一样的设计，都是被真机教训过的：

- **不整批失败**。20 台里第 3 台锁着、删不掉，前 2 台已经没了 —— 整批抛 500
  等于让用户不知道动了几台。所以是**逐台执行、逐台回报**：HTTP 200 只表示请求
  合法，成败看 `results[]` 里每一项的 `ok`。前端渲染成「成功 N 台，失败 M 台」
  的清单，失败的留在选择里，可以「仅重试失败的」。
  （这套回报形状与防火墙模板下发一致，两处看结果的方式是同一个。）
- **不整批回滚**。已经关掉的机器不会因为第 N 台失败就再开机 —— 把刚关的机器
  又拉起来比不回滚更危险。删除是唯一不可逆的，靠「运行中拒绝」+ 二次确认兜底。
- **权限与归属逐台校验**。批量端点没有 `{node}/{vmid}` 路径参数，路由级的
  `require_vm_access` 在这里**不生效**，所以 `app/bulk.py` 显式复刻了同样的判定 ——
  否则「批量」就成了绕过用户隔离的后门。
- **连接按目标解析**。一次批量可能横跨多台 PVE，所以是每台各自
  `resolve_vm_connection()`，不是整个请求绑一条；并发下不能用 ContextVar 切换
  （会互相覆盖），为此 `pve.client_for_connection()` 直接按 id 取客户端。

限制：单次最多 200 台，同一台不能重复出现（重复会导致重复开机 / 重复删除）；
并发上限 6，太大会把 PVE 的任务队列打满。`delete` 属于 `STEP_UP_ACTIONS`，
整批要求一次二次确认，而不是每台弹一次。

### 容器（LXC）

PVE 上容器与虚拟机是**两套 API 端点**（`/nodes/{node}/lxc/{vmid}/...` 而不是
`/qemu/...`），所以面板里也是平行的一套页面与接口，而不是给虚拟机页加分支：

- **列表**：「虚拟机」页默认**混排**展示虚拟机与容器，每行带「容器」标签，
  可用「类型」下拉只看其中一种。点进去是各自的详情页。
- **创建**：三步向导 —— 系统模板 + rootfs / 资源（内存、Swap、核心、非特权、
  features）/ 网络与初始化。可选模板来自节点上**内容类型含 `vztmpl`** 的存储；
  一个都没上传时页面会给出 `pveam` 的下载命令，而不是让你对着空下拉发呆。
- **生命周期**：开机、关机（带超时）、强制停止、重启、挂起、恢复、删除（运行中拦截）。
- **配置**：改主机名、内存、Swap、核心、开机自启、保护模式、描述。
- **存储**：rootfs 与挂载点（`mpN`）一览，支持**扩容**（增量 `+10G` 或绝对值 `20G`）、
  新增挂载点、把卷迁到别的存储池。容器只支持增容，缩容 PVE 会直接拒绝。
- **网络**：`netN` 一览与增删。容器的 IP **写在网卡配置里**（`ip=` / `ip6=`），
  没有 cloud-init 可以下发地址，改完要重启容器才生效。
- **快照**：创建 / 回滚 / 删除。**容器快照不含内存状态**（`vmstate` 不适用）。
- **控制台**：串口终端（xterm.js）是容器的常用入口，图形控制台入口同样保留。
- **迁移 / 克隆**：跨节点迁移、克隆出新容器（**只有全量克隆**，PVE 不支持容器的链接克隆）。

几处与虚拟机的本质差别，改动时别照抄 `qemu` 的实现：

| 维度 | 虚拟机（qemu） | 容器（lxc） |
|---|---|---|
| 系统盘 | `scsiN` / `virtioN`（volid） | `rootfs`（创建时是「存储:GiB」，之后才是 volid） |
| 额外磁盘 | 磁盘键 | 挂载点 `mpN`，带容器内路径 `mp=/data` |
| 网卡 | `model=virtio,bridge=…` | `name=eth0,bridge=…,ip=…`，IP 直接在网卡行里 |
| 初始化 | cloud-init（`ciuser` / `sshkeys` / `ipconfigN`） | 只有 `password` 与 `ssh-public-keys`，用户名固定 root |
| 快照 | 可选含内存状态 | 不含内存状态 |
| 转模板 | 支持 | **不支持**（PVE 的 `pct` 没有这个能力，面板不给这个入口） |

归属、权限（同样是 `vm.*`）、审计、下发配额四处**与虚拟机共用**：
容器同样占一个 VMID、同样算进「可下发数量」，只数 qemu 的话拿容器就能绕过上限。

容器模板准备（在 PVE 节点上执行，或直接在面板「存储」页上传）：

```bash
pveam update
pveam download local debian-12-standard   # 也可选 ubuntu-24.04-standard / alpine-3.20-default
```

### 模板（cloud-init 流水线）
从 cloud 镜像一键构建模板，后端严格按序执行并在每步之间等待任务完成：

```
创建空壳虚拟机 → importdisk 导入镜像 → 定位卷 ID → 挂载为 scsi0 + 配置启动顺序
→ 挂载 cloud-init 驱动 → 按需扩容 → 转换为模板
```

任一步失败都会**自动删除临时虚拟机**，不会留下半成品。构建完成后可用「从模板部署」
批量开机器，克隆后自动注入主机名、SSH 公钥、IP 配置并开机。

推荐镜像（放入节点的 ISO 存储即可被面板识别）：

| 系统 | 镜像 |
|---|---|
| Ubuntu 24.04 | `noble-server-cloudimg-amd64.img` |
| Debian 12 | `debian-12-genericcloud-amd64.qcow2` |
| Rocky 9 | `Rocky-9-GenericCloud-Base.latest.x86_64.qcow2` |
| AlmaLinux 9 | `AlmaLinux-9-GenericCloud-latest.x86_64.qcow2` |

> cloud 镜像必须放在 **dir / NFS / CIFS** 类型的存储上（`importdisk` 要求文件级访问）。
> LVM、ZFS 等块存储无法直接作为镜像来源，但可以作为导入后的目标存储池。

### 网络
节点级 Linux Bridge / Bond / VLAN 管理：新增、编辑、删除，Linux Bridge 可从节点已有
物理网卡中选择桥接端口。所有改动先进入「待应用」状态，点「应用配置」才真正生效 ——
这一点与 Proxmox 本身的行为一致，避免改错网桥直接断掉节点网络。

### 防火墙 / 安全组
面板不另起一套规则引擎，而是**直接封装 Proxmox 原生防火墙**，所以在面板里配的规则与
PVE 界面、`pve-firewall` 看到的是同一份数据：

- **三个作用域**：集群（默认策略 + 全局规则）、节点（单台宿主机）、虚拟机 / 容器
  （`qemu` 与 `lxc` 会自动识别）。规则支持出入站、`ACCEPT` / `DROP` / `REJECT`、
  协议、端口（`22`、`80,443`、`8000:8100`）、来源 / 目标（IP、CIDR、`+集合名`）、
  PVE 预置宏、限定网卡、日志级别、启停与备注；顺序即优先级，可上下移。
- **结果面**：每台机器一个防火墙开关、入站 / 出站默认策略、日志级别；虚拟机还能开
  IP 过滤与 MAC 过滤（防源地址伪造）。
- **安全组（groups）**：集群级规则集合，任何 VM / 节点都能用「引用安全组」一条规则
  挂上它，改组即改所有引用方。
- **IP 集合（ipset）**：可复用的地址段，规则里写 `+office` 即可引用，支持取反匹配。
- **规则模板 + 批量下发**：把一套规则存成模板（存在面板自己的库里），一次刷到多台
  虚拟机；可选择「覆盖式」（先清空目标机规则）或「追加式」。逐台回报结果，机器网卡
  没开 `firewall=1` 时会明确提示「规则不会生效」，而不是让你配完一脸疑惑。
- 权限分三档：`firewall.view`（查看）、`firewall.manage`（改自己名下虚拟机的规则、
  安全组规则、IP 集合条目、下发模板）、`firewall.cluster`（集群级规则 / 默认策略、
  建删安全组与 IP 集合，默认仅管理员）。普通用户只能操作自己名下的虚拟机。
- 集群级改动、建删安全组 / IP 集合、批量下发都要**二次确认**；所有写操作进审计日志。

### SSH 登录安全 / 防暴力破解
读的是**面板所在主机**的 SSH 日志 —— 这是不加任何额外凭据就能拿到真实数据的来源
（集群里其它宿主机的 SSH 日志面板读不到，页面会如实写明数据来自哪台机器）：

- **日志采集**：`/var/log/secure`（RHEL 系）→ `/var/log/auth.log`（Debian 系）→
  `journalctl -u ssh -u sshd` 三级回退，三者都不可用时明确说明原因。
  只统计**真正的认证失败**：一次失败连接会写出 pam 与 `Failed password` 两行，
  按 sshd 的 PID 去重只算一次；`Connection closed/reset`、`Did not receive
  identification string` 这类健康检查与端口扫描噪声不计入，避免告警变狼来了。
- **失败来源排行**：按 IP 聚合次数、尝试过的用户名与最近时间；可一键封禁、
  标记可信、加入忽略名单。窗口 1-168 小时可调。
- **fail2ban 管控**：jail 列表、当前 / 累计封禁数、封禁中的 IP 一键解封、手动封禁
  指定 IP；「自定义封禁策略」写 `/etc/fail2ban/jail.d/panel-<jail>.local`
  （只动面板自己的文件，不碰 `jail.local`）并 `reload`。没装 fail2ban 时给出
  明确的安装指引，而不是静默失败。
- **异常登录告警**：两类事件接到「监控告警」已有的飞书 / 邮件通道 ——
  ① 某 IP 在窗口内失败次数超阈值（`ssh-fail`，攻击停止后自动发**恢复**通知）；
  ② 陌生 IP 登录成功（`ssh-login`，第一次见到的地址立即提醒，可在「已知 IP」里
  标记可信或取消标记）。冷却时间可配，同一对象冷却期内不重复打扰。
  后台与资源告警同频（每分钟）自动检查，也可手动「立即检测」。
- 权限：`ssh.view`（看统计，普通角色也有）、`ssh.manage`（封禁 / 解封 / 改策略，
  默认仅管理员 —— 封禁会影响整台主机）。改策略与写 jail 都要二次确认，全部写操作进审计日志。

**多机（受管主机）**：面板还能用 **SSH 凭据**连到其它机器上做同样的事 —— 在
「受管主机」里填地址、用户、私钥或口令（用 `SECRET_KEY` 加密落库，接口只回
`secret_set`）后，面板远程执行**固定几条命令**读回日志与 fail2ban 状态，与本机
共用同一套解析和告警逻辑：

- **首次连接要先「信任指纹」**：面板先连一次拿到 SSH 指纹，你确认后才写入；
  之后指纹变了直接拒绝连接（防中间人）。
- 非 root 用户可勾选「命令前加 `sudo -n`」（目标机需配 NOPASSWD）；日志来源可
  指定 `journalctl` / `secure` / `auth.log`，默认自动探测（先 journalctl，再兜底
  `tail` 日志文件）。
- 页面顶部可切换作用域（**本机 / 某台受管主机**），多机汇总卡片列出每台的状态，
  点一行即切换；失败明细、封禁解封、封禁策略下发都作用在选中的主机上。
- 告警按**「主机 + IP」**单独计数与冷却，通知里写明是哪台机器；本机由面板直读，
  受管主机由后台每分钟连一次 —— 某一台连不上只标红这一台，不影响其它主机，也不会
  让页面 500。
- 远程只跑面板拼好的命令，IP 与 jail 名先过白名单正则；所有操作（连不上、封禁、
  写策略）都写进审计日志。

### 安全基线检查与加固（全平台服务器）
给**平台上的所有服务器**做一键体检，输出**评分报告 + 逐项加固建议 + 一键修复**
（`backend/app/baseline.py`）。适合「给用户自助加固」：

体检对象有两个来源，**在后端共用同一套判定逻辑**，所以两端结论口径完全一致：

| 来源 | 怎么拿到数据 | 加固能力 |
|---|---|---|
| **本机**（面板所在主机） | 直接读系统文件 / 跑只读命令，无需额外凭据 | 以 root 运行时全功能 |
| **受管主机**（「SSH 安全 → 受管主机」里启用的） | 复用 `sshremote` 的 SSH 通道，在远端跑**一条**只读单行命令，分节打印原始数据后回本地解析评定 | 该账号有 root / 免密 sudo 时全功能，否则退化为只读体检 |

> 架构上刻意把**采集**与**判定**分开：`local_snapshot()` / `remote_snapshot()` 只
> 负责取原始数据，`evaluate()` 是纯函数、两端共用 —— 这也是远程结论与本机同构的
> 实现方式（有回归用例锁定两者一致性）。
>
> 集群里的 **Proxmox 节点**若要体检，把它作为一台受管主机加进来即可：PVE API 没有
> 「在节点本机执行 shell」的接口，面板拿不到节点的本地数据。

页面分两层信息架构：

- **全平台总览**（默认）：每台服务器一张卡片 —— 评分环 + 通过/待改进/不合格的
  占比条 + 最需处理的几项；**按「最需要处理」排序**（有不合格项的最前，其次是连
  不上的），顶部是服务器总数 / 平均分 / 不合格项 / 待改进项四个指标。
- **单机详情**：大评分环 + 一句话结论 + 主机名/系统/内核/加固权限元信息，然后是
  **「需要处理」清单**（可一键加固，置顶）与按分类折叠的**全部检查项**。

- **七类检查**：
  - SSH：是否禁 root 直登、是否关口令认证、是否允许空口令、认证重试上限、X11 转发；
  - 口令策略：`login.defs` 的有效期上限 / 最小长度、PAM 复杂度模块、失败锁定（faillock）；
  - 防火墙：ufw / firewalld / nftables / iptables / Proxmox 自带的 pve-firewall 是否启用；
  - 时间同步：`timedatectl` 的同步状态或 chrony / timesyncd / ntp 服务；
  - 账号安全：空口令**且可登录**的账号、除 root 外的 UID 0 账号；
  - 关键内核参数：ASLR、SYN cookies、rp_filter、ICMP 重定向 / 源路由、dmesg / kptr 限制。
- **评分**：按严重级别加权（高危 3、中危 2、低危 1），「待改进」按半分计，给出
  A / B / C / D 等级；「无法检测」的项不计入分母，缺权限时不会被冤枉扣分。
- **一键修复**：只写面板自己命名的文件 —— `/etc/ssh/sshd_config.d/99-panel-baseline.conf`
  与 `/etc/sysctl.d/99-panel-baseline.conf`，改 `/etc/login.defs` 前先备份。SSH 配置
  改完立刻 `sshd -t` 校验、sysctl 改完复读 `/proc` 确认，**校验不过自动回滚**，
  绝不会把机器改到登录不上去（远程加固同样如此，回滚也用 SSH 完成）。
- **不会自动做的事**：关闭 SSH 口令认证这类「可能把人锁在门外」的项 **不纳入
  「一键加固」**，必须逐项确认后单独修复；受管主机若正用「root + 口令」连接，
  禁止 root 登录 / 关闭口令认证的加固会被**直接拒绝**（否则面板会连同自己一起关在
  门外）；防火墙、PAM 复杂度模块、UID 0 账号这些「因环境而异」的项只给手动建议。
- 权限：`baseline.view`（看报告，普通角色也有）、`baseline.manage`（一键加固，默认
  仅管理员 —— 改的是服务器的安全配置）。加固需二次确认，报告读取与加固都进审计日志
  （`baseline.read` / `baseline.fleet_read` / `baseline.fix` / `baseline.fix_all`）。

接口：`GET /api/baseline/targets`（主机清单）、`GET /api/baseline/fleet`（总览）、
`GET /api/baseline/hosts/{id}`（单机详情，`local` 或受管主机 id）、
`GET /api/baseline/report`（本机详情）、`POST /api/baseline/fix` / `fix-all`
（带 `host_id`）。

### 端口与进程异常检测
巡检**各服务器**的监听端口与可疑进程（`backend/app/portguard.py`），架构与安全基线
完全一致（`local_snapshot()` / `remote_snapshot()` 采集 + 纯函数 `assess()` 判定，
本机与受管主机共用一套逻辑，远程同样合并成一条只读命令、一次 SSH 往返）。

- **监听端口清单**：`ss -tulpn` 优先、老系统退回 `netstat -tulpn`（两个解析器都实现），
  给出协议 / 监听地址 / 归属进程与 PID / 暴露范围（仅本机 · 全部网卡 · 指定地址）。
- **对外开放端口识别**：监听在非回环地址即算「对外开放」，并与**同一次采集到的防火墙
  状态**关联 —— 没有活动防火墙时，风险级别整体上调。常见「不该对公网开放」的服务端口
  （MySQL / Redis / MongoDB / Docker API / RDP / 2049 …）单独标出，明文老协议
  （Telnet / rsh / TFTP …）直接高危。
- **可疑进程（反弹 shell 启发式）**：`/dev/tcp` 重定向、`nc -e` / `ncat --exec`、
  `socat exec:`、Python/Perl/Ruby/PHP 单行脚本里的 socket 与 dup2、`openssl s_client`
  管道给 shell、`mkfifo` + `nc`、`curl|sh`；再叠加**上下文特征** —— shell 持有对外连接、
  父进程是 Web 服务却落了 shell、可执行文件位于 `/tmp`、`/dev/shm`、可执行文件已被删除、
  已知挖矿/蠕虫进程名、连接到常见后门端口。
- **联动告警**：`portguard.evaluate()` 照 `sshguard` 的写法复用告警体系（去重 / 冷却 /
  飞书邮件 / 恢复通知），**不需要**往告警规则表里加新指标；`main.py` 的 `_alert_loop`
  每 5 个周期（约 5 分钟）跑一次。
- **压误报**：巡检策略里的**预期端口**（`22` / `0.0.0.0:80` / `*:443`）与**进程白名单**
  正则；不写代码就能收敛自己环境里的噪音。

> **这是启发式，不是杀毒引擎。** 每条命中都会列出「命中了哪条规则」供人工判断，
> 面板**不会**据此杀进程；误报与漏报都不可避免。「对外开放」也只代表监听在非回环
> 地址，是否真能被外部访问还取决于防火墙与上游网络 —— 所以报告里把防火墙状态一并
> 给出，由人判断，而不是替用户下「已被公网暴露」的结论。
>
> 权限不足（非 root）时看不到别人的进程，「归属进程」会显示未知、`/tmp` 可执行文件
> 与「已删除的可执行文件」这类特征也拿不到 —— 页面会标「只读巡检」，不是问题消失了。

接口：`GET /api/ports/hosts`、`GET /api/ports/overview`（总览，最需要看的排最前）、
`GET /api/ports/hosts/{id}`、`GET` / `PUT /api/ports/policy`、`POST /api/ports/check`
（立即巡检并推送）。权限：`ports.view` / `ports.manage`。

### 应急响应兜底（VM 隔离 + 备份防删）
出事时用的两件事（`backend/app/isolation.py` + `backend/app/backupguard.py`）。

**一、可疑虚拟机一键隔离**（`POST /api/vms/{node}/{vmid}/quarantine`）

处置顺序是**刻意**的：**先取证快照 → 再断网 → 再关机 → 顺手加 VM 保护**。反过来的话
机器一关，现场就没了。每一步独立执行、单独回报成败 —— 取证失败（存储满、有锁）不会
阻止把网络切掉，但结果里会明确标红，避免误以为「已经取证好了」。

- **断网**：逐张 `net*` 置 `link_down=1`。PVE 对 `netX` 是**整串替换**，所以实现是在
  原始串上增删 `link_down` 那一段，`bridge` / `tag` / `macaddr` / `rate` 全部原样保留
  （直接覆盖会把别的属性抹掉）。`POST …/quarantine/release` 做逆操作：去掉 `link_down`、
  按需解除保护、按需开机。
- **权限与审计**：`vm.isolate` + 二次确认；挂在 vms 路由下，普通用户只能处置自己名下的机器；
  隔离 / 解除 / 状态读取分别记 `vm.quarantine` / `vm.quarantine.release` / `vm.quarantine.read`。

> **能力边界（页面与接口都会如实返回，不假装能做得更多）**：
> ① 快照是**崩溃一致性**的磁盘副本，**无法提取内存镜像**，对运行中的机器做快照不等于
> 内存取证；② `link_down` 只切断 PVE 虚拟网卡，**PCI 直通 / SR-IOV 网卡不受控制**，
> 需要在交换机侧另行隔离；③ 隔离不清除入侵痕迹，但**回滚快照会覆盖当前磁盘状态** ——
> 取证与回滚在目标上冲突，所以面板**不提供**「回滚到取证快照」这个动作。

**二、备份防删 / 防篡改核对**（`backend/app/backupguard.py`）

先说清楚**不是**什么：**真正的不可变（WORM）只能由存储侧保证** —— PBS 的
retention/immutability、S3 Object Lock、或只读挂载。**只靠 PVE API 做不到**，这里也没
假装做到。实现的是**检测型**三位一体防护：

1. **登记**：把备份卷登记为受保护，并尽力给 PVE 卷打上 `protected` 旗标（拦住 PVE 的
   prune 与常规删除，root 仍可清除）；
2. **面板层拦截**：`DELETE /api/backups` 会**拒删**受保护备份 —— 勒索软件即使拿到管理员
   会话，「先删备份再加密」这条路也走不通，必须先在界面上解除保护（两次明确操作）；
3. **核对与告警**：定期（或手动）把登记过的备份与 PVE 实际内容对一遍，**不见了**或
   **元数据变了**（大小 / 创建时间）就发告警，恢复后再发恢复通知。

> **关于「指纹」的实话**：PVE 的 storage content **不返回内容校验和**（`verification`
> 只有 PBS 存储才有），所以 `meta_fingerprint` 取的是 `volid|size|ctime` 的哈希 ——
> 它能发现**删除 / 替换 / 元数据变化**，**不能**发现存储层的静默位翻转（bit rot）。
> 要后者请接入 PBS。

接口：`GET /api/backups/protected`（清单，可带 `verify=1` 现场核对）、
`POST /api/backups/protected`（登记）、`DELETE /api/backups/protected`（解除，需二次确认）、
`POST /api/backups/protected/verify`（立即核对并推告警）。权限沿用 `vm.backup`。

### 主机登录审计
把「主机级」的登录与提权记录纳入面板，两块内容：

- **原始登录记录**：`last`（成功，读 wtmp）/`lastb`（失败，读 btmp）解析出账号、终端、
  来源 IP、开始/结束时间与状态（still logged in 等），另有开机记录单独标出；
  auth.log / secure 里的 **sudo、su 提权**（提权人、目标账号、命令、成功与否）。
  主机范围 = 面板本机 + 受管远程主机（SSH），顶部切换。
- **汇入面板审计**：这些事件按**每台主机一个游标**增量写入 `audit_log`，动作名
  `host.ssh_login` / `host.ssh_failed` / `host.sudo`，与面板自身的操作出现在同一张
  审计表里（审计日志页按动作过滤即可）。后台每 5 分钟自动跑一次，也可手动「汇入审计」；
  重复汇入不会重复写，读取这些记录本身同样会记一条 `host_audit.read`（翻登录记录
  往往是为了掩盖痕迹，必须留痕）。
- **虚拟机视角**：面板读不到 VM 内部的登录日志，但能回答更常用的问题 ——
  *这台 VM 有没有被用来登录宿主机*：按 VM 的 IP（Guest Agent 或静态配置）去匹配各
  主机的登录记录，列出「以该 VM 为来源」的登录事件。

### 监控
- 集群大盘：VM 总数与运行分布、CPU / 内存 / 存储使用率环形图、节点状态一览、
  最近任务、资源占用排行（Top 8，CPU / 内存双 Tab 切换）。
- **节点实时指标推送**：大盘通过 `/ws/metrics` WebSocket 接收节点指标（5 秒一推），
  在线时优先用实时值驱动 KPI 与节点行，断线自动静默重连并回落到 10 秒轮询，
  任何情况下都有数据。
- **磁盘容量预测**：跨所有 PVE 连接聚合节点根分区历史，用最小二乘做线性外推，
  给出日均增长率与预计写满天数，支持周 / 月 / 年三种回溯窗口。
  PVE 8.x / 9.x 的 rrddata 用 `rootused` / `roottotal`，更旧的版本用 `disk` /
  `maxdisk`，已做双向兼容。
- 节点与虚拟机各自的 RRD 曲线：CPU、内存、网络 I/O、磁盘 I/O，支持
  小时 / 天 / 周 / 月切换。
- **两种通知通道**：飞书机器人（Webhook + 签名）与邮件，两者**相互独立**，
  可以只开一个也可以都开；任一通道送达即算送达，历史记录里会写明每个通道的结果。
  邮件通道的**收件人按用户各自配置**（留空则用账号邮箱），发信用的 SMTP
  服务器则是全局配置（管理员在「设置 → 邮件通知」里维护）。

### 快照与备份
- 快照：创建（可选包含内存状态）、回滚、删除，支持全局跨虚拟机视图。
- 备份：立即备份（snapshot / suspend / stop 三种模式，zstd / gzip / lzo / 无压缩）、
  按存储或虚拟机浏览备份卷、恢复到指定 VMID、删除备份。
- 备份计划：可视化创建 Proxmox 定时备份任务，配置调度、存储、模式、压缩、
  保留策略，支持启用 / 停用。

### 控制台
浏览器内直接操作虚拟机，无需跳转 Proxmox 原生界面：
- **noVNC**：图形控制台，支持自动重连、全屏、发送 Ctrl+Alt+Del。
- **xterm.js**：串口控制台，适合无 GUI 的云镜像（模板已自动挂载 `serial0`）。

后端做 WebSocket 双向透传，PVE 的 Web 界面**无需暴露到公网**。

### 用户与审计
- 三级内置角色（权限在 `backend/app/security.py` 中集中定义）：

| 角色 | 权限范围 |
|---|---|
| `admin` | 全部权限，含用户管理、连接配置、删除虚拟机、集群级防火墙 |
| `operator` | 创建 / 开关机 / 控制台 / 快照 / 备份 / 克隆 / 改配置、管自己名下机器的防火墙、看 SSH 登录安全统计；不能管用户、不能删除虚拟机、不能改集群级防火墙、不能封禁 IP |
| `viewer` | 只读：查看资源、监控、任务、防火墙规则、SSH 登录安全统计 |

- **自助注册 + 管理员审批**：登录页可进入「注册申请」，提交后账号状态为
  `pending`，**无法登录**；管理员在「用户管理 → 待审批注册申请」里点「通过」，
  同时把角色与权限（可逐条自定义）一次分配好，账号才变为 `active`。
  拒绝的账号保留在库中（状态 `rejected`）占住用户名，管理员可在编辑用户时把
  状态改回「正常」恢复。
  - **邮箱必填**：审批结果通过邮件送达。提交注册时给管理员发一封「待审批」通知，
    通过 / 拒绝时再给申请人各发一封，邮件里带上分配到的角色或拒绝理由。
  - 邮件是**旁路**，不是关键路径：SMTP 没配好或发信失败都只记进审计日志
    （`detail.mail`），绝不让注册或审批本身失败。
  - 注册是公开接口，按来源 IP 限速（每小时 5 次），因为每次注册都要跑一次 bcrypt。
  - 账号状态每次请求都会重新查库：把账号打回 `pending` / `rejected` 会让已发出的
    token 立即失效，不必等它过期。
  - 判重口径与登录一致：用户名已被占用时只返回「被占用」，不透露该账号的状态。
- 所有写操作（含失败）都记入审计日志，记录用户、动作、目标、结果、详情、来源 IP，
  支持按用户 / 动作 / 结果筛选与分页。注册与审批分别记为 `auth.register`、
  `user.approve`、`user.reject`。
- 有防呆保护：不能删除最后一个管理员、不能禁用或降级最后一个管理员、不能删除当前登录账号。

### 虚拟机下发配额
一个**全局**容量上限（`backend/app/quota.py`），不是按用户分配的：管理员在
「设置 → 虚拟机创建默认值 → 可下发虚拟机数量」填一个总数，
已用 = 现有虚拟机总数（跨所有 PVE 连接，**含模板**），可下发 = 总数 − 已用。
- **填 0 时普通用户完全不能创建虚拟机**，管理员不受限 —— 到上限后总得有人能
  清理与扩容，把管理员一起锁死只会让谁都动不了手。
- 未设置（留空）= **不限制**，存量部署装上这个功能不会被突然锁住。
- 创建向导第 1 步会显示「还可下发 N 台」；`can_create` 为 false 时「创建虚拟机」
  按钮直接禁用，不必等提交后被 403 打回来。
- 拦截覆盖两个会**实实在在多出一台机器**的入口：`POST /api/vms`（新建 / 云镜像 /
  克隆）与 `POST /api/vms/{node}/{vmid}/clone` —— 只拦前者的话，反复克隆就能绕过。
- 配额是容量约束而非安全边界：某条 PVE 连不上时计数会偏小，此时放行但如实上报
  `count_error`；唯一例外是配额为 0，那时无论计数成功与否都直接拦下。
- 相关接口：`GET/PUT /api/config/vm-quota`（设置，需 `settings.manage`）、
  `GET /api/vms/quota`（自己的读数，登录即可）。配额拦截记入审计日志
  （`vm.create`，`result=denied`，`detail.reason=quota`）。

### 监控与集成的用户隔离

监控与集成（内网穿透、告警、网站证书）**按用户独立**，各自的配置与凭据互不可见：

| 数据 | 归属规则 | 普通用户可见 | 管理员可见 |
|---|---|---|---|
| 告警规则 / 告警历史 | 规则创建者 | 只有自己的 | 全部（他人的规则只读） |
| 告警通知（飞书 Webhook / 签名） | 每个用户一份 | 只有自己的 | 只有自己的 |
| 网站证书站点 / 部署日志 | 站点创建者 | 只有自己的 | 全部（他人的站点只读） |
| 腾讯云 SecretId / SecretKey | 每个用户一份 | 只有自己的 | 只有自己的 |
| 飞书机器人（指令控制） | 全局单例 | **页面与接口都不可见** | 仅管理员 |

- **告警各发各的**：评估循环按规则归属分组，用规则所有者自己的 Webhook 推送；
  冷却时间、告警状态也按 `归属 + 规则 + 对象` 分别计算，互不干扰。
- **「立即检测」**只评估当前用户自己的规则；管理员评估全部。
- **密钥类配置从不汇总**：管理员也无法查看或代填他人的 Webhook 与腾讯云密钥。
- **建表自动补列**：面板启动时会自动给 `alert_history`、`alert_active`、`cert_deploy_log`
  补上 `username` 归属列（并放宽 `alert_active.alarm_key` 长度），无需手工改表。

### 设置与环境自检
连接配置全部可以在线修改（存 MySQL，保存后立即生效，无需重启），Token Secret 只
在后端使用、前端永远拿不到明文。「环境自检」会读取当前凭据在 Proxmox 上的
**有效权限**，逐项列出 API 可达性、节点可见性、资源指标、存储、虚拟机、控制台凭据
是否正常，并把每项异常转成可直接执行的修复命令——用来对付 Token 权限不足导致的
「列表全空」问题（详见第六节）。

---

## 三、配置项

`backend/.env`（完整示例见 `backend/.env.example`）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SECRET_KEY` | `change-me-...` | 签发登录 JWT，同时是库里密文（PVE Token、SMTP 密码等）的加密根。**留占位值或短于 32 位会直接拒绝启动**；生成随机值：`python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `ADMIN_USERNAME` | `admin` | 首次启动创建的管理员账号 |
| `ADMIN_PASSWORD` | 空 | 首次启动的管理员密码。**留空、短于 12 位或 `admin123` 之类弱口令会拒绝启动**（`./start-prod.sh` 首次生成 `.env` 时会自动填入随机口令并打印） |
| `FORCE_HTTPS` | `false` | 设为 `true` 后明文 HTTP 一律 `308` 跳到 `https://<Host>`，HTTPS 响应附 HSTS；仅本机回环（健康检查 / 运维脚本）豁免。TLS 由前面的 Nginx/Caddy 终结 |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | uvicorn 信任哪些来源的 `X-Forwarded-Proto`。**只填本机反代**：放宽成 `0.0.0.0` 等于让公网请求自称「我是 https」，从而绕过 `FORCE_HTTPS`。限流的来源 IP 也只信这里面的对端传来的 `X-Forwarded-For` |
| `LOGIN_MAX_FAILURES` | `5` | 登录失败几次就锁定（账号 + 来源 IP 双计数） |
| `LOGIN_LOCKOUT_MINUTES` | `15` | 失败计数窗口与锁定时长 |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `720` | access token 有效期。有了 refresh token 后可以调短（如 `60`） |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `14` | refresh token 有效期，= 一次登录最多能用多久；放在 HttpOnly Cookie 里 |
| `TOTP_REQUIRED_ROLES` | 空 | 强制开启两步验证的角色（逗号分隔）。填 `admin` = 管理员必须先绑定 TOTP 才能用面板 |
| `TOTP_ISSUER` | `Proxmox Panel` | 认证器 App 里显示的发行方名称 |
| `RATE_LIMIT_ENABLED` | `true` | 全局请求限流开关（只作用于 `/api/*`） |
| `RATE_LIMIT_PER_MINUTE` | `300` | 每个来源 IP 每分钟的普通接口请求上限 |
| `RATE_LIMIT_AUTH_PER_MINUTE` | `30` | 登录 / 注册 / 找回密码 / 刷新令牌 / 2FA 的每分钟上限 |
| `COOKIE_SECURE` | 空 | 凭据 Cookie 是否只走 HTTPS。**留空 = 跟随 `FORCE_HTTPS`**，一般不用设 |
| `STEP_UP_REQUIRED` | `true` | 危险操作是否要求二次确认（重输密码，开了 2FA 再加动态码） |
| `STEP_UP_WINDOW_MINUTES` | `5` | 二次确认的有效窗口；窗口内重复操作不必反复输入 |
| `PVE_HOST` | 空 | Proxmox 地址（IP 或域名，不带协议） |
| `PVE_PORT` | `8006` | Proxmox API 端口 |
| `PVE_TOKEN_ID` | 空 | 形如 `panel@pve!panel` |
| `PVE_TOKEN_SECRET` | 空 | Token 的 UUID |
| `PVE_VERIFY_SSL` | `true` | 出站是否校验 PVE 证书。**生产默认开启**：关闭等于把 API Token 暴露给中间人。PVE 自签证书或证书过期时改为 `false`，或在「设置」里对该连接单独关闭并填自签 CA |
| `PVE_TRUST_ENV` | `false` | 是否让请求走环境变量里的 `HTTP_PROXY` / `HTTPS_PROXY`。默认关闭：Proxmox 通常在内网，继承到的企业代理会让每次调用都变成莫名其妙的 502 |
| `PVE_CONSOLE_USER` | 空 | 控制台用 PVE 账号（如 `root@pam`），留空则禁用控制台 |
| `PVE_CONSOLE_PASSWORD` | 空 | 同上账号的密码 |
| `CORS_ORIGINS` | `http://localhost:5173` | 允许的前端来源，逗号分隔 |
| `DB_HOST` | `127.0.0.1` | MySQL 地址 |
| `DB_PORT` | `3306` | MySQL 端口 |
| `DB_USER` | 空 | MySQL 账号 |
| `DB_PASSWORD` | 空 | MySQL 密码 |
| `DB_NAME` | 空 | 面板数据库名（**必填**） |
| `DB_POOL_SIZE` | `8` | 连接池上限 |

面板只支持 MySQL。先在 MySQL 上建库（账号按需授权，表结构由面板启动时自动创建）：

```sql
CREATE DATABASE zhangbeihai_panel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

`.env` 里的值只是**初始默认值**。面板启动后，连接配置也可以通过「设置」页面在线修改，
改动会存到 MySQL 并立即生效（无需重启）。页面上的配置优先级高于 `.env`。

**邮件（SMTP）配置没有环境变量，只在「设置 → 邮件通知」里维护**：服务器地址、
端口、加密方式、账号密码、发件人、是否校验证书，以及注册 / 审批通知的管理员收件人。
SMTP 密码用 `SECRET_KEY` 加密后落库，接口只回 `password_set`，明文永不回传前端。
「管理员收件人」留空时会退回到「所有填了邮箱的管理员账号」。

---

## 四、项目结构

```
proxcenter/
├── deploy.sh                      一键部署：建虚拟环境 + 装依赖 + 生成 .env + 构建前端
│                                  + 装 systemd 服务 + 健康自检（幂等，可重复执行）
├── start.sh                       开发模式：后端 + Vite 开发服务器一起拉起
├── start-prod.sh                  生产模式：后端托管 dist/ 前台运行（不装服务时用）
├── scripts/                       辅助脚本（依赖环境校验、静态验收服务器、导入图校验）
├── backend/
│   ├── run.py                     启动入口
│   ├── requirements.txt
│   ├── .env.example
│   └── app/
│       ├── main.py                FastAPI 应用、路由挂载、异常处理
│       ├── config.py              环境变量配置
│       ├── pve.py                 Proxmox API 客户端（token + ticket 双认证）
│       ├── vmconfig.py            虚拟机 / 容器配置构建与解析（关键的 PVE 参数拼装逻辑）
│       ├── bulk.py                批量操作编排：逐台分派、归属校验、归属连接解析、逐台回报
│       ├── security.py            JWT 会话、RBAC 权限模型、审计辅助
│       ├── store.py               MySQL：用户、审计日志、连接配置
│       ├── schemas.py             请求 / 响应模型
│       ├── formatters.py          PVE 返回值的归一化
│       └── routers/
│           ├── auth.py            登录 / 登出 / 当前用户
│           ├── config.py          连接配置、连通性测试、环境自检、/health
│           ├── dashboard.py       大盘聚合数据
│           ├── cluster.py         集群、节点、RRD、任务（只读）
│           ├── vms.py             虚拟机全生命周期（最大模块）
│           ├── lxc.py             LXC 容器全生命周期（与 vms 平行，共用归属与权限）
│           ├── templates.py       cloud-init 模板流水线
│           ├── storages.py        存储与内容、ISO 上传
│           ├── network.py         网桥 / Bond / VLAN
│           ├── baseline.py        全平台安全基线体检与加固
│           ├── portguard.py       端口 / 进程异常检测
│           ├── isolation.py       虚拟机应急隔离
│           ├── backups.py         备份……（含备份防护：受保护备份登记与核对）
│           ├── backups.py         备份、恢复、备份计划
│           ├── tasks.py           任务队列 + 实时进度 WebSocket
│           ├── console.py         VNC / 串口 WebSocket 代理（虚拟机与容器共用链路）
│           ├── users.py           面板用户管理
│           └── audit.py           审计日志
└── src/
    ├── api/                       axios 客户端、类型、接口封装
    ├── hooks/                     认证、toast、任务等待、WebSocket
    ├── components/                布局与通用 UI 组件
    ├── pages/                     17 个页面（含登录 / 注册、防火墙、SSH 安全）
    ├── styles/                    深色主题设计系统
    └── utils/                     格式化与状态映射
```

---

## 五、测试

```bash
cd backend
../.venv/bin/python -m pip install -r requirements-dev.txt   # 装 pytest
../.venv/bin/python -m pytest                                # 625 个测试
```

测试分三层，**全部不需要真实 Proxmox 环境**：

| 文件 | 覆盖内容 |
|---|---|
| `tests/test_vmconfig.py` | VM 配置构建与解析：磁盘/网卡/cloud-init 的 `key=value` 拼装、UPID 解析、权限矩阵、JWT、密码哈希、字段别名（camelCase ↔ snake_case）、PVE 布尔标志位解析（`enabled=1` 这类 k=v 写法） |
| `tests/test_pve_client.py` | 起一个模拟 Proxmox 的 HTTP 服务器，验证认证头格式、响应解包、任务轮询、存储类型映射、克隆参数、错误传播、各层传输失败（连接失败 / 超时 / 代理拦截）到 HTTP 状态码的映射 |
| `tests/test_mailer.py` | 邮件模块的纯逻辑：收件人分隔符归一（含直接传 list）、「算不算配好」的判定、密码脱敏、邮件报文构造（From/To/Subject、HTML 备选体）、未配置 / 无收件人 / 传输异常时的失败信息、各类通知模板内容。**不连数据库也不连 SMTP** |
| `tests/test_api_routes.py` | 用 FastAPI TestClient 打通「HTTP 请求 → 路由 → 权限校验 → Proxmox 调用 → 响应」全链路，含 RBAC 矩阵、审计落库、防呆保护、secret 脱敏、启动容错、连接配置热更新、权限自检、**自助注册与管理员审批**（待审批禁止登录、审批同时分配角色与权限、拒绝后仍占用户名、撤回审批立即失效已发 token、非管理员不能审批、按 IP 限速），以及监控与集成的**按用户隔离**（告警规则 / 历史 / 通知通道、证书站点 / 密钥 / 日志、机器人页面仅管理员） |
| `tests/test_firewall.py` | 防火墙：三级作用域的规则增删改与顺序调整、非法规则 / 端口写法被拒、开关与默认策略、安全组与组内规则、IP 集合条目、**规则模板批量下发**（覆盖式 / 追加式的顺序语义、逐台回报、网卡未开 `firewall=1` 的提醒、审计落库），以及 `firewall.view / manage / cluster` 三档权限边界 |
| `tests/test_hardening.py` | 安全加固：HttpOnly Cookie 凭据与 CSRF 双提交、跨站写请求被拒、WebSocket 同样要凭据、敏感操作二次确认、密码策略、敏感读操作审计 |
| `tests/test_sshguard.py` | SSH 登录安全：日志解析（ISO 与经典 syslog 两种时间戳、跨年推断、pam 与 Failed password 去重、噪声行不计入）、fail2ban 输出解析与 jail 片段生成、策略校验、接口链路（只读统计 / 封禁解封调用参数 / 越权 403），以及**告警**（阈值触发、冷却去重、攻击停止后发恢复通知、陌生 IP 登录告警与「已知 IP」抑制） |
| `tests/test_sshremote.py` | 多机 SSH：主机模型校验（地址白名单、端口、凭据加密与脱敏）、远程命令构造（日志来源与 sudo 前缀）、**回传解析与本机同构**、fail2ban 状态解析与封禁命令形状（非法 jail/IP 根本不发命令）、接口（主机增删改查不泄露凭据、越权 403、fleet 汇总含本机与远程、远程失败只标红该主机） |
| `tests/test_baseline.py` | 安全基线：`login.defs` 解析与就地合并、sshd 配置解析（首个值生效、Include 展开、`sshd -T` 输出）、空口令 / UID 0 识别、评分加权与等级、**一份快照跑完整套判定**（本机与远程同构）、**远程探测命令的分节解析与 sudo / 权限判定**、防火墙与时间同步的远程回退分支、**「别把登录关死」守卫**（root+口令 / 口令认证时拒绝相应加固）、总览排序与摘要、加固「写前备份 + 校验不过自动回滚」、接口链路（总览与主机详情鉴权审计、`host_id` 分发、viewer 可看不可加固、修复失败映射 400） |
| `tests/test_bulk.py` | 批量操作：动作白名单与各动作的必填参数、标签合并（追加去重 / 覆盖 / 清空）、**容器走 lxc 端点而不是 qemu**、目标没带 `type` 时探测、**单台失败只进结果不炸整批**（部分失败仍跑完全部）、删除时「运行中拒绝」、普通用户操作他人机器被拒且**不发出任何 PVE 请求**、管理员不受归属限制、`delete` 要求二次确认、容器快照忽略 `vmstate`、请求模型拒绝空目标与重复目标 |
| `tests/test_lxc.py` | LXC 容器：网卡行（`name=ethN` 按序号分配、静态 IP 带网关、`ip=dhcp` 时不写 `gw=`）、挂载点 `mpN`、创建配置必带 PVE 所需键（rootfs 写「存储:GiB」）、**无网卡时至少补一张 net0**、`features` 白名单过滤、口令与多行 SSH 公钥、`rootfs`/`netN`/`mpN` 的解析不混入 `memory`/`cores`，以及 `name` → `hostname` 的字段别名 |
| `tests/test_portguard.py` | 端口/进程/隔离/备份防护：`ss` 与 `netstat` 双格式解析（含 IPv6、表头过滤）、进程表保留带空格命令行、`/proc/*/exe` 的「已删除」标记、策略收敛（冷却区间 + **非法正则丢弃**）、预期端口的三种写法、**回环监听不算暴露**、敏感端口 / 明文老协议的分级、**反弹 shell 各类特征**（`/dev/tcp`、`nc -e`、`socat exec`、`curl\|sh`、Web 服务派生 shell、`/tmp` 可执行文件、已删除可执行文件、shell 持有对外连接、后门端口）、**误报防护**（`bash -c "curl -i"` 不算交互式 shell、登录会话的 22 端口连接不算反弹、进程白名单生效、非 root 不把「看不到进程」当问题）、`evaluate()` 经 HTTP 走通告警落库与冷却去重、`set_link_down` **属性保留且往返一致**、`net_keys` 数值排序、快照名对 PVE 合法、备份指纹稳定性与大小敏感性、**删除受保护备份被面板拦截**、接口鉴权与审计 |

> 面板只支持 MySQL，`test_api_routes.py` 会连一个**独立的测试库**（默认
> `<DB_NAME>_test`，可用 `TEST_DB_NAME` 指定；账号没有建库权限时请先手工建库），
> 每个用例开始前清空该库的表，不会碰业务库；连不上 MySQL 时这些用例自动跳过。

前端类型检查与构建：

```bash
npm run typecheck     # tsc --noEmit，类型检查
npm run check:graph   # 校验全部模块可解析、相对导入无拼写错误
npm run build         # tsc -b && vite build
npm run verify        # 以上三步一次跑完
```

也可以在没有 Nginx 的情况下验收前端构建产物（内置静态服务器 + `/api` 与
WebSocket 反向代理，用于模拟生产形态）：

```bash
npm run build
npm run serve:dist              # http://localhost:8090
npm run serve:dist -- 9000 http://10.0.0.5:8080   # 自定义端口与后端地址
```

### Proxmox VE 版本兼容

面板对接的是 PVE 的 REST API，**8.x 与 9.x 走同一套代码**，没有按版本分支的功能
（少数字段差异是「有就读、没有就回落」，见下面的 rrddata 说明）。已在 PVE 8.4 与
PVE 9 上实测通过虚拟机 / 容器的创建、启停与控制台。

版本号只用于展示：`/version` 返回的 `pveversion` 形如 `pve-manager/9.0.3/<hash>`，
面板取中间那段显示，不需要跟着 PVE 升级改代码。控制台账号（VNC / 串口）是唯一
与 PVE 版本强相关的配置项 —— PVE 的 websocket 端点只认 `PVEAuthCookie`，不接受
API Token，这个限制 8.x / 9.x 一致。

### 真实集群验证记录

除单元测试外，也已在一个真实的 **Proxmox VE 8.4.0**（单节点 `pve`）上跑通只读联调：

| 接口 | 结果 |
|---|---|
| `/api/health` | `pve_connected: true`，版本 `8.4.0`，节点数 1 |
| `/api/nodes` | 1 个节点在线，CPU / 内存 / 磁盘指标可读 |
| `/api/vms` | 16 台虚拟机（运行中 5 台） |
| `/api/templates` | 正确识别出 3 个模板 |
| `/api/storages` | 读到 `local`（dir，含 images / iso / backup 等内容类型） |
| `/api/dashboard/summary` | 聚合数据与上述一致 |
| `/api/tasks` | 任务列表正常 |

控制台、创建 / 开关机等写操作未在真实环境执行（避免影响线上虚拟机），其参数拼装
由 `tests/` 中的模拟 Proxmox 覆盖。

---

## 六、排查问题

**面板显示「Proxmox 连接未配置」**
去「设置 → Proxmox 连接配置」填写，或用「测试连接」按钮验证。测试失败会返回具体的
HTTP 状态和 PVE 错误信息：`401` 是 token 写错，`595` 通常是证书问题（把「验证 SSL
证书」关掉），连接超时则是防火墙没放通 8006 端口。

**面板能登录，但虚拟机 / 存储列表全是空的**

先点「设置 → 环境自检」。这是 Proxmox API Token 最容易踩的坑：在 Web 界面创建
Token 时默认勾选「特权分离（Privilege Separation）」，**这样的 Token 一开始没有任何
权限**——需要特权的读取返回 `403`，而 `/storage` 这类接口干脆返回 `200` + 空数组
而不是报错。面板只能如实渲染成空列表，看起来就像面板坏了。

自检会直接问 Proxmox 要该凭据的有效权限（`/access/permissions`），把缺什么、
该执行哪条命令列出来，例如：

```bash
pveum acl modify / --tokens 'root@pam!panel' --roles PVEVMAdmin
pveum acl modify / --tokens 'root@pam!panel' --roles PVEDatastoreUser
pveum acl modify / --tokens 'root@pam!panel' --roles PVEAuditor   # 节点指标需要 Sys.Audit
```

判断特征：`pveum token list` 里 `privsep` 为 1，且 `/access/permissions` 返回空，
说明这个 Token 还没有被授予任何 ACL。

**连接报 502，但明明能 ping 通 Proxmox**
检查运行面板的机器是否设置了 `HTTP_PROXY` / `HTTPS_PROXY`。面板默认不继承这些环境
变量（`PVE_TRUST_ENV=false`）；如果确实必须经过代理访问集群，才把它设为 `true`，
否则把 Proxmox 地址加进 `NO_PROXY`。

**面板启动后连不上集群，但配置是对的**
连接配置的优先级是「数据库 > `.env`」。如果之前用别的地址保存过配置，`.env` 里新写的
值不会生效——到「设置」页面改，或删掉数据库 `settings` 表里的 `pve_connection`
记录（`DELETE FROM settings WHERE \`key\` = 'pve_connection';`）后重启。
注意 Proxmox 不可达**不会**阻止面板启动，
只会在日志里留一条警告，这样才有机会进界面把配置改回来。

**创建虚拟机报 `no space left` 或存储相关错误**
检查目标存储池是否支持要用的磁盘格式：LVM / ZFS 只能用 `raw`，`qcow2` 需要
dir / NFS / CIFS 类存储。面板会自动纠正格式，但如果存储已满就只能换池。

**控制台打不开，提示需要账号密码**
这是 Proxmox 的设计限制：API Token 无法访问 `vncproxy` / `termproxy`。
在设置里补一个 PVE 账号密码即可（建议用权限最小的专用账号，仅授予 `PVEVMUser`）。

**控制台连上但黑屏**
云镜像默认不输出到串口。模板构建时面板已自动配置 `serial0` + `vga: serial0`，
若使用的是手工建的模板，需要在 PVE 里补上这两项，或改用 noVNC 图形控制台。

**模板构建卡在 importdisk**
镜像必须放在 dir / NFS / CIFS 存储上。用 LVM 或 ZFS 存放 `.img` 文件会导致这一步失败，
且失败时面板会自动清理临时虚拟机。

**任务一直显示「运行中」**
点进「任务队列」查看实时日志，重启虚拟机等操作耗时较长属正常。
若日志停在某一步，通常是存储 I/O 慢或 `qemu-guest-agent` 未安装导致优雅关机超时 ——
可以改用「强制停止」。

---

## 七、安全说明

1. **`SECRET_KEY` 与管理员口令必须换掉（后端会强制）**。`SECRET_KEY` 既是 JWT 的签名
   密钥、也是库里密文的加密根，留占位值或短于 32 位会**直接拒绝启动**；首次建号用的
   `ADMIN_PASSWORD` 留空、短于 12 位或为 `admin123` 之类同样**拒绝启动**（已建好的存量
   弱口令只在启动日志里告警，需登录后在「设置」里自行修改）。
2. **面板必须套 HTTPS**。登录凭据和 API Token 都以明文在 HTTP 上传输：把
   `FORCE_HTTPS=true` 打开（明文 308 跳转 + HSTS），并由 Nginx/Caddy 在 `443` 终结 TLS。
   反代需带上 `X-Forwarded-Proto`，且 `FORWARDED_ALLOW_IPS` 只保留本机反代地址 —— 否则
   公网请求可以自称「我是 https」绕过强制跳转。同时开启 `PVE_VERIFY_SSL`（默认已开），
   避免面板与 PVE 之间被中间人截走 API Token。
3. **给 PVE 用户最小权限**。`--privsep 1` 配合精确的 ACL 可以让面板只碰它该碰的资源。
4. **Token Secret 在前端是脱敏的**。`GET /api/config/connection` 只返回
   `token_secret_set: true/false`，不回传明文；更新时留空即保持原值。
5. **控制台权限独立控制**。`vm.console` 是单独权限，可让普通用户能开关机但不能看控制台。
6. **PVE 的 8006 端口无需对外暴露**。全部流量经面板后端转发，PVE 可以只对内网开放。
7. **登录验证 + 防爆破 + 全局限流**。连续失败 `LOGIN_MAX_FAILURES`（默认 5）次即锁定
   `LOGIN_LOCKOUT_MINUTES` 分钟，**账号与来源 IP 双维度计数，数据落 MySQL**
   （重启不清零、多进程共享）。全局限流按来源 IP 统计 `/api/*` 请求
   （默认 300/分钟，登录/注册/找回密码/刷新的敏感入口 30/分钟），超限返回 `429` +
   `Retry-After`。计数只信可信反代传来的 `X-Forwarded-For`（见 `FORWARDED_ALLOW_IPS`），
   客户端自己伪造这个头绕不过限流。

   登录页另有一道人机验证，在**「设置 → 登录验证」**里三选一，保存后立即生效：

   | 方式 | 说明 |
   |---|---|
   | 关闭 | 不校验。仅适合内网或纯人用的环境，公网可达的面板不建议 |
   | 图形验证码（默认） | 四位字符，服务端画图，答案只在进程内存 |
   | 拖动滑块 | 把拼图块拖到缺口上，位置答案同样只留内存（±6px 容差） |

   验证码排在**校验密码之前**：脚本摸不到「密码对不对」这个信号，就得先解验证码；
   而验证码没过**不计入失败次数** —— 否则拿一张错图（或一个错误位置）反复提交就能
   把任意账号锁死。改这个设置需要 `settings.manage` 并且要过二次确认（关掉验证码
   等于降低整个面板的登录门槛）。`LOGIN_CAPTCHA=0` 仍可作为环境变量兜底：在线配置
   没设过时以它为准，所以已经关掉验证码的存量部署升级后不会被重新打开。
8. **真正的登出与会话管理**。登录会同时签发 access token（12 小时）与 refresh token
   （14 天，放 `HttpOnly` Cookie）。登出 = 撤销服务端会话，**当次令牌立刻失效**，
   不是只清浏览器缓存；access token 过期时前端会用 Cookie 自动换新，所以可以把
   `ACCESS_TOKEN_EXPIRE_MINUTES` 调到 `60` 而不用反复登录。「个人中心 → 登录设备」
   能看到每台设备并可逐个踢下线，「退出所有设备」或管理员在「用户管理」里踢人都会
   把会话版本 +1，令该账号所有已发出的令牌立即作废。改密码、自助重置密码同样会
   踢掉其它设备。
9. **两步验证（TOTP）人人可开，角色可强制**。`TOTP_REQUIRED_ROLES=admin` 表示管理员
   必须先绑定认证器（未绑定前除 2FA 相关接口外一律 `403`）；填 `admin,operator` 可
   覆盖更多角色，留空则全员可选。「个人中心 → 两步验证」扫码绑定，会一次性给出 8 张
   恢复码（只显示一次，用完即废）。TOTP 密钥用 `SECRET_KEY` 加密后落库，登录、改密码、
   关闭 2FA 都要求动态码 —— 光有密码或只有一枚被盗的 token 都不足以接管账号。
10. **凭据只放 HttpOnly Cookie，写操作要过 CSRF**。三枚 Cookie 都在服务端：`panel_access`
   （访问令牌，`Path=/api`）、`panel_refresh`（刷新令牌，`Path=/api/auth`）都是 HttpOnly
   + `SameSite=Lax` + （HTTPS 下）`Secure`，**JavaScript 读不到**，XSS 也就偷不走；
   只有 `panel_csrf` 故意可读，前端把它回填进 `X-CSRF-Token`，所有 POST/PUT/PATCH/DELETE
   都要对得上才放行（跨站页面读不到这枚 Cookie，伪造不出来）。WebSocket 握手同样用
   Cookie 鉴权并校验 `Origin`，令牌不再出现在 URL 里（避免漏进 Nginx 日志与浏览器历史）。
   用 `Authorization` 头的脚本客户端不受 CSRF 限制（它没有环境凭据）。
11. **密码强度全局统一**。管理员建号、自助注册、改密、重置密码共用一套规则：
   ≥ 8 位、同时含字母与数字、不在常见弱口令表里；建号时只有 6 位的老下限已经取消。
   首次安装的 `ADMIN_PASSWORD` 另按「≥ 12 位且非默认值」更严的标准把关。
12. **敏感读取也进审计**。除了写操作，查看连接配置 / 连接列表、探测连接状态、查看邮件
   配置与飞书机器人配置、翻阅审计日志本身都会记一条（`config.connection.read`、
   `audit.read` 等）—— 「谁把集群 Token 抄走了」这类问题只能靠读操作的痕迹回答。
13. **危险操作要二次确认（step-up）**。删除虚拟机、删除备份归档、建/改/删 PVE 连接、
   改邮件口令、增删账号 / 审批注册 / 踢设备下线、改集群级防火墙策略 / 建删安全组与
   IP 集合 / 批量下发防火墙规则、改 SSH 异常登录策略 / 写 fail2ban 封禁策略这些操作，
   即便手里的 token 还在有效期内也不够：后端返回
   `403 + X-Step-Up: required`，前端弹出确认框要求重输密码（开了两步验证还要动态码或
   恢复码），通过后本次会话在 `STEP_UP_WINDOW_MINUTES`（默认 5）分钟内免重复确认。
   可用 `STEP_UP_REQUIRED=false` 关闭，但不建议在生产这么做。

---

## 八、后续迭代计划

> 这一节写「下一版做什么、为什么、什么情况下才做」，**不代表排期承诺**。
> 优先级排序的依据是：① 用户已经明确提出；② 能把现有能力补完整（而不是再加
> 一个孤立的功能）；③ 扩展边界但不会动摇现有架构。

### 8.1 SDN 虚拟网络适配（最高优先级）

**现状**：面板的「网络」页（`backend/app/routers/network.py`）管的是**节点级**
Linux Bridge / Bond / VLAN，也就是 PVE 里最传统的那套；虚拟机网卡只能填
`bridge=vmbr0`。PVE 8.x / 9.x 引入的 **SDN**（软件定义网络）目前完全没有入口 ——
用了 SDN 的环境只能回 PVE 原生界面配，这恰好是本面板想要替代的那部分操作。

**SDN 与现有网络页的本质区别**（这决定了不能照抄现有实现）：SDN 是**集群级对象**
（zone / vnet / subnet / controller / IPAM / DNS），一份配置作用于整个集群；而
bridge / bond 是**节点级**对象，同一个 `vmbr0` 在每个节点上各存一份。客户端接入
方式也不同：SDN 里虚拟机写的是 **vnet 名**（`bridge=myvnet`），不是 bridge 名。

**计划内容**：

- **网络域（zone）**：`simple` / `vlan` / `qinq` / `vxlan` / `evpn` 五类的创建与
  参数编辑（MTU、VLAN 感知、VXLAN 的对端 IP、EVPN 的控制器绑定）；
- **虚拟网络（vnet）与子网（subnet）**：vnet 的 zone 归属、别名、VLAN 标签；
  子网 CIDR、网关、DHCP 范围、DNS 区域；IPAM 记录的地址分配与回收；
- **控制器 / IPAM / DNS**：列表与配置（`evpn` 控制器、`pve` 内置 IPAM 等）；
- **挂载点检查**：删 vnet / 改 zone 前，先扫一遍所有 VM 与 LXC 的网卡配置
  （`vmconfig.py` 已能解析 `netN`），把「还有 N 台机器挂在这上面」列出来再让用户
  决定 —— 这一步是**必须有**的，否则一改就断一片机器的网络；
- **变更暂存与「应用配置」**：PVE 的 SDN 改动同样先落 pending、再 apply/reload。
  交互沿用现有网络页「待应用」的那套语义（改动排成队列，diff 出来，点一次应用），
  避免两处行为不一致；
- **与防火墙联动**：SDN 的 vnet 与现有的 IP 集合 / 安全组（`firewall` 模块已经封装
  了 `ipset` / `group`）可以互相引用，界面上给出跳转，而不是各配各的；
- **权限与审计**：PVE 侧是 `SDN.Allocate` / `SDN.Use` / `SDN.Audit`；面板侧建议新增
  `sdn.view`（普通角色可见）/ `sdn.manage`（默认仅管理员 —— 改错 zone 会影响整个
  集群）。应用配置、建删 vnet/zone 一律二次确认 + 审计。

**验收标准**：在真实 PVE 8.x / 9.x 上完成「建 zone → 建 vnet → 建子网 → 把某台
虚拟机的网卡切到该 vnet → 应用配置 → 虚拟机网络通」的完整链路，并且删除仍有机器
挂载的 vnet 时会被面板拦下。

**风险**：SDN 改动的作用范围是整个集群，比节点级网络危险得多；实现时的底线是
「读」永远可用、「写」必须有 diff 预览与二次确认，并且**不提供**「一键重建 SDN」
这类不可回滚的动作。

### 8.2 计费与用量（可选模块）

**现状**：面板已经有全局容量配额（`backend/app/quota.py`，只回答「还能开几台」）
和**指标历史落库**（`metrics_history`，默认 60 秒一采样、保留 30 天）。也就是说
「计量」的数据源已经在了，缺的是「按谁、按多少、值多少钱」。

**为什么值得做**：做成对外提供虚拟机的场景时，「谁用了多少资源、该付多少」是必须
回答的问题，而现在只能靠人去 PVE 界面里截图核对。

**计划内容**：

- **计量口径**（这部分必须先在页面上写清楚，不能含糊）：
  - 计算资源：`CPU 核·小时` / `内存 GiB·小时`，按运行时长累计；关机时段是否计费
    做成开关（**已分配口径** vs **实际使用口径**，两种都很常见，不能写死一种）；
  - 存储：`磁盘 GiB·天`（取 VM 配置里的 `size`，扩容当天按新高计算）；
  - 备份与快照：备份卷容量按保留周期累计，快照按存在时长累计；
  - 网络：PVE 给的是**累计计数器** `netin` / `netout`，会因虚拟机重启、迁移、
    驱动重置而归零 —— 必须靠采样差分并把「计数器回退」的样本丢弃，
    不然会算出负数或暴涨的流量。这一条是本模块最容易做错的地方；
- **计费模型**：单价表（可按 PVE 连接 / 节点 / 资源池 / 用户组分别定价）、
  包月与按量、阶梯价、资源包与抵扣、最低消费；单价表要带生效时间，
  历史账单用**当时的单价**重算，不能拿今天的价格改昨天的账；
- **出账**：月度账单**快照**（预计算并冻结，而不是每次打开页面现算 —— 现算在数据
  保留期到期后会对不上），支持导出 CSV / PDF 与邮件推送（邮件通道已有）；
- **与配额联动**：欠费 → 宽限期提醒 → 自动停机（**绝不自动删除**），恢复缴费后
  一键开机；这个动作同样要二次确认与完整审计；
- **多租户**：账单按用户出，管理员可看全量；普通用户只看自己的（沿用现有的
  「监控与集成按用户隔离」那套归属规则）。

**验收标准**：给定一个月的历史数据，账单金额可复算且可解释到「哪台机器、哪个
计费项、什么单价、多少单位」。

**风险与边界**：60 秒采样得到的是**估算值**，不是运营商级账单。页面上必须明确标注
口径与误差来源，避免用户拿它去对账产生纠纷。

### 8.3 其他候选（按主题，不等同排期）

| 主题 | 内容 | 触发条件 / 依赖 |
|---|---|---|
| **多租户与资源池** | 按 PVE `pool` 组织资源视图、把配额从「全局」下沉到「按用户 / 按池」 | 有对外提供资源的场景时（与 8.2 天然配套） |
| **报表订阅** | 周报 / 月报邮件：资源用量、告警统计、容量趋势与写满预测 | 数据源已齐（`metrics_history` + 磁盘容量预测），只差聚合与模板 |
| **备份可验证** | 对接 PBS、定期恢复演练、备份完整性核对 | 现在的 `backupguard` 只能比对「卷还在不在、元数据变没变」，做不到真正的可恢复性验证 |
| **告警通道扩展** | 企业微信 / 钉钉 / Telegram / Slack + 通用 Webhook 出口 | 现在只有飞书 + 邮件；通用 Webhook 一次就能覆盖大部分自建场景 |
| **可观测性** | `/api/metrics` 导出 Prometheus 格式 + 附带 Grafana 面板 | 想把面板接入现有监控体系时 |
| **审计与合规** | 审计日志外送 SIEM（syslog / HTTP）、操作导出、只读审计员角色 | 等保 / 内控要求时 |
| **单点登录** | LDAP / OIDC / SAML 对接，保留本地账号作为兜底 | 企业内部统一身份；需先明确「角色从目录映射还是面板分配」 |
| **控制台体验** | 移动端手势（双指缩放、拖拽）、多标签页、会话录制与回放 | 现有 noVNC / xterm 已可用，属体验增强 |
| **部署形态** | Dockerfile / docker-compose、Helm chart、离线安装包 | 现在只有 systemd + `deploy.sh`；容器化要注意控制台 WebSocket 与 `FORCE_HTTPS` 的配合 |
| **工程化** | GitHub Actions（pytest + `npm run verify`）、覆盖率门禁、Playwright 端到端用例 | 越早做收益越大；注意现有测试依赖 MySQL，CI 里要单独起一个测试库 |
| **前端** | 亮色主题切换、中英双语（i18n）、PWA 离线壳 | 现在只有深色主题与中文；i18n 要趁字符串还没散得太开时做 |
| **性能** | 图表按需加载（`charts` chunk 已 434 KB）、大盘首屏分批渲染、PVE 请求合并与连接池 | 面板节点 / 虚拟机数量上到几百时 |
| **部署简化** | 评估单机免 MySQL 形态（内置 SQLite）或 PostgreSQL 支持 | 降低「先装一个数据库」的试用门槛；需先评估现有 SQL 与迁移逻辑的改动量 |
