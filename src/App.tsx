/* ==========================================================================
   ProxCenter — 路由与鉴权守卫
   ========================================================================== */

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui/Spinner';
import { useAuth } from './hooks/useAuth';
import { useSiteInfo } from './hooks/useSiteInfo';

import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
import { Dashboard } from './pages/Dashboard';
import { VirtualMachines } from './pages/VirtualMachines';
import { Containers } from './pages/Containers';
import { VmDetail } from './pages/VmDetail';
import { LxcDetail } from './pages/LxcDetail';
import { Templates } from './pages/Templates';
import { Nodes } from './pages/Nodes';
import { NodesConnections } from './pages/NodesConnections';
import { NodeDetail } from './pages/NodeDetail';
import { Storages } from './pages/Storages';
import { Networks } from './pages/Networks';
import { Firewall } from './pages/Firewall';
import { SshSecurity } from './pages/SshSecurity';
import { SshSecurityConfig } from './pages/SshSecurityConfig';
import { SecurityBaseline } from './pages/SecurityBaseline';
import { PortGuard } from './pages/PortGuard';
import { IncidentResponse } from './pages/IncidentResponse';
import { HostAudit } from './pages/HostAudit';
import { Snapshots } from './pages/Snapshots';
import { Backups } from './pages/Backups';
import { Tasks } from './pages/Tasks';
import { Frp } from './pages/Frp';
import { Alerts } from './pages/Alerts';
import { Certificates } from './pages/Certificates';
import { Users } from './pages/Users';
import { AuditLog } from './pages/AuditLog';
import { Settings } from './pages/Settings';
import { Scheduler } from './pages/Scheduler';
import { Profile } from './pages/Profile';
import { Landing } from './pages/Landing';
import { FeishuBot } from './pages/FeishuBot';
import { NotFound } from './pages/NotFound';

/* ---------------------------------------------------------------------------
   全屏加载态
   --------------------------------------------------------------------------- */

function FullPageLoader() {
  return (
    <div className="notfound" role="status" aria-label="正在校验登录状态">
      <Spinner size={30} label="正在校验登录状态" />
      <div className="text-secondary">正在校验登录状态…</div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   路由守卫
   --------------------------------------------------------------------------- */

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, initializing } = useAuth();
  const location = useLocation();

  if (initializing) return <FullPageLoader />;

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}

/* 仅管理员可访问 */
function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

/**
 * 需要指定权限才能访问。
 *
 * 侧边栏早就按权限隐藏了这些入口，但路由本身一直没拦 —— 于是「侧边栏看不见、
 * 手输 URL 却进得去」的两套规则并存：页面能打开，里面的按钮一个个 403，
 * 用户只会以为面板坏了。这里把导航的可见性与路由的可达性对齐。
 */
