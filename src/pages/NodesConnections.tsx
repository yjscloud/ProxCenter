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

import { useNavigate } from 'react-router-dom';
import { PageShell } from '../components/Layout';
import { ConnectionManager } from '../components/ConnectionManager';
import { NodeSubNav } from '../components/NodeSubNav';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { IconPlug } from '../components/Icons';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n';

export function NodesConnections() {
  const t = useT();
  const navigate = useNavigate();
  /* 整页都是管理入口（settings.manage）：非管理员**连只读视图也不给** ——
     这一页列的是主机地址、端口、令牌与控制台凭据的状态。原先只是把表单禁用了，
     信息本身照样摊在页面上，等于给任何账号看了一份集群清单。

     后端也已按角色裁剪字段（routers/config.list_connections），这里只是不让
     人白跑一趟。 */
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

      {isAdmin ? (
        <ConnectionManager isAdmin />
      ) : (
        <Card>
          <EmptyState
            title={t('nodesConnections.noPermissionTitle')}
            description={t('nodesConnections.noPermissionBody')}
            icon={<IconPlug size={30} />}
            action={
              <Button variant="secondary" onClick={() => navigate('/nodes')}>
                {t('nodesConnections.backToNodes')}
              </Button>
            }
          />
        </Card>
      )}
    </PageShell>
  );
}
