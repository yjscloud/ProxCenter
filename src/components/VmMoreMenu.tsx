/* ==========================================================================
   ProxCenter — 虚拟机详情页的「更多操作」

   为什么详情页需要一个菜单：详情页是「盯着这一台机器」的地方，但低频操作
   （克隆、转模板、迁移、改归属、重置口令、导出镜像、删除）全塞进标题栏会把
   主操作（开机 / 关机 / 控制台）挤散，而它们又确实要在这一页才顺手 ——
   因为用户是在这一页看清了这台机器的状态后才决定动手的。

   菜单只做「入口 + 各自的确认」：真正的动作全部走既有接口，权限按后端的要求
   逐项判断（写操作看 vm.config 那套的 canWrite，归属仅管理员，导出看 vm.backup）。
   ========================================================================== */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { guestsApi } from '../api/guests';
import { nodesApi, storagesApi, vmsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Field, Input, Select, Switch } from './ui/Input';
import { Notice } from './ui/EmptyState';
import { UserSelect } from './ui/UserSelect';
import { ResetGuestPasswordDialog } from './ResetGuestPasswordDialog';
import { VmExportDialog } from './VmExportDialog';
import { VmReinstallWizard } from './VmReinstallWizard';
import {
  IconCopy,
  IconDisk,
  IconDownload,
  IconKey,
  IconLayers,
  IconMore,
  IconTemplate,
  IconTrash,
  IconUser,
} from './Icons';
import type { VmSummary } from '../api/types';

export interface VmMoreMenuProps {
  /** 目标虚拟机（详情页传 VmDetailType 即可，结构上兼容） */
  vm: VmSummary | null;
  /** 删除交给详情页自己处理（那一页已经有确认框与删除逻辑） */
  onDelete: () => void;
  /** 操作成功后刷新详情 */
  onChanged: () => void;
}

type Dialog =
  | 'clone'
  | 'migrate'
  | 'owner'
  | 'export'
  | 'reset'
  | 'reinstall'
  | null;

