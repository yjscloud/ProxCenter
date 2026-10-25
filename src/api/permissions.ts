/* ==========================================================================
   ProxCenter — 权限键清单
   ==========================================================================

   唯一来源是后端 ``backend/app/security.py`` 里的 ``PERMISSION_CATALOG``
   （18 个域、57 个键）。这里手写一份而不是运行时拉取，理由是：

   * 权限判定散在几十个组件里，写的又是**裸字符串** —— 拼错一个（``vm.powers``）
     前后端都是静默失败（后端 403、前端按钮不显示），是最难查的一类问题。
     换成这里的联合类型之后，拼错直接编译不过；
   * 运行时拉取会让「还没登录 / 请求失败」退化成「什么权限都没有」，
     那是把网络问题伪装成权限问题，更难排查。

   一致性由 ``backend/tests/test_permission_catalog.py`` 把关：它会比对这份清单
   与后端目录，两边少一个键 CI 就红。**新增权限点时两边都要加**。
   ========================================================================== */

/** 权限键，与后端目录一一对应（顺序按后端输出，便于肉眼比对） */
export const PERMISSION_KEYS = [
  'ai.exec',
  'ai.terminal',
  'alert.manage',
  'alert.view',
  'audit.view',
  'baseline.manage',
  'baseline.view',
  'cert.manage',
  'cert.view',
  'ct.assign',
  'ct.backup',
  'ct.clone',
  'ct.config',
  'ct.console',
  'ct.create',
  'ct.delete',
  'ct.firewall.manage',
  'ct.firewall.view',
  'ct.migrate',
  'ct.power',
  'ct.snapshot',
  'ct.view',
  'firewall.cluster',
  'firewall.manage',
  'firewall.view',
  'frp.manage',
  'frp.view',
  'network.manage',
  'network.view',
  'node.scope',
  'node.view',
  'ports.manage',
  'ports.view',
  'settings.manage',
  'ssh.manage',
  'ssh.view',
  'storage.manage',
  'storage.view',
  'task.manage',
  'task.view',
  'template.clone',
  'template.manage',
  'template.view',
  'users.manage',
  'users.view',
  'vm.assign',
  'vm.backup',
  'vm.clone',
  'vm.config',
  'vm.console',
  'vm.create',
  'vm.delete',
  'vm.isolate',
  'vm.migrate',
  'vm.power',
  'vm.reinstall',
  'vm.snapshot',
  'vm.view',
] as const;

/** 合法的权限键。权限判定的入参一律用它，写错即编译报错。 */
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
