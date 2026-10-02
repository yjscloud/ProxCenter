/* ==========================================================================
   ProxCenter — 创建 LXC 容器向导
   ==========================================================================

与虚拟机向导刻意**分开**（而不是在 VmCreateWizard 里加分支）：两者的必填项
几乎不重叠 —— 容器要的是「系统模板 + rootfs 容量」而不是「ISO + 磁盘总线」，
初始化靠「root 口令 + SSH 公钥」而不是 cloud-init。硬塞进一个向导会让双方都
冒出一堆条件渲染，改哪边都容易碰坏另一边。

流程：基本信息 → 资源 → 网络与初始化 → 后台任务执行。

同一个弹窗里还有一个「快速部署」模式（QuickDeployForm）：选规格 → 选位置 →
起名即可下发，适合标准容器。两者用一个开关切换 —— 入口只有一个，用户不必
先想清楚「我该进哪个页面」。
*/

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  configApi,
  connectionsApi,
  lxcApi,
  nodesApi,
  storagesApi,
} from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import {
  Checkbox,
  Field,
  Input,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
} from './ui/Input';
import { Notice } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import { NodePicker } from './NodePicker';
import { QuickDeployForm } from './QuickDeployForm';
import { useToast } from '../hooks/useToast';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useT, type TFunc } from '../i18n';
import type { LxcCreateNetwork, LxcCreateRequest } from '../api/types';

type StepIndex = 0 | 1 | 2;

/** 两种下单方式：快速（选规格）与自定义（逐步填写） */
type CreateMode = 'quick' | 'custom';

interface FormState {
  node: string;
  vmid: string;
  name: string;
  ostemplate: string;
  password: string;
  storage: string;
  rootfs: number;
  memory: number;
  swap: number;
  cores: number;
  unprivileged: boolean;
  features: string[];
  start: boolean;
  startOnBoot: boolean;
  bridge: string;
  ip: string;
  gateway: string;
  ip6: string;
  vlanTag: string;
  firewall: boolean;
  sshKeys: string;
  nameserver: string;
  tags: string;
  description: string;
}

const INITIAL: FormState = {
  node: '',
  vmid: '',
  name: '',
  ostemplate: '',
  password: '',
  storage: '',
  rootfs: 8,
  memory: 512,
  swap: 512,
  cores: 1,
  unprivileged: true,
  features: [],
  start: true,
  startOnBoot: true,
  bridge: 'vmbr0',
  ip: 'dhcp',
  gateway: '',
  ip6: '',
  vlanTag: '',
  firewall: false,
  sshKeys: '',
  nameserver: '',
  tags: '',
  description: '',
};

type Errors = Partial<Record<string, string>>;

function validate(step: StepIndex, f: FormState, t: TFunc): Errors {
  const e: Errors = {};
  if (step === 0) {
    if (!f.node) e.node = t('lxcWizard.errNode');
    if (!f.name.trim()) e.name = t('lxcWizard.errName');
    else if (f.name.length > 63) e.name = t('lxcWizard.errNameLength');
    if (f.vmid && !/^\d+$/.test(f.vmid)) e.vmid = t('lxcWizard.errVmid');
    if (!f.ostemplate) e.ostemplate = t('lxcWizard.errTemplate');
  }
  if (step === 1) {
    if (!f.storage) e.storage = t('lxcWizard.errStorage');
    if (f.rootfs < 1) e.rootfs = t('lxcWizard.errRootfs');
    if (f.memory < 16) e.memory = t('lxcWizard.errMemory');
    if (f.cores < 1) e.cores = t('lxcWizard.errCores');
    if (f.swap < 0) e.swap = t('lxcWizard.errSwap');
  }
  if (step === 2) {
    if (!f.bridge) e.bridge = t('lxcWizard.errBridge');
    if (f.ip && f.ip !== 'dhcp' && f.ip !== 'manual' && !f.ip.includes('/')) {
      e.ip = t('lxcWizard.errIp');
    }
  }
  return e;
}

export interface LxcCreateWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (vmid: number) => void;
}