export function VmMoreMenu({ vm, onDelete, onChanged }: VmMoreMenuProps) {
  const t = useT();
  const toast = useToast();
  const { canWrite, isAdmin, hasPermission } = useAuth();

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

  /* 换机器（详情页切换）时把菜单与弹窗都收掉，免得操作到上一台身上 */
  useEffect(() => {
    setOpen(false);
    setDialog(null);
  }, [vm?.node, vm?.vmid]);

  const toTemplate = async () => {
    if (!vm) return;
    setTemplateBusy(true);
    try {
      await vmsApi.toTemplate(vm.node, vm.vmid);
      toast.success(t('vmMore.toTemplateDone'), vm.name || String(vm.vmid));
      setTemplateOpen(false);
      onChanged();
    } catch (err) {
      toast.error(t('vmMore.toTemplateFailed'), errorMessage(err));
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

  const showExport = hasPermission('vm.backup');
  const showOwner = isAdmin;
  const showReset = hasPermission('vm.config');
  const showReinstall = hasPermission('vm.reinstall');
  const isTemplate = Boolean(vm?.template);

  return (
    <>
      <span className="vm-more" ref={anchorRef}>
        <Button
          variant="secondary"
          icon={<IconMore size={15} />}
          onClick={() => setOpen((prev) => !prev)}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={!vm}
        >
          {t('vmMore.menu')}
        </Button>
        {open ? (
          <div className="vm-more-menu" role="menu" ref={menuRef}>
            {canWrite ? item(t('vmMore.clone'), <IconCopy size={15} />, () => setDialog('clone')) : null}
            {canWrite && !isTemplate
              ? item(t('vmMore.toTemplate'), <IconTemplate size={15} />, () => setTemplateOpen(true))
              : null}
            {canWrite
              ? item(t('vmMore.migrate'), <IconLayers size={15} />, () => setDialog('migrate'))
              : null}
            {/* 重装系统：用模板的系统盘把这块系统盘换掉（机器身份不变） */}
            {showReinstall
              ? item(t('vmReinstall.menu'), <IconDisk size={15} />, () =>
                  setDialog('reinstall'),
                )
              : null}
            {showReset
              ? item(t('vmMore.resetPassword'), <IconKey size={15} />, () => setDialog('reset'))
              : null}
            {showOwner
              ? item(t('vmMore.assignOwner'), <IconUser size={15} />, () => setDialog('owner'))
              : null}
            {showExport
              ? item(t('vmExport.menuItem'), <IconDownload size={15} />, () => setDialog('export'))
              : null}
            {canWrite ? (
              <>
                <div className="user-dropdown-divider" />
                {item(t('vmMore.deleteVm'), <IconTrash size={15} />, onDelete, true)}
              </>
            ) : null}
          </div>
        ) : null}
      </span>

      {/* 克隆 / 迁移 / 归属：三个小表单，各自独立弹窗 */}
      <CloneMiniDialog
        vm={dialog === 'clone' ? vm : null}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null);
          onChanged();
        }}
      />
      <MigrateMiniDialog
        vm={dialog === 'migrate' ? vm : null}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null);
          onChanged();
        }}
      />
      <OwnerMiniDialog
        vm={dialog === 'owner' ? vm : null}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null);
          onChanged();
        }}
      />

      <ResetGuestPasswordDialog
        guest={dialog === 'reset' ? vm : null}
        noun={t('vmMore.noun')}
        onClose={() => setDialog(null)}
        onDone={() => setDialog(null)}
      />
      <VmExportDialog
        open={dialog === 'export'}
        vm={dialog === 'export' ? vm : null}
        onClose={() => setDialog(null)}
      />
      {/* 重装：成功后**不自动关窗** —— 结果里带着「新盘 / 旧盘 / 每一步」，
          那正是用户想确认的东西（尤其旧盘是删了还是留了） */}
      <VmReinstallWizard
        open={dialog === 'reinstall'}
        vm={dialog === 'reinstall' ? vm : null}
        onClose={() => setDialog(null)}
        onDone={() => onChanged()}
      />

      <ConfirmDialog
        open={templateOpen}
        title={t('vmMore.toTemplateTitle')}
        message={t('vmMore.toTemplateMessage', { name: vm?.name ?? '' })}
        confirmText={t('vmMore.toTemplateConfirm')}
        loading={templateBusy}
        onCancel={() => setTemplateOpen(false)}
        onConfirm={() => void toTemplate()}
      />
    </>
  );
}

/* ------------------------------------------------------------------ 克隆 */

