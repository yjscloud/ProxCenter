/* ==========================================================================
   ProxCenter — 路由与鉴权守卫

   页面一律**按需加载**（见 lazyPage）。原先四十多个页面全是静态 import，全被
   打进首屏那一个 2.4 MB 的包里 —— 用户打开任何一个页面，都要先把所有页面的
   代码下载并解析一遍，冷启动白等好几秒。改成按需之后，首屏只带当前这一个页面。

   两个例外刻意保持静态：`NotFound` 与下面的加载态本身。404 是「地址不对」的
   兜底，专程再发一个网络请求去取它只是让错误页也变慢。
   ========================================================================== */

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Suspense, lazy, type ComponentType, type ReactNode } from 'react';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui/Spinner';
import { useAuth } from './hooks/useAuth';
import { useSiteInfo } from './hooks/useSiteInfo';
import { useT } from './i18n';

import { NotFound } from './pages/NotFound';

/**
 * 把一个页面组件变成按需加载。
 *
 * 页面都是**具名导出**（`export function Dashboard`），而 `React.lazy` 只认
 * default，所以这里补一层。`name` 受模块自身键的约束 —— 导出名写错，编译期就
 * 会报错，不用等到运行时白屏。
 *
 * 没有写成四十多条 `import(…).then(…)`：既吵，又每条都要重抄一遍类型。
 */
function lazyPage<T extends object>(load: () => Promise<T>, name: keyof T & string) {
  return lazy(async () => {
    const mod = await load();
    return { default: mod[name] as ComponentType };
  });
}

const Login = lazyPage(() => import('./pages/Login'), 'Login');
const Register = lazyPage(() => import('./pages/Register'), 'Register');
const ForgotPassword = lazyPage(() => import('./pages/ForgotPassword'), 'ForgotPassword');
const ResetPassword = lazyPage(() => import('./pages/ResetPassword'), 'ResetPassword');
const Dashboard = lazyPage(() => import('./pages/Dashboard'), 'Dashboard');
const VirtualMachines = lazyPage(() => import('./pages/VirtualMachines'), 'VirtualMachines');
const Containers = lazyPage(() => import('./pages/Containers'), 'Containers');
const VmDetail = lazyPage(() => import('./pages/VmDetail'), 'VmDetail');
const LxcDetail = lazyPage(() => import('./pages/LxcDetail'), 'LxcDetail');
const Templates = lazyPage(() => import('./pages/Templates'), 'Templates');
const Nodes = lazyPage(() => import('./pages/Nodes'), 'Nodes');
const NodesConnections = lazyPage(
  () => import('./pages/NodesConnections'),
  'NodesConnections',
);
const NodeDetail = lazyPage(() => import('./pages/NodeDetail'), 'NodeDetail');
const Storages = lazyPage(() => import('./pages/Storages'), 'Storages');
const Networks = lazyPage(() => import('./pages/Networks'), 'Networks');
const Firewall = lazyPage(() => import('./pages/Firewall'), 'Firewall');
const SshSecurity = lazyPage(() => import('./pages/SshSecurity'), 'SshSecurity');
const SshSecurityConfig = lazyPage(
  () => import('./pages/SshSecurityConfig'),
  'SshSecurityConfig',
);
const AiAssistant = lazyPage(() => import('./pages/AiAssistant'), 'AiAssistant');
const SecurityBaseline = lazyPage(
  () => import('./pages/SecurityBaseline'),
  'SecurityBaseline',
);
const PortGuard = lazyPage(() => import('./pages/PortGuard'), 'PortGuard');
const IncidentResponse = lazyPage(
  () => import('./pages/IncidentResponse'),
  'IncidentResponse',
);
const HostAudit = lazyPage(() => import('./pages/HostAudit'), 'HostAudit');
const Snapshots = lazyPage(() => import('./pages/Snapshots'), 'Snapshots');
const Backups = lazyPage(() => import('./pages/Backups'), 'Backups');
const Tasks = lazyPage(() => import('./pages/Tasks'), 'Tasks');
const Frp = lazyPage(() => import('./pages/Frp'), 'Frp');
const Alerts = lazyPage(() => import('./pages/Alerts'), 'Alerts');
const Notifications = lazyPage(() => import('./pages/Notifications'), 'Notifications');
const Certificates = lazyPage(() => import('./pages/Certificates'), 'Certificates');
const Users = lazyPage(() => import('./pages/Users'), 'Users');
const AuditLog = lazyPage(() => import('./pages/AuditLog'), 'AuditLog');
const Settings = lazyPage(() => import('./pages/Settings'), 'Settings');
const Scheduler = lazyPage(() => import('./pages/Scheduler'), 'Scheduler');
const Profile = lazyPage(() => import('./pages/Profile'), 'Profile');
const Landing = lazyPage(() => import('./pages/Landing'), 'Landing');
const FeishuBot = lazyPage(() => import('./pages/FeishuBot'), 'FeishuBot');

