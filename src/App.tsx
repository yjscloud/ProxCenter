/* ==========================================================================
   pvecenter — 路由与鉴权守卫

   页面一律**按需加载**（见 lazyPage）。原先四十多个页面全是静态 import，全被
   打进首屏那一个 2.4 MB 的包里 —— 用户打开任何一个页面，都要先把所有页面的
   代码下载并解析一遍，冷启动白等好几秒。改成按需之后，首屏只带当前这一个页面。

   三个例外刻意保持静态：`NotFound`、下面的加载态本身，以及维护公告页。404 是
   「地址不对」的兜底，专程再发一个网络请求去取它只是让错误页也变慢；维护页同理
   —— 它出现的时机正是「后端只肯回 503」，这时候不该再依赖一次成功的懒加载。
   ========================================================================== */

import { Navigate, Route, Routes, useLocation } from 'react-router';
import {
  Suspense,
  lazy,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui/Spinner';
import { setMaintenanceHandler } from './api/client';
import { useAuth } from './hooks/useAuth';
import { useMaintenance } from './hooks/useMaintenance';
import type { PermissionKey } from './api/permissions';
import { useSiteInfo } from './hooks/useSiteInfo';
import { ensureDict, useT, type DictGroup } from './i18n';

import { NotFound } from './pages/NotFound';
import { Maintenance } from './pages/Maintenance';

/**
 * 把一个页面组件变成按需加载。
 *
 * 页面都是**具名导出**（`export function Dashboard`），而 `React.lazy` 只认
 * default，所以这里补一层。`name` 受模块自身键的约束 —— 导出名写错，编译期就
 * 会报错，不用等到运行时白屏。
 *
 * 第三个参数是该页面需要的中文词条分组（见 i18n/index.tsx 的 ensureDict）：
 * 页面模块与词典一起 await，渲染时文案已就绪，不会闪一片空白。
 * 后台页 = `app`（共享）+ 本业务域；登录注册只依赖 core，官网加载 landing。
 * 域划分见 locales/zh-CN.<domain>.ts，归属由 scripts/check-i18n.mjs 之外的分析
 * 脚本校验过（外壳只用 core、官网不用业务域、页面不跨域引用）。
 *
 * 没有写成四十多条 `import(…).then(…)`：既吵，又每条都要重抄一遍类型。
 */
function lazyPage<T extends object>(
  load: () => Promise<T>,
  name: keyof T & string,
  /* 该页面需要的词典分组：页面模块与词典一起 await，渲染时文案已就绪。
     默认只取共享词典；业务页再追加本域（见下方各页的第二个分组）。 */
  dicts: DictGroup[] = ['app'],
) {
  return lazy(async () => {
    /* 页面模块与词典并行取回：先发起 load，再等词典，最后拿模块 —— 比串行少
       一个 RTT。写成两步而不是 Promise.all 解构，是因为动态分组数量不固定，
       解构出来的类型会退化成 (T | void)[]。 */
    const modPromise = load();
    await Promise.all(dicts.map((d) => ensureDict(d)));
    const mod = await modPromise;
    return { default: mod[name] as ComponentType };
  });
}

/* 公开页只依赖 core 词典：让它们等业务页词典纯属拖慢首屏 */
const Login = lazyPage(() => import('./pages/Login'), 'Login', ['core']);
const Register = lazyPage(() => import('./pages/Register'), 'Register', ['core']);
const ForgotPassword = lazyPage(
  () => import('./pages/ForgotPassword'),
  'ForgotPassword',
  ['core'],
);
const ResetPassword = lazyPage(() => import('./pages/ResetPassword'), 'ResetPassword', [
  'core',
]);

/* 后台各页：共享词典 app + 本业务域。域划分见 locales/zh-CN.<domain>.ts */
const Dashboard = lazyPage(() => import('./pages/Dashboard'), 'Dashboard', ['app', 'monitor']);
const VirtualMachines = lazyPage(
  () => import('./pages/VirtualMachines'),
  'VirtualMachines',
  ['app', 'compute'],
);
const Containers = lazyPage(() => import('./pages/Containers'), 'Containers', [
  'app',
  'compute',
]);
const VmDetail = lazyPage(() => import('./pages/VmDetail'), 'VmDetail', ['app', 'compute']);
const LxcDetail = lazyPage(() => import('./pages/LxcDetail'), 'LxcDetail', ['app', 'compute']);
const Templates = lazyPage(() => import('./pages/Templates'), 'Templates', ['app', 'compute']);
const Nodes = lazyPage(() => import('./pages/Nodes'), 'Nodes', ['app', 'node']);
const NodesConnections = lazyPage(
  () => import('./pages/NodesConnections'),
  'NodesConnections',
  ['app', 'node'],
);
const NodeDetail = lazyPage(() => import('./pages/NodeDetail'), 'NodeDetail', ['app', 'node']);
const Storages = lazyPage(() => import('./pages/Storages'), 'Storages', ['app', 'node']);
const Networks = lazyPage(() => import('./pages/Networks'), 'Networks', ['app', 'node']);
const Firewall = lazyPage(() => import('./pages/Firewall'), 'Firewall', ['app', 'security']);
const SshSecurity = lazyPage(() => import('./pages/SshSecurity'), 'SshSecurity', [
  'app',
  'security',
]);
const SshSecurityConfig = lazyPage(
  () => import('./pages/SshSecurityConfig'),
  'SshSecurityConfig',
  ['app', 'security'],
);
const AiAssistant = lazyPage(() => import('./pages/AiAssistant'), 'AiAssistant', ['app', 'ai']);
const SecurityBaseline = lazyPage(
  () => import('./pages/SecurityBaseline'),
  'SecurityBaseline',
  ['app', 'security'],
);
const PortGuard = lazyPage(() => import('./pages/PortGuard'), 'PortGuard', ['app', 'security']);
const IncidentResponse = lazyPage(
  () => import('./pages/IncidentResponse'),
  'IncidentResponse',
  ['app', 'compute'],
);
const HostAudit = lazyPage(() => import('./pages/HostAudit'), 'HostAudit', ['app', 'security']);
const Snapshots = lazyPage(() => import('./pages/Snapshots'), 'Snapshots', ['app', 'compute']);
const Backups = lazyPage(() => import('./pages/Backups'), 'Backups', ['app', 'compute']);
const Tasks = lazyPage(() => import('./pages/Tasks'), 'Tasks', ['app', 'node']);
const Frp = lazyPage(() => import('./pages/Frp'), 'Frp', ['app', 'monitor']);
const Alerts = lazyPage(() => import('./pages/Alerts'), 'Alerts', ['app', 'monitor']);
const Notifications = lazyPage(() => import('./pages/Notifications'), 'Notifications', [
  'app',
  'monitor',
]);
const Certificates = lazyPage(() => import('./pages/Certificates'), 'Certificates', [
  'app',
  'settings',
]);
const Users = lazyPage(() => import('./pages/Users'), 'Users', ['app', 'settings']);
const AuditLog = lazyPage(() => import('./pages/AuditLog'), 'AuditLog', ['app', 'settings']);
const Settings = lazyPage(() => import('./pages/Settings'), 'Settings', ['app', 'settings']);
const Scheduler = lazyPage(() => import('./pages/Scheduler'), 'Scheduler', ['app', 'monitor']);
const Profile = lazyPage(() => import('./pages/Profile'), 'Profile', ['app', 'settings']);
const Landing = lazyPage(() => import('./pages/Landing'), 'Landing', ['landing']);
const FeishuBot = lazyPage(() => import('./pages/FeishuBot'), 'FeishuBot', ['app', 'settings']);

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

  /* 角色要求 2FA、本人还没绑：后端除了 2FA 那几个端点，其余一律 403。
     不在这里拦的话，用户会看到「连接测试失败」「无法加载集群数据」这类
     各自的报错，却不知道根因是「先去绑两步验证」—— 一台新装的面板因此
     看起来像坏了。直接把人带到绑定页，绑定完成后再回他想去的地方。

     只在 /profile 以外拦：绑定页本身要能打开，否则成死循环。 */
  if (user.totp_setup_required && location.pathname !== '/profile') {
    return <Navigate to="/profile" replace state={{ from: location.pathname }} />;
  }

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
  perm: PermissionKey;
  children: ReactNode;
}) {
  const { hasPermission } = useAuth();
  if (!hasPermission(perm)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

/**
 * 需要「其中任意一个」权限才能访问 —— 用于跨类型的汇总页（快照 / 备份），
 * 它们同时覆盖虚拟机与容器，只认一侧会让另一侧的用户整页打不开。
 */
function RequireAnyPermission({
  perms,
  children,
}: {
  perms: PermissionKey[];
  children: ReactNode;
}) {
  const { hasPermission } = useAuth();
  if (!perms.some((perm) => hasPermission(perm))) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}

/* 已登录用户访问 /login 时跳回控制台首页 */
function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { user, initializing } = useAuth();
  const maintenance = useMaintenance();
  if (initializing) return <FullPageLoader />;
  /* 维护期间**不**把被挡住的普通用户弹回控制台：他已经什么都干不了，弹回去
     只会让人以为「管理员登录」按钮点了没反应（这正是原来的 bug）。
     管理员照旧跳回控制台 —— 他本来就是登录状态。 */
  /* 只有**确认**维护已关闭才把普通用户弹回控制台：状态还没取回来时（undefined）
     弹走会造成竞态 —— 刚跳到 /login 就被送回去，看起来仍是「按钮没反应」。 */
  const maintenanceOff = maintenance.data?.enabled === false;
  if (user && (user.role === 'admin' || maintenanceOff)) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}

/**
 * 维护期间把**公开页面**换成公告页（产品官网 / 注册 / 找回密码）。
 *
 * 这些页面不调接口，光靠「收到 503 再切维护页」永远切不过去 —— 有用户打开
 * 官网看到的还是原来的官网。管理员不受影响（他要能正常访问）。
 */
function MaintenanceGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const maintenance = useMaintenance();
  if (user?.role === 'admin') return <>{children}</>;
  if (maintenance.data?.enabled) {
    return <Maintenance message={maintenance.data.message} />;
  }
  return <>{children}</>;
}

