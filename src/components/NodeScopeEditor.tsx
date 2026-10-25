/* ==========================================================================
   ProxCenter — 节点可见性
   ==========================================================================

   有些节点是特殊项目专用机，普通用户既不该在节点页看到，也不该在建机向导里
   选到。节点本身不落库（实时来自 PVE），所以这里只维护「例外」：

   * 打开「对普通用户隐藏」= 写一条默认行（subject='*'），该节点从此默认不可见；
   * 再给具体的人 / 角色授权，作为例外放行。

   判定顺序（用户 > 角色 > 默认 > 无行可见）与写操作的强校验都在后端，这个
   弹窗只负责把配置写进去 —— 前端隐藏下拉从来不是安全边界。
   ========================================================================== */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { nodeScopeApi, rolesApi, usersApi } from '../api/endpoints';
import { useT } from '../i18n';
import { useToast } from '../hooks/useToast';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Field, Input, Select, Switch } from './ui/Input';
import { Notice } from './ui/EmptyState';
import { errorMessage } from '../api/client';

export function NodeScopeEditor({
  open,
  connectionId,
  node,
  onClose,
}: {
  open: boolean;
  connectionId: string;
  node: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [subjectType, setSubjectType] = useState<'user' | 'role'>('user');
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);

  const scopeQuery = useQuery({
    queryKey: ['node-scope'],
    queryFn: () => nodeScopeApi.list(),
    enabled: open,
    staleTime: 10_000,
    retry: false,
  });

  /* 用户与角色清单只用于「授权对象」下拉；拿不到就退回手填（不阻塞配置） */
  const usersQuery = useQuery({
    queryKey: ['users', 'all-for-scope'],
    queryFn: () => usersApi.list(),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });
  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => rolesApi.list(),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  const rows = useMemo(
    () =>
      (scopeQuery.data?.items ?? []).filter(
        (item) =>
          String(item.connection_id ?? '') === String(connectionId ?? '') &&
          item.node === node,
      ),
    [scopeQuery.data, connectionId, node],
  );

  const defaultRow = rows.find(
    (item) => item.subject_type === '*' && item.subject === '*',
  );
  const restricted = Boolean(defaultRow && !defaultRow.allowed);
  const exceptions = rows.filter((item) => item.subject_type !== '*');

  const subjectOptions = useMemo(() => {
    if (subjectType === 'role') {
      return (rolesQuery.data ?? []).map((role) => ({
        label: `${role.name || role.id}`,
        value: role.id,
      }));
    }
    return (usersQuery.data ?? []).map((user) => ({
      label: user.username,
      value: user.username,
    }));
  }, [subjectType, rolesQuery.data, usersQuery.data]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['node-scope'] });
    /* 节点清单由后端按可见性裁剪，管理员自己不受影响；但清一下更稳妥 */
    await queryClient.invalidateQueries({ queryKey: ['nodes'] });
  };

  const toggleRestricted = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) {
        await nodeScopeApi.save({
          connection_id: connectionId,
          node,
          subject_type: '*',
          subject: '*',
          allowed: false,
        });
      } else {
        /* 取消受限 = 删掉默认行（回到「没有配置 = 可见」的初始状态） */
        await nodeScopeApi.remove({
          connection_id: connectionId,
          node,
          subject_type: '*',
          subject: '*',
        });
      }
      await refresh();
      toast.success(t('nodes.scopeUpdated'));
    } catch (err) {
      toast.error(t('nodes.scopeUpdateFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addException = async () => {
    const who = subject.trim();
    if (!who) return;
    setBusy(true);
    try {
      await nodeScopeApi.save({
        connection_id: connectionId,
        node,
        subject_type: subjectType,
        subject: who,
        allowed: true,
      });
      setSubject('');
      await refresh();
      toast.success(t('nodes.scopeUpdated'));
    } catch (err) {
      toast.error(t('nodes.scopeUpdateFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const removeException = async (type: string, who: string) => {
    setBusy(true);
    try {
      await nodeScopeApi.remove({
        connection_id: connectionId,
        node,
        subject_type: type,
        subject: who,
      });
      await refresh();
      toast.success(t('nodes.scopeUpdated'));
    } catch (err) {
      toast.error(t('nodes.scopeUpdateFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('nodes.scopeTitle', { node })}
      description={t('nodes.scopeSubtitle')}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <Switch
        checked={restricted}
        onChange={(next) => void toggleRestricted(next)}
        label={t('nodes.scopeHide')}
        hint={t('nodes.scopeHideHint')}
        disabled={busy}
      />

      {restricted ? (
        <>
          <Notice tone="info">{t('nodes.scopeRestrictedNotice')}</Notice>

          <Field label={t('nodes.scopeAddException')} hint={t('nodes.scopeAddHint')}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <Select
                value={subjectType}
                onChange={(e) => {
                  setSubjectType(e.target.value as 'user' | 'role');
                  setSubject('');
                }}
                options={[
                  { label: t('nodes.scopeTypeUser'), value: 'user' },
                  { label: t('nodes.scopeTypeRole'), value: 'role' },
                ]}
              />
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={
                  subjectType === 'user'
                    ? t('nodes.scopeUserPlaceholder')
                    : t('nodes.scopeRolePlaceholder')
                }
                list="node-scope-subjects"
              />
              <Button
                variant="primary"
                disabled={busy || !subject.trim()}
                onClick={() => void addException()}
              >
                {t('nodes.scopeGrant')}
              </Button>
            </div>
            <datalist id="node-scope-subjects">
              {subjectOptions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </datalist>
          </Field>

          <div className="fs-sm text-secondary" style={{ marginTop: 8 }}>
            {exceptions.length === 0
              ? t('nodes.scopeNoExceptions')
              : exceptions.map((item) => (
                  <div
                    key={`${item.subject_type}:${item.subject}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '4px 0',
                    }}
                  >
                    <span>
                      {item.subject_type === 'user'
                        ? t('nodes.scopeTypeUser')
                        : t('nodes.scopeTypeRole')}
                      ：{item.subject}
                      {item.allowed ? '' : t('nodes.scopeDeniedTag')}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void removeException(item.subject_type, item.subject)
                      }
                    >
                      {t('common.delete')}
                    </Button>
                  </div>
                ))}
          </div>
        </>
      ) : null}
    </Modal>
  );
}