function CloneMiniDialog({
  vm,
  onClose,
  onDone,
}: {
  vm: VmSummary | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const runner = useTaskRunner();
  const [newId, setNewId] = useState('');
  const [name, setName] = useState('');
  const [full, setFull] = useState(true);
  const [storage, setStorage] = useState('');
  const [busy, setBusy] = useState(false);

  const storagesQuery = useQuery({
    queryKey: ['storages', 'list', vm?.node],
    queryFn: () => storagesApi.list(vm?.node),
    enabled: Boolean(vm),
    staleTime: 60_000,
    retry: false,
  });
  const targets = (storagesQuery.data ?? []).filter((item) =>
    String(item.content ?? '')
      .split(',')
      .some((c) => c === 'images' || c === 'rootdir'),
  );

  useEffect(() => {
    if (!vm) return;
    setNewId('');
    setName(`${vm.name || `vm-${vm.vmid}`}-clone`);
    setStorage('');
    setFull(true);
    setBusy(false);
  }, [vm?.node, vm?.vmid]);

  const idNum = Number(newId);
  const idError =
    newId && (!Number.isInteger(idNum) || idNum < 100 || idNum > 999999999)
      ? t('guestList.cloneIdRange')
      : undefined;

  const submit = async () => {
    if (!vm || !newId || idError) return;
    setBusy(true);
    try {
      await runner.run(
        vmsApi.clone(vm.node, vm.vmid, {
          newid: idNum,
          name: name || undefined,
          full,
          target_storage: storage || undefined,
        }),
        {
          title: t('guestList.cloneTask', { name: vm.name || vm.vmid }),
          node: vm.node,
          invalidate: [['vms'], ['cluster'], ['storages']],
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
      open={Boolean(vm)}
      onClose={busy ? () => undefined : onClose}
      title={t('guestList.cloneTitle', { noun: t('vmMore.noun') })}
      description={
        vm ? t('guestList.cloneSource', { name: vm.name || vm.vmid, node: vm.node }) : undefined
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
          <Field label={t('guestList.cloneNewName')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Field label={t('guestList.cloneTarget')} hint={t('guestList.cloneTargetHint')}>
          <Select
            value={storage}
            onChange={(e) => setStorage(e.target.value)}
            placeholder={t('guestList.cloneTargetPlaceholder')}
            options={targets.map((item) => ({
              label: `${item.storage}（${item.type}）`,
              value: item.storage,
            }))}
          />
        </Field>
        <Switch
          checked={full}
          onChange={setFull}
          label={t('guestList.cloneFullLabel')}
        />
        {full ? null : (
          <Notice tone="warning" title={t('guestList.cloneLinkedTitle')}>
            {t('guestList.cloneLinkedDesc')}
          </Notice>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ 迁移 */

function MigrateMiniDialog({
  vm,
  onClose,
  onDone,
}: {
  vm: VmSummary | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const runner = useTaskRunner();
  const [target, setTarget] = useState('');
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    enabled: Boolean(vm),
    staleTime: 60_000,
    retry: false,
  });
  /* 排除当前节点：PVE 的 migrate 目标是另一台节点 */
  const targets = (nodesQuery.data ?? []).filter((item) => item.node !== vm?.node);

  useEffect(() => {
    if (!vm) return;
    setTarget('');
    setOnline(vm.status === 'running');
    setBusy(false);
  }, [vm?.node, vm?.vmid]);

  const submit = async () => {
    if (!vm || !target) return;
    setBusy(true);
    try {
      await runner.run(
        vmsApi.migrate(vm.node, vm.vmid, { target_node: target, online }),
        {
          title: t('vmMore.migrateTask', { name: vm.name || vm.vmid }),
          node: vm.node,
          invalidate: [['vms'], ['nodes']],
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
      open={Boolean(vm)}
      onClose={busy ? () => undefined : onClose}
      title={t('vmMore.migrateTitle')}
      description={
        vm ? t('guestList.cloneSource', { name: vm.name || vm.vmid, node: vm.node }) : undefined
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
              hint={t('vmMore.migrateOnlineHint')}
            />
          </>
        ) : (
          <Notice tone="warning">{t('vmMore.migrateNoTarget')}</Notice>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ 归属 */

function OwnerMiniDialog({
  vm,
  onClose,
  onDone,
}: {
  vm: VmSummary | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [owner, setOwner] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!vm) return;
    setBusy(false);
    setLoading(true);
    guestsApi
      .getOwner({ node: vm.node, vmid: vm.vmid }, vm.connection_id)
      .then((res) => setOwner(res.owner ?? ''))
      .catch(() => setOwner(''))
      .finally(() => setLoading(false));
  }, [vm?.node, vm?.vmid]);

  const submit = async () => {
    if (!vm) return;
    setBusy(true);
    try {
      const res = await guestsApi.assignOwner(
        { node: vm.node, vmid: vm.vmid },
        owner.trim() || null,
        vm.connection_id,
      );
      toast.success(
        res.owner ? t('guestList.assignDone', { noun: t('vmMore.noun') }) : t('guestList.assignCleared'),
        res.owner || vmsLabel(vm),
      );
      onDone();
    } catch (err) {
      toast.error(t('guestList.assignFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(vm)}
      onClose={busy ? () => undefined : onClose}
      title={t('guestList.assignTitle', { noun: t('vmMore.noun') })}
      description={t('guestList.assignDesc', { noun: t('vmMore.noun') })}
      size="sm"
      closeOnOverlay={!busy}
      hideClose={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <UserSelect
        label={t('guestList.assignField')}
        hint={loading ? t('guestList.assignLoading') : undefined}
        value={owner}
        onChange={setOwner}
        disabled={loading}
      />
    </Modal>
  );
}

function vmsLabel(vm: VmSummary): string {
  return vm.name || `${vm.vmid}`;
}