/* ---------------------------------------------------------------------------
   App
   --------------------------------------------------------------------------- */

export function App() {
  /* 站点信息（品牌名 / 版权）在路由顶层读一次：它顺带同步浏览器标签页标题，
     放在这里可以覆盖登录页、产品官网与所有后台页面。 */
  useSiteInfo();

  const { user } = useAuth();
  /* 维护模式：普通用户的任何接口都会拿到 503 + code=maintenance（见 api/client），
     这里把它变成一整页公告 —— 否则用户看到的是满屏「服务不可用」。

     管理员永远收不到这个信号（后端对他们放行），所以不必判断「是不是管理员」之后
     再把他放进来：真收到就说明确实不该继续用。 */
  const [maintenanceNotice, setMaintenanceNotice] = useState<string | null>(null);

  /* 主动探一次（每 30 秒），而不是只等接口 503：
     有些页面（产品官网、纯展示页）压根不发请求，光等 503 会一直停在原页面 ——
     「开了维护模式但页面没变」就是这个问题。 */
  const maintenance = useMaintenance(true, 30_000);

  useEffect(() => {
    setMaintenanceHandler((message) => setMaintenanceNotice(message || ''));
    return () => setMaintenanceHandler(null);
  }, []);

  useEffect(() => {
    if (user?.role === 'admin') {
      setMaintenanceNotice(null);
      return;
    }
    /* 只在**拿到状态**时才算数：维护期间这个接口本身就是 503，data 是 undefined，
       此时别把它当成「已关闭」，否则刚记下的公告会被立刻清掉。 */
    if (maintenance.data?.enabled === true) {
      setMaintenanceNotice(maintenance.data.message || '');
    } else if (maintenance.data?.enabled === false) {
      /* 关掉维护模式后要能把公告页放出来，否则用户会一直卡在公告上等刷新。 */
      setMaintenanceNotice(null);
    }
  }, [user, maintenance.data]);

  const location = useLocation();

  /* 登录页空闲时预取业务页词典：仪表盘渲染要等它，提前在用户输入账号的这几秒
     里下完，登录成功后切页就不用再等。预取共享词典 + 仪表盘所在的 monitor 域
     （登录后的默认落地页）。只在 /login 触发 —— 官网访客不该为后台词典买单。 */
  useEffect(() => {
    if (location.pathname !== '/login') return;
    const run = () => {
      void ensureDict('app');
      void ensureDict('monitor');
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(run, 1500);
    return () => window.clearTimeout(id);
  }, [location.pathname]);

  /* 登录页与公告页本身要能打开：前者是管理员唯一的入口，后者是这条提示的落点。
     放行登录页也顺带解掉一个死循环 —— 覆盖渲染会盖住 /login，点「管理员登录」
     等于什么都没发生。 */
  const noticePageOpen =
    location.pathname === '/login' || location.pathname === '/maintenance';

  if (maintenanceNotice !== null && user?.role !== 'admin' && !noticePageOpen) {
    return <Maintenance message={maintenanceNotice} />;
  }

  return (
    <Routes>
      {/* 公开路由（每一条都套 PublicBoundary：这些页面按需加载，而它们不在
          Layout 里，拿不到里面那道边界） */}
      {/* 维护公告：可以直接访问，管理员用它预览自己写的公告 */}
      <Route
        path="/maintenance"
        element={
          <PublicBoundary>
            <Maintenance />
          </PublicBoundary>
        }
      />
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
            <MaintenanceGate>
              <RedirectIfAuthed>
                <Register />
              </RedirectIfAuthed>
            </MaintenanceGate>
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
            <MaintenanceGate>
              <RedirectIfAuthed>
                <ForgotPassword />
              </RedirectIfAuthed>
            </MaintenanceGate>
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

      {/* 产品官网（免登录）：维护期间换成维护公告 —— 它不调接口，靠 503 是切不过来的 */}
      <Route
        path="/"
        element={
          <PublicBoundary>
            <MaintenanceGate>
              <Landing />
            </MaintenanceGate>
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
        {/* 虚拟机与容器是两套页面、也是两套权限：虚拟机要 vm.view，容器要 ct.view */}
        <Route
          path="/vms"
          element={
            <RequirePermission perm="vm.view">
              <VirtualMachines />
            </RequirePermission>
          }
        />
        <Route path="/vms/:node/:vmid" element={<VmDetail />} />
        {/* LXC 容器：与虚拟机完全独立的一套页面（PVE 上是两套端点） */}
        <Route
          path="/lxc"
          element={
            <RequirePermission perm="ct.view">
              <Containers />
            </RequirePermission>
          }
        />
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
        {/* 防火墙：四个作用域（虚拟机 / 容器 / 节点 / 集群）+ 安全组 / IP 集合 / 规则模板。
            虚拟机与容器是两套权限，任一侧都能进页面，页内再各看各的。 */}
        <Route
          path="/firewall"
          element={
            <RequireAnyPermission perms={['firewall.view', 'ct.firewall.view']}>
              <Firewall />
            </RequireAnyPermission>
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
        {/* AI 排查助手：把巡检结果与主机现场交给大模型做归因与排序。
            它会 SSH 到目标主机跑**只读**诊断命令，要改动系统的命令必须逐条批准；
            VIEW 权限与安全基线同档（见后端 ai.py 的守卫），模型配置仅管理员可改 */}
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
        {/* 快照 / 备份都是跨类型的汇总页（虚拟机 + 容器）：任一类权限即可进入 */}
        <Route
          path="/snapshots"
          element={
            <RequireAnyPermission perms={['vm.view', 'ct.view']}>
              <Snapshots />
            </RequireAnyPermission>
          }
        />
        <Route
          path="/backups"
          element={
            <RequireAnyPermission perms={['vm.backup', 'ct.backup']}>
              <Backups />
            </RequireAnyPermission>
          }
        />
        {/* 「面板自身」的这几页：路由守卫用的权限与侧边栏菜单项、后端接口三处一致。
            原先一律 RequireAdmin（只认 role == admin），而后端接口早就是按
            task.view / users.view / audit.view / settings.manage 放行的 ——
            结果是自定义角色「勾了也不生效、手输 URL 又进得去」。 */}
        <Route
          path="/tasks"
          element={
            <RequirePermission perm="task.view">
              <Tasks />
            </RequirePermission>
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
            <RequirePermission perm="settings.manage">
              <FeishuBot />
            </RequirePermission>
          }
        />
        <Route
          path="/users"
          element={
            <RequirePermission perm="users.view">
              <Users />
            </RequirePermission>
          }
        />
        <Route
          path="/audit"
          element={
            <RequirePermission perm="audit.view">
              <AuditLog />
            </RequirePermission>
          }
        />
        <Route
          path="/settings"
          element={
            <RequirePermission perm="settings.manage">
              <Settings />
            </RequirePermission>
          }
        />
        {/* 后台任务：调度器里各巡检作业的状态与间隔 */}
        <Route
          path="/scheduler"
          element={
            <RequirePermission perm="settings.manage">
              <Scheduler />
            </RequirePermission>
          }
        />
      </Route>

      {/* 404 */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
