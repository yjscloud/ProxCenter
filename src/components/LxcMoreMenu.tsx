/* ==========================================================================
   ProxCenter — 容器详情页的「更多操作」

   与 `VmMoreMenu` 平行的一页。为什么容器也要有：详情页是「盯着这一台机器」的
   地方，但低频操作（克隆、转模板、迁移、删除）全塞进标题栏会把主操作
   （启动 / 关机 / 控制台）挤散，而它们又确实要在这一页才顺手 —— 用户是在这一页
   看清了容器状态之后才决定动手的。

   **刻意不做成 VmMoreMenu 的 kind 参数**：两者能做的事并不重合 —— 容器没有
   重装系统（换系统盘就是换模板，没有对应端点）、没有导出镜像（那套走的是虚拟机
   备份链）、口令重置的权限键也不同（ct.password.reset 是另一套服务端守卫）。
   硬塞进一个组件会到处是 `kind === 'lxc' ? … : …`，反而更容易漏改某一侧。

   菜单只做「入口 + 各自的确认」：动作全走既有接口（lxcApi.clone / toTemplate /
   migrate），权限按后端真正用的那个键逐项判断。

   指派归属与虚拟机详情页共用 `OwnerAssignDialog`（这里是 ct.assign）——
   以前这一页**没有**这个入口：列表行菜单里有、点进详情页反而没有，区域管理员
   改派容器时只能退回列表去找。
   ========================================================================== */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { lxcApi, nodesApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useNodeStorages } from '../hooks/useNodeStorages';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Field, Input, Select, Switch } from './ui/Input';
import { Notice } from './ui/EmptyState';
import { OwnerAssignDialog } from './OwnerAssignDialog';
import { formatBytes } from '../utils/format';
import {
  IconCopy,
  IconLayers,
  IconMore,
  IconTemplate,
  IconTrash,
  IconUser,
} from './Icons';
import type { LxcDetail } from '../api/types';

export interface LxcMoreMenuProps {
  /** 目标容器（详情页直接传 LxcDetail） */
  ct: LxcDetail;
  /**
   * 这台容器属于哪条 PVE 连接（详情页从 `?connection=` 读出来传进来）。
   * LxcDetail 本身不带这个字段，而克隆要落到指定连接上：多主机部署下只按
   * 节点名查存储池会被页面级连接带到另一台 PVE。
   */
  connectionId?: string;
  /** 删除交给详情页自己处理（那一页已经有确认框与删除逻辑） */
  onDelete: () => void;
  /** 操作成功后刷新详情 */
  onChanged: () => void;
}

type Dialog = 'clone' | 'migrate' | 'owner' | null;