export function LxcCreateWizard({
  open,
  onClose,
  onCreated,
}: LxcCreateWizardProps) {
  const t = useT();
  const toast = useToast();
  const runner = useTaskRunner();
  const queryClient = useQueryClient();

  /* 步骤名与容器特性：文案随语言走，因此在组件内构造 */
  const steps = useMemo(
    () => [
      t('lxcWizard.stepBasic'),
      t('lxcWizard.stepResource'),
      t('lxcWizard.stepNetwork'),
    ],
    [t],
  );
  const featureOptions = useMemo(
    () => [
      { value: 'nesting', label: t('lxcWizard.featNesting') },
      { value: 'keyctl', label: t('lxcWizard.featKeyctl') },
      { value: 'fuse', label: t('lxcWizard.featFuse') },
    ],
    [t],
  );

  const [step, setStep] = useState<StepIndex>(0);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  /**
   * 目标 PVE 主机（必须落到一条具体连接的 id 上）。
   *
   * 这个向导原先没有「连接」概念，于是踩了一个坑：节点下拉来自 ``/api/nodes``，
   * 而那个接口**不带 X-PVE-Connection 时会把所有主机的节点合并返回** —— 用户能在
   * 下拉里选到 pve9；可读模板 / 读存储 / 读网桥 / 建容器这些接口不带连接时会落到
   * 「面板当前连接」（另一台 PVE），在那台主机上请求别人的节点名，PVE 直接回：
   *
   *     hostname lookup 'pve9' failed - failed to get address info for: pve9
   *
   * 所以流程跟虚拟机向导保持一致：先选主机，再选该主机的节点，全程带着连接。
   */
  const [targetConn, setTargetConn] = useState('');

  /**
   * 快速部署 / 自定义部署。默认选快速 —— 绝大多数创建都是「标准机器」；
   * 管理员还没定义任何规格时退回自定义（否则一进来就是个空的选择区）。
   * 用户手动切过之后，就不再被自动改回去。
   */
  const [mode, setMode] = useState<CreateMode>('quick');
  const modeTouchedRef = useRef(false);
  /** 用户主动切换：记下来，别再被「有没有规格」的自动判断覆盖 */
  const pickMode = (next: CreateMode) => {
    modeTouchedRef.current = true;
    setMode(next);
  };

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  /* 每次打开都从干净状态开始 */
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setForm(INITIAL);
    setErrors({});
    setMode('quick');
    modeTouchedRef.current = false;
  }, [open]);

  /* ---- 基础数据 ---- */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    enabled: open,
    staleTime: 60_000,
  });

  /* 规格表：只为「默认用哪种模式」而读。表单自己也读同一份，react-query 缓存
     共用，不会多一次请求 */
  const specsQuery = useQuery({
    queryKey: ['config', 'specs'],
    queryFn: configApi.getSpecs,
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (!open || modeTouchedRef.current || !specsQuery.data) return;
    const usable = specsQuery.data.specs.filter(
      (s) => s.kind === 'lxc' || s.kind === 'both',
    );
    setMode(usable.length > 0 ? 'quick' : 'custom');
  }, [open, specsQuery.data]);

  const connectionOptions = useMemo(
    () =>
      (connectionsQuery.data ?? []).map((c) => ({
        label: `${c.name || c.host}${
          c.active ? t('lxcWizard.currentConn') : ''
        } · ${c.host}:${c.port}`,
        value: c.id,
      })),
    [connectionsQuery.data, t],
  );

  /* 打开时默认落在面板当前连接上（与虚拟机向导一致） */
  useEffect(() => {
    if (!open || targetConn) return;
    const conns = connectionsQuery.data ?? [];
    const target = conns.find((c) => c.active) ?? conns[0];
    if (target) setTargetConn(target.id);
  }, [open, targetConn, connectionsQuery.data]);

  /* 换了主机，节点名不通用（每台 PVE 各有自己的节点），清掉让用户重选 */
  useEffect(() => {
    setForm((f) => (f.node ? { ...f, node: '' } : f));
  }, [targetConn]);

  const nodesQuery = useQuery({
    queryKey: ['nodes', targetConn],
    queryFn: () => nodesApi.list(targetConn),
    enabled: open && Boolean(targetConn),
    staleTime: 60_000,
  });

  /* 节点列表回来后默认选第一个，省掉一次必点的下拉 */
  useEffect(() => {
    if (!open || form.node) return;
    const first = (nodesQuery.data ?? [])[0]?.node;
    if (first) setForm((prev) => ({ ...prev, node: first }));
  }, [open, nodesQuery.data, form.node]);

  const templatesQuery = useQuery({
    queryKey: ['lxc-templates', targetConn, form.node],
    queryFn: () => lxcApi.templates(form.node, targetConn),
    enabled: open && Boolean(targetConn) && Boolean(form.node),
    staleTime: 60_000,
  });

  const storagesQuery = useQuery({
    queryKey: ['storages', 'lxc', targetConn, form.node || 'all'],
    queryFn: () => storagesApi.list(form.node || undefined, targetConn),
    enabled: open && Boolean(targetConn),
    staleTime: 60_000,
  });

  const bridgesQuery = useQuery({
    queryKey: ['nodes', targetConn, form.node, 'network'],
    queryFn: () => nodesApi.network(form.node, targetConn),
    enabled: open && Boolean(targetConn) && Boolean(form.node),
    staleTime: 60_000,
  });

  /** 下发额度：容器有**自己的一份**（与虚拟机额度互相独立），填了才显示 */
  const quotaQuery = useQuery({
    queryKey: ['lxc', 'quota'],
    queryFn: () => lxcApi.quota(),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  const quota = quotaQuery.data;
  /* 额度用尽时直接禁掉最后一步：让用户先看到原因，而不是点完再被拒 */
  const blocked = Boolean(quota && !quota.can_create);

  /* 容器只能装在支持 rootdir 内容的存储上（通常是 local-lvm / local / zfspool） */
  const storageOptions = useMemo(() => {
    const items = (storagesQuery.data ?? []).filter((s) => {
      const content = (s.content ?? '').split(',').map((c) => c.trim());
      return content.includes('rootdir') || content.includes('images');
    });
    return items.map((s) => ({
      label: `${s.storage}（${s.type}）`,
      value: s.storage,
    }));
  }, [storagesQuery.data]);

  const templateOptions = useMemo(
    () =>
      (templatesQuery.data ?? []).map((t) => ({
        label: `${t.name}（${t.storage}）`,
        value: t.volid,
      })),
    [templatesQuery.data],
  );

  const bridgeOptions = useMemo(() => {
    const ifaces = bridgesQuery.data ?? [];
    const bridges = ifaces.filter((i) => i.type === 'bridge' || i.type === 'OVSBridge');
    const list = bridges.length > 0 ? bridges : ifaces;
    return [
      { label: t('lxcWizard.selectBridge'), value: '' },
      ...list.map((i) => ({
        label: `${i.iface}${i.active ? '' : t('lxcWizard.inactive')}`,
        value: i.iface,
      })),
    ];
  }, [bridgesQuery.data, t]);

  /* ---- 步骤导航 ---- */
  const goNext = () => {
    const e = validate(step, form, t);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    if (step < 2) setStep((s) => (s + 1) as StepIndex);
  };

  const goPrev = () => {
    if (step > 0) setStep((s) => (s - 1) as StepIndex);
  };

  /* ---- 提交 ---- */
  const submit = async () => {
    const all: Errors = {
      ...validate(0, form, t),
      ...validate(1, form, t),
      ...validate(2, form, t),
    };
    setErrors(all);
    if (Object.keys(all).length > 0) {
      toast.error(t('lxcWizard.fixErrors'), t('lxcWizard.fixErrorsHint'));
      return;
    }

    const network: LxcCreateNetwork = {
      bridge: form.bridge,
      name: 'eth0',
      ip: form.ip || 'dhcp',
      firewall: form.firewall,
    };
    if (form.gateway) network.gateway = form.gateway;
    if (form.ip6) network.ip6 = form.ip6;
    if (form.vlanTag) network.vlan_tag = Number(form.vlanTag);

    const payload: LxcCreateRequest = {
      node: form.node,
      name: form.name.trim(),
      ostemplate: form.ostemplate,
      storage: form.storage,
      rootfs: form.rootfs,
      memory: form.memory,
      swap: form.swap,
      cores: form.cores,
      unprivileged: form.unprivileged,
      features: form.features,
      networks: [network],
      start_on_boot: form.startOnBoot,
      start: form.start,
    };
    if (form.vmid) payload.vmid = Number(form.vmid);
    if (form.tags.trim()) payload.tags = form.tags.trim();
    if (form.description.trim()) payload.description = form.description.trim();

    const setup: LxcCreateRequest['setup'] = {};
    if (form.password) setup.password = form.password;
    if (form.sshKeys.trim()) setup.ssh_keys = form.sshKeys.trim();
    if (form.nameserver.trim()) setup.nameserver = form.nameserver.trim();
    if (Object.keys(setup).length > 0) payload.setup = setup;

    setSubmitting(true);
    try {
      /* 先拿到创建结果（后端会回自动分配的 VMID），再交给 runner 等后台任务。
         必须带上目标连接：不带的话请求会落到「面板当前连接」，在别人的节点名上
         建容器 —— PVE 会回 hostname lookup 失败。 */
      const created = await lxcApi.create(payload, targetConn);
      await runner.run(Promise.resolve(created), {
        title: t('lxcWizard.createTask', { name: payload.name }),
        node: form.node,
        invalidate: [['vms'], ['lxc'], ['cluster']],
      });
      onCreated?.(created.vmid);
      void queryClient.invalidateQueries({ queryKey: ['vms'] });
      onClose();
    } catch {
      /* toast 已提示 */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('lxcWizard.title')}
      description={t('lxcWizard.desc')}
      size="lg"
      footer={
        /* 快速模式自带提交按钮（在表单末尾），这里不再重复一套 footer */
        mode === 'quick' ? undefined : (
        <div className="wizard-footer">
          {/* 左侧放进度：底部只有两个按钮时整条 footer 会显得很空，
              而「第几步 / 共几步」正是向导里最该一直看得见的信息 */}
          <span className="wizard-footer-step">
            {t('lxcWizard.footerStep', {
              n: step + 1,
              total: steps.length,
              label: steps[step],
            })}
          </span>
          <div className="wizard-footer-actions">
            <Button
              variant="secondary"
              onClick={step === 0 ? onClose : goPrev}
              disabled={submitting}
            >
              {step === 0 ? t('common.cancel') : t('lxcWizard.prev')}
            </Button>
            {step < 2 ? (
              <Button variant="primary" onClick={goNext}>
                {t('lxcWizard.next')}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={submit}
                loading={submitting}
                disabled={blocked}
                title={blocked ? t('lxcWizard.quotaBlocked') : undefined}
              >
                {t('lxcWizard.create')}
              </Button>
            )}
          </div>
        </div>
        )
      }
    >
      {/* ---- 快速 / 自定义：入口只有一个，不必先想清楚该进哪个页面 ---- */}
      <div className="flex items-center gap-12 flex-wrap mb-16">
        <SegmentedControl<CreateMode>
          value={mode}
          onChange={pickMode}
          ariaLabel={t('lxcWizard.modeAria')}
          options={[
            { label: t('lxcWizard.modeQuick'), value: 'quick' },
            { label: t('lxcWizard.modeCustom'), value: 'custom' },
          ]}
        />
        <span className="fs-sm text-muted">
          {mode === 'quick'
            ? t('lxcWizard.modeQuickHint')
            : t('lxcWizard.modeCustomHint', { steps: steps.join(' → ') })}
        </span>
      </div>

      {mode === 'quick' ? (
        /* 快速模式自带提交按钮（在表单末尾），所以上面的 footer 让位 */
        <QuickDeployForm
          open={open}
          kind="lxc"
          onCreated={onCreated}
          onClose={onClose}
          onSwitchToCustom={() => pickMode('custom')}
        />
      ) : (
        <>
      {/* ---- 步骤条 ---- */}
      <div className="wizard-steps" role="list" aria-label={t('lxcWizard.stepsAria')}>
        {steps.map((label, i) => (
          <div
            key={label}
            role="listitem"
            className={`wizard-step ${i === step ? 'is-active' : ''} ${
              i < step ? 'is-done' : ''
            }`}
          >
            <span className="wizard-step-num" aria-hidden="true">
              {i + 1}
            </span>
            <span className="wizard-step-label">{label}</span>
            {i < steps.length - 1 ? (
              <span className={`wizard-connector ${i < step ? 'is-done' : ''}`} aria-hidden="true" />
            ) : null}
          </div>
        ))}
      </div>

      <div className="wizard-body">
        {/* ================= 第 1 步：基本信息 ================= */}
        {step === 0 ? (
          <div className="wizard-section">
            {/* 容器额度：只在管理员设了额度时出现，没设就是不限 */}
            {quota?.limited ? (
              <Notice
                tone={quota.can_create ? 'info' : 'warning'}
                title={
                  quota.can_create
                    ? t('lxcWizard.quotaRemaining', { n: quota.remaining ?? 0 })
                    : t('lxcWizard.quotaExhausted')
                }
              >
                {quota.can_create
                  ? t('lxcWizard.quotaUsed', {
                      quota: quota.quota ?? 0,
                      used: quota.used,
                    })
                  : t('lxcWizard.quotaUsedUp', {
                      quota: quota.quota ?? 0,
                      used: quota.used,
                    })}
                {/* 与虚拟机额度分开记账：说清楚，免得管理员以为被虚拟机占掉了 */}
                {t('lxcWizard.quotaIndependent')}
                {quota.count_error ? (
                  <>
                    {t('lxcWizard.quotaCountError', { err: quota.count_error })}
                  </>
                ) : null}
              </Notice>
            ) : null}

            <div className="wizard-section-title">{t('lxcWizard.sectionNodeName')}</div>
            <div className="form-grid">
              <Select
                label={t('lxcWizard.fieldConn')}
                value={targetConn}
                onChange={(e) => setTargetConn(e.target.value)}
                options={connectionOptions}
                hint={t('lxcWizard.fieldConnHint')}
              />
              <Field
                label={t('lxcWizard.fieldNode')}
                required
                error={errors.node}
                hint={
                  nodesQuery.isError
                    ? errorMessage(nodesQuery.error)
                    : t('lxcWizard.fieldNodeHint')
                }
              >
                <NodePicker
                  nodes={nodesQuery.data ?? []}
                  value={form.node}
                  onChange={(node) => update('node', node)}
                  loading={nodesQuery.isLoading}
                />
              </Field>
              <Input
                label={t('lxcWizard.fieldVmid')}
                hint={t('lxcWizard.fieldVmidHint')}
                value={form.vmid}
                onChange={(e) => update('vmid', e.target.value)}
                error={errors.vmid}
              />
              <Input
                label={t('lxcWizard.fieldName')}
                required
                placeholder={t('lxcWizard.namePlaceholder')}
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                error={errors.name}
              />
              <Input
                label={t('lxcWizard.fieldPassword')}
                type="password"
                hint={t('lxcWizard.fieldPasswordHint')}
                value={form.password}
                onChange={(e) => update('password', e.target.value)}
              />
            </div>

            <div className="wizard-section-title">{t('lxcWizard.sectionTemplate')}</div>
            {templatesQuery.isLoading ? (
              <div className="flex items-center gap-8 fs-sm text-muted">
                <Spinner size={16} label={t('lxcWizard.templatesLoading')} />
                {t('lxcWizard.templatesLoading')}
              </div>
            ) : null}
            {templatesQuery.isError ? (
              <Notice tone="danger" title={t('lxcWizard.templatesError')}>
                {errorMessage(templatesQuery.error)}
              </Notice>
            ) : null}
            {!templatesQuery.isLoading && templateOptions.length === 0 ? (
              <Notice tone="warning" title={t('lxcWizard.templatesEmptyTitle')}>
                {t('lxcWizard.templatesEmptyPre')}
                <code> pveam update && pveam download local debian-12-standard</code>
              </Notice>
            ) : null}
            <Field
              label={t('lxcWizard.fieldTemplate')}
              required
              error={errors.ostemplate}
              hint={t('lxcWizard.fieldTemplateHint')}
            >
              <Select
                value={form.ostemplate}
                onChange={(e) => update('ostemplate', e.target.value)}
                options={[
                  { label: t('lxcWizard.selectTemplate'), value: '' },
                  ...templateOptions,
                ]}
              />
            </Field>
          </div>
        ) : null}

        {/* ================= 第 2 步：资源 ================= */}
        {step === 1 ? (
          <div className="wizard-section">
            <div className="wizard-section-title">{t('lxcWizard.sectionDisk')}</div>
            <div className="form-grid">
              <Select
                label={t('lxcWizard.fieldStorage')}
                required
                value={form.storage}
                onChange={(e) => update('storage', e.target.value)}
                options={[
                  { label: t('lxcWizard.selectStorage'), value: '' },
                  ...storageOptions,
                ]}
                error={errors.storage}
              />
              <Input
                label={t('lxcWizard.fieldRootfs')}
                type="number"
                min={1}
                value={form.rootfs}
                onChange={(e) => update('rootfs', Number(e.target.value) || 0)}
                error={errors.rootfs}
              />
            </div>

            <div className="wizard-section-title">{t('lxcWizard.sectionCompute')}</div>
            <div className="form-grid">
              <Input
                label={t('lxcWizard.fieldMemory')}
                type="number"
                min={16}
                step={128}
                value={form.memory}
                onChange={(e) => update('memory', Number(e.target.value) || 0)}
                error={errors.memory}
              />
              <Input
                label={t('lxcWizard.fieldSwap')}
                type="number"
                min={0}
                step={128}
                value={form.swap}
                onChange={(e) => update('swap', Number(e.target.value) || 0)}
                error={errors.swap}
              />
              <Input
                label={t('lxcWizard.fieldCores')}
                type="number"
                min={1}
                max={128}
                value={form.cores}
                onChange={(e) => update('cores', Number(e.target.value) || 0)}
                error={errors.cores}
              />
            </div>

            <div className="wizard-section-title">{t('lxcWizard.sectionAttrs')}</div>
            <Switch
              checked={form.unprivileged}
              onChange={(v) => update('unprivileged', v)}
              label={t('lxcWizard.unprivileged')}
              hint={t('lxcWizard.unprivilegedHint')}
            />
            <div className="mt-8">
              <div className="field-label">{t('lxcWizard.features')}</div>
              <div className="flex flex-col gap-4 mt-4">
                {featureOptions.map((opt) => (
                  <Checkbox
                    key={opt.value}
                    label={opt.label}
                    checked={form.features.includes(opt.value)}
                    onChange={(e) =>
                      update(
                        'features',
                        e.target.checked
                          ? [...form.features, opt.value]
                          : form.features.filter((f) => f !== opt.value),
                      )
                    }
                  />
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {/* ================= 第 3 步：网络与初始化 ================= */}
        {step === 2 ? (
          <div className="wizard-section">
            <div className="wizard-section-title">{t('lxcWizard.sectionNetwork')}</div>
            <div className="form-grid">
              <Select
                label={t('lxcWizard.fieldBridge')}
                required
                value={form.bridge}
                onChange={(e) => update('bridge', e.target.value)}
                options={bridgeOptions}
                error={errors.bridge}
              />
              <Input
                label="IPv4"
                hint={t('lxcWizard.fieldIpv4Hint')}
                value={form.ip}
                onChange={(e) => update('ip', e.target.value)}
                error={errors.ip}
              />
              <Input
                label={t('lxcWizard.fieldGateway')}
                hint={t('lxcWizard.fieldGatewayHint')}
                value={form.gateway}
                onChange={(e) => update('gateway', e.target.value)}
              />
              <Input
                label="IPv6"
                hint={t('lxcWizard.fieldIpv6Hint')}
                value={form.ip6}
                onChange={(e) => update('ip6', e.target.value)}
              />
              <Input
                label={t('lxcWizard.fieldVlan')}
                type="number"
                min={1}
                max={4094}
                value={form.vlanTag}
                onChange={(e) => update('vlanTag', e.target.value)}
              />
            </div>
            <Switch
              checked={form.firewall}
              onChange={(v) => update('firewall', v)}
              label={t('lxcWizard.enableFirewall')}
              hint={t('lxcWizard.enableFirewallHint')}
            />

            <div className="wizard-section-title">{t('lxcWizard.sectionInit')}</div>
            <Notice tone="info" title={t('lxcWizard.noCloudInitTitle')}>
              {t('lxcWizard.noCloudInitPre')}
              <code> /root/.ssh/authorized_keys</code>
              {t('lxcWizard.noCloudInitPost')}
            </Notice>
            <Field
              label={t('lxcWizard.fieldSshKeys')}
              hint={t('lxcWizard.fieldSshKeysHint')}
            >
              <Textarea
                rows={4}
                placeholder="ssh-rsa AAAAB3NzaC1yc2E…"
                value={form.sshKeys}
                onChange={(e) => update('sshKeys', e.target.value)}
              />
            </Field>
            <Input
              label="DNS"
              hint={t('lxcWizard.fieldDnsHint')}
              value={form.nameserver}
              onChange={(e) => update('nameserver', e.target.value)}
            />
            <Input
              label={t('lxcWizard.fieldTags')}
              hint={t('lxcWizard.fieldTagsHint')}
              value={form.tags}
              onChange={(e) => update('tags', e.target.value)}
            />
            <Field label={t('lxcWizard.fieldDescription')}>
              <Textarea
                rows={2}
                value={form.description}
                onChange={(e) => update('description', e.target.value)}
              />
            </Field>

            <Switch
              checked={form.startOnBoot}
              onChange={(v) => update('startOnBoot', v)}
              label={t('lxcWizard.startOnBoot')}
            />
            <Switch
              checked={form.start}
              onChange={(v) => update('start', v)}
              label={t('lxcWizard.startNow')}
            />
          </div>
        ) : null}
      </div>

      <div className="mt-16 flex items-center gap-8">
        <span className="fs-sm text-muted">
          {t('lxcWizard.footerProgress', { n: step + 1, total: steps.length })}
        </span>
      </div>
        </>
      )}
    </Modal>
  );
}