function RequirePermission({
  perm,
  children,
}: {
  perm: string;
  children: ReactNode;
}) {
  const { hasPermission } = useAuth();
  if (!hasPermission(perm)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

/* 已登录用户访问 /login 时跳回控制台首页 */
function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { user, initializing } = useAuth();
  if (initializing) return <FullPageLoader />;
  if (user) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

/* ---------------------------------------------------------------------------
   App
   --------------------------------------------------------------------------- */

export function App() {
  /* 站点信息（品牌名 / 版权）在路由顶层读一次：它顺带同步浏览器标签页标题，
     放在这里可以覆盖登录页、产品官网与所有后台页面。 */
  useSiteInfo();

  return (
    <Routes>
      {/* 公开路由 */}
      <Route
        path="/login"
        element={
          <RedirectIfAuthed>
            <Login />
          </RedirectIfAuthed>
        }
      />

      {/* 自助注册（免登录）；建出来的账号要等管理员审批 */}
      <Route
        path="/register"
        element={
          <RedirectIfAuthed>
            <Register />
          </RedirectIfAuthed>
        }
      />

      {/* 自助重置密码（免登录）：
          第 1 步填用户名发邮件链接，第 2 步从邮件链接进来设新密码。
          第 2 步不套 RedirectIfAuthed —— 已登录的用户也可能需要改密码，
          被弹回首页反而走不到这一步。 */}
      <Route
        path="/forgot-password"
        element={
          <RedirectIfAuthed>
            <ForgotPassword />
          </RedirectIfAuthed>
        }
      />
      <Route path="/reset-password" element={<ResetPassword />} />

      {/* 产品官网（免登录） */}
      <Route path="/" element={<Landing />} />


      {/* 受保护路由 */}
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        {/* 个人中心：所有登录用户可用（改邮箱、改密码） */}
        <Route path="/profile" element={<Profile />} />
        {/* 没有单独的 /deploy 页：快速部署是创建弹窗里的一个模式，
            见 components/QuickDeployForm.tsx。旧书签 / 收藏仍会指到这里，
            转去虚拟机列表（「创建虚拟机」默认就是快速模式），不给 404。 */}
        <Route path="/deploy" element={<Navigate to="/vms" replace />} />
        <Route path="/vms" element={<VirtualMachines />} />
        <Route path="/vms/:node/:vmid" element={<VmDetail />} />
        {/* LXC 容器：与虚拟机完全独立的一套页面（PVE 上是两套端点） */}
        <Route path="/lxc" element={<Containers />} />
        <Route path="/lxc/:node/:vmid" element={<LxcDetail />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/nodes" element={<Nodes />} />
        {/* 节点域的子页面：连接配置（静态段优先于下面的 :node） */}
        <Route path="/nodes/connections" element={<NodesConnections />} />
        <Route path="/nodes/:node" element={<NodeDetail />} />
        <Route path="/storages" element={<Storages />} />
        <Route path="/networks" element={<Networks />} />
        {/* 以下页面全部按「侧边栏可见 = 路由可达」对齐。
            原先它们只靠侧边栏隐藏，手输 URL 仍能进 —— 进去后接口一路 403，
            用户只会以为面板坏了。守卫用的 permission 与侧边栏逐字一致。 */}
        {/* 防火墙：三个作用域 + 安全组 / IP 集合 / 规则模板 */}
        <Route
          path="/firewall"
          element={
            <RequirePermission perm="firewall.view">
              <Firewall />
            </RequirePermission>
          }
        />
        {/* SSH 登录安全：本机日志统计 + fail2ban 管控；配置单独一页。
            这两页读的是主机级数据（登录爆破记录），默认仅管理员可见 */}
        <Route
          path="/ssh-security"
          element={
            <RequirePermission perm="ssh.view">
              <SshSecurity />
            </RequirePermission>
          }
        />
        <Route
          path="/ssh-security/config"
          element={
            <RequirePermission perm="ssh.view">
              <SshSecurityConfig />
            </RequirePermission>
          }
        />
        {/* 安全基线：面板所在主机 + 受管主机的一键体检 / 加固（主机级，默认管理员） */}
        <Route
          path="/security-baseline"
          element={
            <RequirePermission perm="baseline.view">
              <SecurityBaseline />
            </RequirePermission>
          }
        />
        {/* 端口与进程：监听端口清单 + 可疑进程启发式（主机级，默认管理员） */}
        <Route
          path="/ports"
          element={
            <RequirePermission perm="ports.view">
              <PortGuard />
            </RequirePermission>
          }
        />
        {/* 应急响应：VM 隔离处置 + 备份防删核对。
            与侧边栏的 permission 对齐（原先导航要 vm.backup，路由却裸奔） */}
        <Route
          path="/incident"
          element={
            <RequirePermission perm="vm.backup">
              <IncidentResponse />
            </RequirePermission>
          }
        />
        {/* 主机登录审计：last / lastb / sudo，并增量汇入面板审计（主机级，默认管理员） */}
        <Route
          path="/host-audit"
          element={
            <RequirePermission perm="ssh.view">
              <HostAudit />
            </RequirePermission>
          }
        />
        <Route path="/snapshots" element={<Snapshots />} />
        <Route path="/backups" element={<Backups />} />
        <Route
          path="/tasks"
          element={
            <RequireAdmin>
              <Tasks />
            </RequireAdmin>
          }
        />
        <Route path="/frp" element={<Frp />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route
          path="/certificates"
          element={
            <RequirePermission perm="cert.view">
              <Certificates />
            </RequirePermission>
          }
        />
        <Route
          path="/bot"
          element={
            <RequireAdmin>
              <FeishuBot />
            </RequireAdmin>
          }
        />
        <Route
          path="/users"
          element={
            <RequireAdmin>
              <Users />
            </RequireAdmin>
          }
        />
        <Route
          path="/audit"
          element={
            <RequireAdmin>
              <AuditLog />
            </RequireAdmin>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAdmin>
              <Settings />
            </RequireAdmin>
          }
        />
        {/* 后台任务：调度器里各巡检作业的状态与间隔 */}
        <Route
          path="/scheduler"
          element={
            <RequireAdmin>
              <Scheduler />
            </RequireAdmin>
          }
        />
      </Route>

      {/* 404 */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