export function LxcMoreMenu({
  ct,
  connectionId,
  onDelete,
  onChanged,
}: LxcMoreMenuProps) {
  const t = useT();
  const toast = useToast();
  const { hasPermission } = useAuth();
  /* 菜单里每一项要的后端权限都不同，逐项判（与 VmMoreMenu 同一口径：
     克隆 → ct.clone；转模板 → template.manage；迁移 → ct.migrate；删除 → ct.delete） */
  const canClone = hasPermission('ct.clone');
  const canConvert = hasPermission('template.manage');
  const canMigrate = hasPermission('ct.migrate');
  const canDelete = hasPermission('ct.delete');
  /* 归属改派：按权限点判（区域管理员有 ct.assign、不是 admin）。
     与列表行菜单同一口径，两处都能进。 */
  const canAssign = hasPermission('ct.assign');

  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /* 点外面 / 滚动 / 改窗口大小都收起：菜单贴着按钮绝对定位，滚动后位置会歪 */
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!anchorRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  /* 换容器（详情页切换）时把菜单与弹窗都收掉，免得操作到上一台身上 */
  useEffect(() => {
    setOpen(false);
    setDialog(null);
  }, [ct.node, ct.vmid]);

  const toTemplate = async () => {
    setTemplateBusy(true);
    try {
      await lxcApi.toTemplate(ct.node, ct.vmid, connectionId);
      toast.success(t('lxcMore.toTemplateDone'), ct.name || String(ct.vmid));
      setTemplateOpen(false);
      onChanged();
    } catch (err) {
      toast.error(t('lxcMore.toTemplateFailed'), errorMessage(err));
    } finally {
      setTemplateBusy(false);
    }
  };

  const item = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    danger = false,
  ) => (
    <button
      type="button"
      role="menuitem"
      className={`dropdown-item ${danger ? 'dropdown-item-danger' : ''}`}
      onClick={() => {
        setOpen(false);
        onClick();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <>
      <span className="vm-more" ref={anchorRef}>
        <Button
          variant="secondary"
          icon={<IconMore size={15} />}
          onClick={() => setOpen((prev) => !prev)}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          {t('vmMore.menu')}
        </Button>
        {open ? (
          <div className="vm-more-menu" role="menu" ref={menuRef}>
            {canClone
              ? item(t('lxcMore.clone'), <IconCopy size={15} />, () => setDialog('clone'))
              : null}
            {/* 转模板要求容器已关机（PVE 的 pct template 会直接拒绝运行中的容器）。
                这里不禁用这一项，而是把「请先确认容器已关机」写进确认框 ——
                禁用一个说不清原因的菜单项，用户只会以为坏了。 */}
            {canConvert && !ct.template
              ? item(t('lxcMore.toTemplate'), <IconTemplate size={15} />, () =>
                  setTemplateOpen(true),
                )
              : null}
            {canMigrate
              ? item(t('lxcMore.migrate'), <IconLayers size={15} />, () => setDialog('migrate'))
              : null}
            {/* 与虚拟机详情页 / 列表行菜单同一口径：有 ct.assign 就显示，
                不按模板与否分叉（列表那边也是照常显示的） */}
            {canAssign
              ? item(t('lxcMore.assignOwner'), <IconUser size={15} />, () =>
                  setDialog('owner'),
                )
              : null}
            {canDelete ? (
              <>
                <div className="user-dropdown-divider" />
                {item(t('lxcMore.deleteCt'), <IconTrash size={15} />, onDelete, true)}
              </>
            ) : null}
          </div>
        ) : null}
      </span>

      <CloneMiniDialog
        ct={dialog === 'clone' ? ct : null}
        connectionId={connectionId}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null);
          onChanged();
        }}
      />
      <MigrateMiniDialog
        ct={dialog === 'migrate' ? ct : null}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null);
          onChanged();
        }}
      />
      {/* type 必须是 'lxc'：漏了会按 qemu 处理，归属落进 vm 桶，额度会同时
          算进虚拟机与容器两组（见 guests.ts 里 assignOwner 的说明） */}
      <OwnerAssignDialog
        guest={
          dialog === 'owner'
            ? {
                node: ct.node,
                vmid: ct.vmid,
                type: 'lxc',
                connection_id: connectionId,
              }
            : null
        }
        label={ct.name || String(ct.vmid)}
        noun={t('lxcMore.noun')}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null);
          onChanged();
        }}
      />

      <ConfirmDialog
        open={templateOpen}
        title={t('lxcMore.toTemplateTitle')}
        message={t('lxcMore.toTemplateMessage', { name: ct.name ?? '' })}
        confirmText={t('lxcMore.toTemplateConfirm')}
        loading={templateBusy}
        onCancel={() => setTemplateOpen(false)}
        onConfirm={() => void toTemplate()}
      />
    </>
  );
}

/* ------------------------------------------------------------------ 克隆 */

