# 经 frp 暴露的主机如何记录真实来源 IP

面板的主机登录审计（`host.ssh_failed` / `host.ssh_login`）从每台受管主机的
`last` / `lastb` 里取来源地址，「SSH 登录安全」页则读面板本机的 `auth.log` /
`secure`。只要这台机器的 22 端口是经 frp 暴露到公网的，这两处的来源都会变成
**入口机地址**（比如 `172.16.149.3`），真实攻击来源在这一层就丢了。

本方案用「frpc 的 PROXY protocol v2 + 入口机 haproxy 的 `accept-proxy`」把真实
来源在入口机上截下来写进日志，面板再按时间关联回审计。配置一次，之后新增机器只需
照抄三条配置，面板侧不用改任何东西。

## 原理

### 1. 为什么 sshd 看不到真实 IP

没有代理时，攻击者直连 sshd，sshd 看到的源地址就是攻击者的地址。加了 frp 之后
链路变成：

```
公网攻击者 → frps（公网） → frpc（入口机） → 目标 sshd
```

frpc 是用**入口机自己的地址**去连目标 sshd 的，所以 sshd（以及 `lastb`、`auth.log`）
里记录的来源永远是入口机地址。frp 本身知道真实客户端是谁（frps 收到连接时能看到），
但普通的 frp TCP 代理不会把这个信息往下传。

### 2. PROXY protocol 与 haproxy 的角色

