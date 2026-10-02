/* ==========================================================================
   ProxCenter — 节点 · 连接配置（子页面）
   ==========================================================================

   这里是 `/nodes` 的第二个子页面：管「面板能连哪些 Proxmox 主机」。

   为什么从「系统设置」搬到这里、并单独成页：
     * 它管的是**节点域**的事 —— 节点连不上时，要修的正是连接；
     * 连接表单很长（主机 / 令牌 / 控制台凭据 / 证书 / 环境自检 / 创建教程），
       混在节点列表下面会把节点列表顶得老远，找节点得先滚过一整张表单；
     * 单独成页后，节点页的「添加节点」按钮可以直接跳过来并展开表单。

   为什么不再有「当前连接 / 默认节点」：见 ConnectionManager 顶部说明。
   ========================================================================== */

import { PageShell } from '../components/Layout';
import { ConnectionManager } from '../components/ConnectionManager';
import { NodeSubNav } from '../components/NodeSubNav';
import { IconPlug } from '../components/Icons';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n';

export function NodesConnections() {
  const t = useT();
  /* 写连接需要 settings.manage；非管理员进来看只读视图（能看到地址等公开字段） */
  const { isAdmin } = useAuth();

  return (
    <PageShell
      title={
        <>
          <IconPlug size={20} />
          {t('nodesConnections.title')}
        </>
      }
      subtitle={t('nodesConnections.subtitle')}
    >
      <NodeSubNav active="connections" />

      <ConnectionManager isAdmin={isAdmin} />
    </PageShell>
  );
}