/* ---------------------------------------------------------------------------
   全屏加载态
   --------------------------------------------------------------------------- */

function FullPageLoader() {
  const t = useT();
  const label = t('shell.checkingAuth');
  return (
    <div className="notfound" role="status" aria-label={label}>
      <Spinner size={30} label={label} />
      <div className="text-secondary">{t('shell.checkingAuthHint')}</div>
    </div>
  );
}

/**
 * 公开页面（登录 / 注册 / 官网）的加载边界。
 *
 * 按需加载的组件上方必须有一道 Suspense，否则一挂载就抛错。后台那些页面由
 * Layout 里那道边界兜住（所以切页时侧边栏和顶栏不会跟着闪），而这几页不在
 * Layout 里，各自要有一道。
 */
function PublicBoundary({ children }: { children: ReactNode }) {
  return <Suspense fallback={<FullPageLoader />}>{children}</Suspense>;
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
      {/* 公开路由（每一条都套 PublicBoundary：这些页面按需加载，而它们不在
          Layout 里，拿不到里面那道边界） */}
      <Route
        path="/login"
        element={
          <PublicBoundary>
            <RedirectIfAuthed>
              <Login />
            </RedirectIfAuthed>
          </PublicBoundary>
        }
      />

      {/* 自助注册（免登录）；建出来的账号要等管理员审批 */}
      <Route
        path="/register"
        element={
          <PublicBoundary>
            <RedirectIfAuthed>
              <Register />
            </RedirectIfAuthed>
          </PublicBoundary>
        }
      />

      {/* 自助重置密码（免登录）：
          第 1 步填用户名发邮件链接，第 2 步从邮件链接进来设新密码。
          第 2 步不套 RedirectIfAuthed —— 已登录的用户也可能需要改密码，
          被弹回首页反而走不到这一步。 */}
      <Route
        path="/forgot-password"
        element={
          <PublicBoundary>
            <RedirectIfAuthed>
              <ForgotPassword />
            </RedirectIfAuthed>
          </PublicBoundary>
        }
      />
      <Route
        path="/reset-password"
        element={
          <PublicBoundary>
            <ResetPassword />
          </PublicBoundary>
        }
      />

      {/* 产品官网（免登录） */}
      <Route
        path="/"
        element={
          <PublicBoundary>
            <Landing />
          </PublicBoundary>
        }
      />


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
        {/* AI 排查助手：把上面这些巡检结果交给大模型做归因与排序。
            只读（不连目标主机执行命令），权限与安全基线同档；模型配置仅管理员可改 */}
        <Route
          path="/ai-assistant"
          element={
            <RequirePermission perm="baseline.view">
              <AiAssistant />
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
        {/* 消息中心：站内消息的完整列表 —— 顶栏铃铛的「查看全部」落在这里。
            与 /alerts 分开：下发的配置通知没有对应的「告警历史」，把它们引到
            监控告警页只会让人以为消息丢了。 */}
        <Route path="/notifications" element={<Notifications />} />
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
