# 经 frp 暴露的主机如何记录真实来源 IP

面板的主机登录审计（`host.ssh_failed` / `host.ssh_login`）从每台受管主机的
`last` / `lastb` 里取来源地址。如果一台主机的 22 端口经 frp 暴露到公网，frpc 是
从**入口机**回连目标 sshd 的，sshd 只能看到入口机地址（比如 `172.16.149.3`），
真实攻击来源在这一层就丢了。

解决办法：让 frpc 不要直连目标 sshd，而是先连到入口机的 haproxy（`accept-proxy` +
PROXY protocol v2），由 haproxy 把真实来源写进自己的日志，面板再按时间把审计里的
入口机地址换回真实 IP。这也是「面板自动发现主机映射、不改任何面板配置」的前提。

链路：

```
公网 → frps → frpc(入口机) → 入口机 haproxy(accept-proxy) → 目标 sshd
                                  └─ 日志记下真实来源 IP
```

面板本机、以及任何「要走公网、又要看到真实来源」的机器，都按这一套接进来。

## 前置条件

1. 面板的环境变量 `SSH_FORWARD_LOG_HOST` 已指向入口机（在「SSH 远程」里的主机 id）。
   不填它，面板不会做真实 IP 还原。多台入口机映射可另配 `SSH_FORWARD_ROUTES`，
   见下文「显式指定映射」。
2. 入口机能被面板 SSH 登录（读 haproxy 配置、跑 `hostname -I`、翻 haproxy 日志）。
3. 入口机上已经跑着 haproxy 和 frpc。

## 操作步骤（以新机器为例）

下面以「内网 IP 172.16.149.60、sshd 在 22、想暴露到公网端口 36002」为例。所有
命令都在**入口机**上执行。

### 1. haproxy 加一条转发

编辑 `/etc/haproxy/haproxy.cfg`，末尾追加（`bind` 端口选一个没被占用的本地端口，
这里用 `12225`）：

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
`host` / `port` 配对的。

校验并重载：

```bash
haproxy -c -f /etc/haproxy/haproxy.cfg && systemctl reload haproxy
```

### 2. frpc 加一条代理

编辑 frpc 配置（当前部署在 `/data/frp/frpc.toml`），追加一条：

```toml
[[proxies]]
name = "myhost-tcp"
type = "tcp"
localIP = "127.0.0.1"
localPort = 12225
remotePort = 36002
transport.proxyProtocolVersion = "v2"
```

要点：

- `localPort` 必须等于上面 haproxy 的 `bind` 端口（`12225`）。
- `transport.proxyProtocolVersion = "v2"` **不能少**，少了 haproxy 收不到真实来源。
- `remotePort` 是 frps 上的公网端口，全局唯一，别和已有代理撞。

重启并确认代理建立：

```bash
systemctl restart frpc && journalctl -u frpc -n 5 --no-pager
```

看到 `[myhost-tcp] start proxy success` 即可。

### 3. 面板里把机器加为受管主机

「SSH 远程」新增这台机器，关键字段：

- **host**：填内网 IP `172.16.149.60`（面板自动发现用它跟 haproxy 的
  `server <地址>:22` 对上）。
- **port**：填 `22`（要和 haproxy backend 的端口一致）。

其余照常。面板的自动发现缓存 5 分钟内刷新，之后这台机器的登录审计就会还原真实来源
IP，**不用改任何面板配置**。

## 端口约定与避坑

| 端口 | 含义 | 要求 |
| --- | --- | --- |
| `remotePort` | frps 上的公网端口 | 全局唯一 |
| `localPort` = haproxy `bind` 端口 | 入口机本地端口 | 入口机本地唯一 |
| `22` | 目标 sshd 端口 | = haproxy `server` 端口 = 受管主机的 `port` |

三个端口里只有最后一个跟 sshd 真实端口一致，前两个只是「中转口」，别混。

常见坑：

- frpc 的 `localIP` 写成了目标内网 IP（直连 sshd），没指到 haproxy —— 这样真实来源
  又丢了。必须写 `127.0.0.1`（或入口机上 haproxy `bind` 的地址）。
- 忘了 `transport.proxyProtocolVersion = "v2"`。
- haproxy 改完只 `reload`、frpc 改完忘 `restart`。
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
  haproxy 日志已滚动出去（连接结束得太早/太晚），或 frontend 名没对上。

## 显式指定映射（不想动 frpc 时）

某些部署不便改 frpc（端口被别的东西占用、或 frp 由第三方管理），可以用面板的
`SSH_FORWARD_ROUTES` 显式告诉面板「哪台主机的登录走哪条 frontend」，格式见
`backend/.env.example` 里该变量的注释。正常情况下走上面的自动发现即可，不需要这个。