frp 支持把真实客户端地址用 [PROXY protocol](https://www.haproxy.org/download/2.4/doc/proxy-protocol.txt)
传给后端：在 `[[proxies]]` 里加 `transport.proxyProtocolVersion = "v2"`，frpc 连接
后端时就会先发一个带真实地址的协议头。

问题是 **OpenSSH 不认识 PROXY protocol**，直接把它指给 sshd 会握手失败。所以中间
必须有一个能解析它的组件——就是 haproxy：

```
frpc ──(PROXY protocol v2)──> haproxy(accept-proxy)
                                 ├─ 解析出真实客户端 IP，用 option tcplog 写进日志
                                 └─ 剥掉协议头，原样 TCP 转发给目标 sshd
```

haproxy 的 `bind ... accept-proxy` 表示「这个监听口收到的连接带 PROXY 协议头，先解析」。
解析出来的真实地址只存在于 haproxy 内部，sshd 侧仍然是入口机地址——所以**haproxy 的
日志是唯一能拿到真实 IP 的地方**，这也是面板要读它的原因。

### 3. 面板怎么把入口机地址换回真实 IP

面板不猜、不做端口探测，而是拿两份数据按时间对齐（实现见
[`app/sshforward.py`](../backend/app/sshforward.py)）：

1. **审计侧**：从目标主机读 `lastb`，得到「某时刻、某用户、来源 = 入口机地址」。
2. **入口机侧**：从 haproxy 日志读每条连接，格式大致是

   ```
   66.132.172.214:41580 [27/Oct/2026:04:07:23.672] ssh_in ssh_panel/panel 1/0/4052 ...
   ```

   行首是真实客户端 `IP:端口`，方括号是连接建立时间，第三个字段是 frontend 名，
   `Tq/Tw/Tc` 里的 `Tc` 是连接总时长（毫秒）。

匹配规则（`resolve()`）：

- **只看该主机的 frontend**：面板读入口机的 `haproxy.cfg`，按
  `frontend → default_backend → backend 里的 server <地址>:端口` 自动算出「这台
  主机走哪几条 frontend」，再跟受管主机的 `host` / `port` 对上。所以换网段、加机器、
  改 frontend 名字都不用改面板配置。
- **连接必须覆盖失败时刻**：`连接建立时间 <= 失败时间 + 2s`，且
  `连接建立时间 + Tc >= 失败时间 - 2s`，即失败发生时这条连接还是打开的。
- **不能隔太久**：失败时间与连接建立时间相差不超过 180 秒（bot 的连接能活十几秒，
  同一条连接里会连试多个用户名）。
- 同时有多条满足时，取**最晚建立**的那条。

成功登录用更严的 `resolve_login()`：还要求连接的生命周期和会话起止时间对得上，
否则爆破期间「时间最近」几乎必然配到别人的连接。

还原成功后，审计记录的 `ip` 换成真实地址，原始入口机地址保留在 `detail.forwarded_from`；
实在配不上的会标 `unresolved_from`，表示「来源被入口机遮掉了但没能还原」。

### 4. 口径：哪些页面能用上

| 页面 | 数据来源 | 是否还原 |
| --- | --- | --- |
| 审计日志（`host.ssh_failed` / `host.ssh_login`） | 各受管主机的 `lastb` / `last` | 是，按主机各自的 frontend |
| SSH 登录安全（失败来源排行、登录记录） | **面板本机**的 `auth.log` / `secure` | 是，固定用面板本机的 frontend |

「SSH 登录安全」只覆盖面板所在的那台机器（这是该模块的设计：不依赖额外凭据，只读
本机日志）。集群里其它主机的登录情况看审计日志。

## 链路

```
公网攻击者 → frps → frpc(入口机) → 入口机 haproxy(accept-proxy) → 目标 sshd
                                        │
                                        └─ 日志记下真实来源 IP（面板按时间关联）
```

## 前置条件

1. 面板的环境变量 `SSH_FORWARD_LOG_HOST` 指向入口机（在「SSH 远程」里的主机 id）。
   不填它，面板不会做任何还原。多台入口机可用 `SSH_FORWARD_ROUTES` 显式指定，见文末。
2. 面板能 SSH 登录入口机，且该账号能：
   - `cat /etc/haproxy/haproxy.cfg`（自动发现要读配置）；
   - `journalctl -u haproxy`（要读连接日志）；
   - `hostname -I`（要拿入口机地址）。
   非 root 账号通常需要 sudo 或用 `systemd-journal` / `adm` 组，否则读不到日志。
3. 入口机上跑着 haproxy 和 frpc。

## haproxy 部署方案

入口机上的 haproxy 只做一件事：接住 frpc 投递过来的连接、解析 PROXY protocol
拿到真实来源、写进日志，再把 TCP 原样转给目标 sshd。它不监听公网，也不需要证书。

### 1. 安装

Debian / Ubuntu：

```bash
apt update && apt install -y haproxy
haproxy -v
```

RHEL / CentOS / Rocky：

```bash
dnf install -y haproxy
```

装完配置文件在 `/etc/haproxy/haproxy.cfg`，systemd 服务名 `haproxy`。

### 2. 写配置（完整样例）

把 `/etc/haproxy/haproxy.cfg` 写成下面这样。示例里已经有两条转发：面板本机
（`ssh_in`）和一台 `172.16.149.8`（`ssh_in_8`），新增机器照抄后面一段即可。

```haproxy
global
    # 日志写到 stdout，systemd 会收进 journal —— 面板就是从这里读的。
    # 千万不要只写 log /var/log/haproxy.log，那样面板读不到。
    log stdout format raw local0
    maxconn 2000

defaults
    log     global
    mode    tcp
    # 必须：TCP 日志会输出 Tq/Tw/Tc（Tc = 连接总时长，毫秒），
    # 面板靠它判断「失败发生时这条连接是否还开着」。
    option  tcplog

    timeout connect 5s
    # SSH 会话可能开很久，client/server 超时给足
    timeout client  1h
    timeout server  1h

# ── 面板本机 ─────────────────────────────────────────────
# frpc 的 kvm-web 代理把 PROXY protocol v2 发到这个口
frontend ssh_in
    bind 172.16.149.3:12222 accept-proxy
    default_backend ssh_panel

backend ssh_panel
    # 面板 sshd 的真实内网地址:端口（面板自动发现靠它配对）
    server panel 172.16.149.17:22

# ── 172.16.149.8（个人工作台）─────────────────────────────
# frpc 的 pve3-blog-8 代理发到这个口
frontend ssh_in_8
    bind 127.0.0.1:12223 accept-proxy
    default_backend ssh_wb8

backend ssh_wb8
    server wb8 172.16.149.8:22
```

新增一台机器就是再加一对 `frontend` / `backend`（见下文「新增一台机器的操作步骤」）。
`bind` 选一个没被占用的本地端口，`server` 写目标 sshd 的真实内网地址和 22。

### 关键指令

| 指令 | 作用 | 少了会怎样 |
| --- | --- | --- |
| `log stdout format raw local0` | 日志进 journal，面板可读 | 面板读不到日志，永远还原不了 |
| `option tcplog` | 输出连接时长 `Tc` | 无法判断连接是否覆盖失败时刻，匹配失败 |
| `mode tcp` | SSH 是 TCP 代理 | 按 HTTP 模式解析会直接坏掉 |
| `bind ... accept-proxy` | 解析 PROXY protocol 头，取出真实 IP | 没有协议头时连接会被拒；去掉它也拿不到真实地址 |
| `default_backend` + `server <地址>:端口` | 指向真实 sshd；面板靠它自动发现 | 该主机对不上 frontend，审计里仍是入口机 IP |

> `accept-proxy` 只加在**由 frpc 投递**的监听口上。别把 haproxy 直接暴露到公网再让
> 外部客户端连——外部客户端不会发 PROXY 协议头，连接会失败。

### 3. 启动 / 重载

```bash
# 先校验配置，语法错了不要动线上
haproxy -c -f /etc/haproxy/haproxy.cfg

# 首次：开机自启 + 立即启动
systemctl enable --now haproxy

# 之后改配置（加 frontend / 改 server）只需平滑重载，已有连接不断
systemctl reload haproxy

# 看状态
systemctl status haproxy --no-pager
ss -ltnp | grep -E '12222|12223'
```

`reload` 失败不会影响正在跑的旧进程；`systemctl status` 或
`journalctl -u haproxy -n 20 --no-pager` 里会有具体报错。

### 4. 确认日志能被读到

```bash
journalctl -u haproxy -n 5 -o cat --no-pager
```

正常情况下应看到类似：

```
66.132.172.214:41580 [27/Oct/2026:04:07:23.672] ssh_in ssh_panel/panel 1/0/4052 1269 -- 3/1/0/0/0 0/0
```

行首就是真实客户端 IP。如果为空：

- `haproxy.cfg` 里有没有 `log stdout format raw local0`（不是写文件）；
- 有没有 `option tcplog`；
- 有没有连接真的进来过（先对 frps 的公网端口连一次 ssh）。

日志同时可以验证「面板能不能读」：用面板配置的那个 SSH 账号登录入口机执行上面这条
命令，读不到就是权限问题（非 root 账号需要 `systemd-journal` / `adm` 组或 sudo）。

### 日志保留

haproxy 的日志落在 journal 里，面板每次只回溯**最近 6 小时**（`sshforward.LOOKBACK`）：

- 6 小时内发生的失败，能还原；
- 更早的记录，入口机日志里已经找不到对应连接，面板会保留入口机地址（审计里标
  `unresolved_from`）。

想回溯更久，需要把 `LOOKBACK` 调大并保证 journal 保留期足够（`journalctl
--vacuum-time`），代价是每次导入要拉更多日志。

## 新增一台机器的操作步骤

以「内网 IP 172.16.149.60、sshd 在 22、暴露到公网端口 36002」为例，命令都在**入口机**上执行。

### 1. haproxy 加一条转发

```haproxy
# 172.16.149.60 的 22：frpc 用 PROXY protocol v2 把真实来源带进来，
# haproxy 记进日志（frontend 名 ssh_in_60），面板按时间关联回审计
frontend ssh_in_60
    bind 127.0.0.1:12225 accept-proxy
    default_backend ssh_myhost

backend ssh_myhost
    server myhost 172.16.149.60:22
```

`server` 的地址端口必须是目标 sshd 的真实地址端口，面板就是拿它跟受管主机的
`host` / `port` 配对的。校验后 reload：

```bash
haproxy -c -f /etc/haproxy/haproxy.cfg && systemctl reload haproxy
```

### 2. frpc 加一条代理

```toml
[[proxies]]
name = "myhost-tcp"
type = "tcp"
localIP = "127.0.0.1"
localPort = 12225
remotePort = 36002
transport.proxyProtocolVersion = "v2"
```

- `localPort` 必须等于 haproxy 的 `bind` 端口；
- `transport.proxyProtocolVersion = "v2"` 不能少；
- `remotePort` 是 frps 上的公网端口，全局唯一。

```bash
systemctl restart frpc && journalctl -u frpc -n 5 --no-pager
```

看到 `[myhost-tcp] start proxy success` 即可。

### 3. 面板里把机器加为受管主机

「SSH 远程」新增这台机器：

- **host**：填内网 IP `172.16.149.60`（面板自动发现用它跟 haproxy 的
  `server <地址>:22` 对上）；
- **port**：填 `22`（与 haproxy backend 端口一致）。

其余照常。面板自动发现缓存 5 分钟内刷新，之后这台机器的登录审计就会还原真实来源
IP，**不用改任何面板配置**。

## 端口约定与避坑

| 端口 | 含义 | 要求 |
| --- | --- | --- |
| `remotePort` | frps 上的公网端口 | 全局唯一 |
| `localPort` = haproxy `bind` 端口 | 入口机本地端口 | 入口机本地唯一 |
| `22` | 目标 sshd 端口 | = haproxy `server` 端口 = 受管主机的 `port` |

三个端口里只有最后一个跟 sshd 真实端口一致，前两个只是「中转口」，别混。

常见坑：

- frpc 的 `localIP` 写成了目标内网 IP（直连 sshd），没指到 haproxy —— 真实来源又丢了。
  必须写 `127.0.0.1`（或入口机上 haproxy `bind` 的地址）。
- 忘了 `transport.proxyProtocolVersion = "v2"`。
- haproxy 改完只 `reload`、frpc 改完忘 `restart`。
- haproxy 只写了 `log /var/log/haproxy.log`，没进 journal —— 面板读不到。
- 受管主机的 `host` 填了域名/公网地址，跟 haproxy `server` 的内网 IP 对不上。

## 验证

1. 从公网对 `remotePort` 发起一次连接（或等一次失败尝试）。
2. 入口机上 `journalctl -u haproxy -o cat --no-pager` 应能看到对应 frontend 的记录，
   行首就是真实来源 IP。
3. 面板「审计日志」里该主机的 `host.ssh_failed` / `host.ssh_login` 的 IP 应该是真实
   来源，而不是入口机地址。

## 没生效怎么排查

- 面板日志里搜 `入口机 haproxy 里发现`，确认自动发现跑起来了、且把该主机地址映射
  上了。若提示「读不到入口机 haproxy 配置」，检查面板对入口机的 SSH 是否通、配置
  路径是否可读。
- 若日志提示「登录来源是入口机 … 但没匹配到任何 haproxy 转发映射」，说明这台主机
  经 frp 直连了 sshd、没走 haproxy —— 回到上面的步骤 1 / 2 补上。
- 记录里带 `unresolved_from` 表示面板知道来源被入口机遮掉了但没能还原，多半是
  haproxy 日志已滚动出去（超过 6 小时），或 frontend 名没对上。
- `journalctl -u haproxy` 没有任何记录：检查 `log stdout format raw local0` 与
  `option tcplog` 是否配了、haproxy 是否真的 reload 过。

## 显式指定映射（不想动 frpc 时）

某些部署不便改 frpc（端口被别的东西占用、或 frp 由第三方管理），可以用面板的
`SSH_FORWARD_ROUTES` 显式告诉面板「哪台主机的登录走哪条 frontend」，格式见
`backend/.env.example` 里该变量的注释。正常情况下走上面的自动发现即可，不需要这个。