function CloneMiniDialog({
  ct,
  connectionId,
  onClose,
  onDone,
}: {
  ct: LxcDetail | null;
  connectionId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const runner = useTaskRunner();
  const [newId, setNewId] = useState('');
  const [hostname, setHostname] = useState('');
  const [storage, setStorage] = useState('');
  const [targetNode, setTargetNode] = useState('');
  const [busy, setBusy] = useState(false);

  /* 目标存储：只列**源容器所在节点**上、且能放容器磁盘（rootdir）的池子。
     容器用的是 rootdir，不是虚拟机的 images —— 选错必被 PVE 拒。
     显式带上该节点的连接：多主机下只按节点名查会被页面级连接带到别处。 */
  const storagesQuery = useNodeStorages(ct?.node ?? '', connectionId, Boolean(ct));
  const storageOptions = useMemo(
    () => [
      { label: t('lxcMore.cloneTargetDefault'), value: '' },
      ...(storagesQuery.data ?? [])
        .filter(
          (item) =>
            item.active &&
            String(item.content ?? '')
              .split(/[,;]/)
              .some((c) => c.trim() === 'rootdir'),
        )
        .map((item) => ({
          label: t('templates.storageAvail', {
            storage: item.storage,
            avail: formatBytes(item.avail),
          }),
          value: item.storage,
        })),
    ],
    [storagesQuery.data, t],
  );

  /* 目标节点：可选项与迁移一样是「除当前节点外的其它节点」 */
  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    enabled: Boolean(ct),
    staleTime: 60_000,
    retry: false,
  });
  const nodeOptions = useMemo(
    () => [
      { label: t('lxcMore.cloneSameNode'), value: '' },
      ...(nodesQuery.data ?? [])
        .filter((item) => item.node !== ct?.node)
        .map((item) => ({ label: item.node, value: item.node })),
    ],
    [nodesQuery.data, ct?.node, t],
  );

  useEffect(() => {
    if (!ct) return;
    setNewId('');
    setHostname(`${ct.hostname || ct.name || `ct-${ct.vmid}`}-clone`);
    setStorage('');
    setTargetNode('');
    setBusy(false);
  }, [ct?.node, ct?.vmid]);

  const idNum = Number(newId);
  const idError =
    newId && (!Number.isInteger(idNum) || idNum < 100 || idNum > 999999999)
      ? t('guestList.cloneIdRange')
      : undefined;

  const submit = async () => {
    if (!ct || !newId || idError) return;
    setBusy(true);
    try {
      await runner.run(
        lxcApi.clone(
          ct.node,
          ct.vmid,
          {
            newid: idNum,
            hostname: hostname || undefined,
            target_storage: storage || undefined,
            target_node: targetNode || undefined,
          },
          connectionId,
        ),
        {
          title: t('lxcMore.cloneTask', { name: ct.name || ct.vmid }),
          node: ct.node,
          invalidate: [['lxc'], ['cluster'], ['storages']],
        },
      );
      onDone();
    } catch {
      /* toast 已提示 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(ct)}
      onClose={busy ? () => undefined : onClose}
      title={t('lxcMore.cloneTitle')}
      description={
        ct ? t('guestList.cloneSource', { name: ct.name || ct.vmid, node: ct.node }) : undefined
      }
      size="sm"
      closeOnOverlay={!busy}
      hideClose={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
            disabled={!newId || Boolean(idError)}
          >
            {t('guestList.cloneStart')}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        <div className="field-row">
          <Field label={t('guestList.cloneNewId')} required error={idError}>
            <Input
              value={newId}
              onChange={(e) => setNewId(e.target.value.replace(/\D/g, ''))}
              placeholder={t('guestList.cloneNewIdPlaceholder')}
              mono
            />
          </Field>
          <Field label={t('lxcMore.cloneHostname')}>
            <Input value={hostname} onChange={(e) => setHostname(e.target.value)} />
          </Field>
        </div>
        <Field label={t('guestList.cloneTarget')} hint={t('lxcMore.cloneStorageHint')}>
          <Select
            value={storage}
            onChange={(e) => setStorage(e.target.value)}
            options={storageOptions}
          />
        </Field>
        {/* 跨节点克隆：选一个别的节点，克隆完直接落在那边（PVE 的 clone 原生支持）。
            留空 = 就地克隆。 */}
        <Field label={t('lxcMore.cloneTargetNode')} hint={t('lxcMore.cloneNodeHint')}>
          <Select
            value={targetNode}
            onChange={(e) => setTargetNode(e.target.value)}
            options={nodeOptions}
          />
        </Field>
        {!nodesQuery.isLoading && nodeOptions.length <= 1 ? (
          <Notice tone="info">{t('lxcMore.cloneSingleNode')}</Notice>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ 迁移 */

function MigrateMiniDialog({
  ct,
  onClose,
  onDone,
}: {
  ct: LxcDetail | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const runner = useTaskRunner();
  const [target, setTarget] = useState('');
  const [online, setOnline] = useState(true);
  const [restart, setRestart] = useState(false);
  const [busy, setBusy] = useState(false);

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    enabled: Boolean(ct),
    staleTime: 60_000,
    retry: false,
  });
  /* 排除当前节点：PVE 的 migrate 目标是另一台节点 */
  const targets = (nodesQuery.data ?? []).filter((item) => item.node !== ct?.node);

  useEffect(() => {
    if (!ct) return;
    setTarget('');
    setOnline(ct.status.startsWith('run'));
    setRestart(false);
    setBusy(false);
  }, [ct?.node, ct?.vmid]);

  const submit = async () => {
    if (!ct || !target) return;
    setBusy(true);
    try {
      await runner.run(
        lxcApi.migrate(ct.node, ct.vmid, {
          target_node: target,
          online,
          restart,
        }),
        {
          title: t('lxcMore.migrateTask', { name: ct.name || ct.vmid }),
          node: ct.node,
          invalidate: [['lxc'], ['nodes']],
        },
      );
      onDone();
    } catch {
      /* toast 已提示 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(ct)}
      onClose={busy ? () => undefined : onClose}
      title={t('lxcMore.migrateTitle')}
      description={
        ct ? t('guestList.cloneSource', { name: ct.name || ct.vmid, node: ct.node }) : undefined
      }
      size="sm"
      closeOnOverlay={!busy}
      hideClose={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
            disabled={!target}
          >
            {t('vmMore.migrateStart')}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        {targets.length ? (
          <>
            <Field label={t('vmMore.migrateTarget')} required>
              <Select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={t('vmMore.migratePlaceholder')}
                options={targets.map((item) => ({ label: item.node, value: item.node }))}
              />
            </Field>
            <Switch
              checked={online}
              onChange={setOnline}
              label={t('vmMore.migrateOnline')}
              hint={t('lxcMore.migrateOnlineHint')}
            />
            {/* 在线迁移失败时 PVE 可以自动把容器在原节点拉起来，别让服务悬着 */}
            {online ? (
              <Switch
                checked={restart}
                onChange={setRestart}
                label={t('lxcMore.migrateRestart')}
                hint={t('lxcMore.migrateRestartHint')}
              />
            ) : null}
          </>
        ) : (
          <Notice tone="warning">{t('vmMore.migrateNoTarget')}</Notice>
        )}
      </div>
    </Modal>
  );
}
