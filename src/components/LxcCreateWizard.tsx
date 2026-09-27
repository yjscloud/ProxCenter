/* ==========================================================================
   ProxCenter — 创建 LXC 容器向导
   ==========================================================================

与虚拟机向导刻意**分开**（而不是在 VmCreateWizard 里加分支）：两者的必填项
几乎不重叠 —— 容器要的是「系统模板 + rootfs 容量」而不是「ISO + 磁盘总线」，
初始化靠「root 口令 + SSH 公钥」而不是 cloud-init。硬塞进一个向导会让双方都
冒出一堆条件渲染，改哪边都容易碰坏另一边。

流程：基本信息 → 资源 → 网络与初始化 → 后台任务执行。
*/

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lxcApi, nodesApi, storagesApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Checkbox, Field, Input, Select, Switch, Textarea } from './ui/Input';
import { Notice } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import { useToast } from '../hooks/useToast';
import { useTaskRunner } from '../hooks/useTaskRunner';
import type { LxcCreateNetwork, LxcCreateRequest } from '../api/types';

const STEPS = ['基本信息', '资源', '网络与初始化'] as const;
type StepIndex = 0 | 1 | 2;

/** 容器可选特性。nesting 用来在容器里跑 Docker，keyctl 是它的常见搭档。 */
const FEATURE_OPTIONS = [
  { value: 'nesting', label: 'nesting（容器内再跑容器 / Docker）' },
  { value: 'keyctl', label: 'keyctl（内核密钥环，常与 nesting 一起开）' },
  { value: 'fuse', label: 'fuse（用户态文件系统）' },
] as const;

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

function validate(step: StepIndex, f: FormState): Errors {
  const e: Errors = {};
  if (step === 0) {
    if (!f.node) e.node = '请选择节点';
    if (!f.name.trim()) e.name = '请输入容器名称';
    else if (f.name.length > 63) e.name = '名称不能超过 63 个字符';
    if (f.vmid && !/^\d+$/.test(f.vmid)) e.vmid = 'VMID 只能是数字';
    if (!f.ostemplate) e.ostemplate = '请选择系统模板';
  }
  if (step === 1) {
    if (!f.storage) e.storage = '请选择存储池';
    if (f.rootfs < 1) e.rootfs = 'rootfs 至少 1 GB';
    if (f.memory < 16) e.memory = '内存至少 16 MB';
    if (f.cores < 1) e.cores = '核心数至少 1';
    if (f.swap < 0) e.swap = 'swap 不能为负';
  }
  if (step === 2) {
    if (!f.bridge) e.bridge = '请选择网桥';
    if (f.ip && f.ip !== 'dhcp' && f.ip !== 'manual' && !f.ip.includes('/')) {
      e.ip = '静态地址请写成 CIDR 形式，如 192.168.1.50/24';
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
  const toast = useToast();
  const runner = useTaskRunner();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<StepIndex>(0);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  /* 每次打开都从干净状态开始 */
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setForm(INITIAL);
    setErrors({});
  }, [open]);

  /* ---- 基础数据 ---- */
  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: () => nodesApi.list(),
    enabled: open,
    staleTime: 60_000,
  });

  /* 节点列表回来后默认选第一个，省掉一次必点的下拉 */
  useEffect(() => {
    if (!open || form.node) return;
    const first = (nodesQuery.data ?? [])[0]?.node;
    if (first) setForm((prev) => ({ ...prev, node: first }));
  }, [open, nodesQuery.data, form.node]);

  const templatesQuery = useQuery({
    queryKey: ['lxc-templates', form.node],
    queryFn: () => lxcApi.templates(form.node),
    enabled: open && Boolean(form.node),
    staleTime: 60_000,
  });

  const storagesQuery = useQuery({
    queryKey: ['storages', 'lxc', form.node || 'all'],
    queryFn: () => storagesApi.list(form.node || undefined),
    enabled: open,
    staleTime: 60_000,
  });

  const bridgesQuery = useQuery({
    queryKey: ['nodes', form.node, 'network'],
    queryFn: () => nodesApi.network(form.node),
    enabled: open && Boolean(form.node),
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

  const nodeOptions = useMemo(
    () => (nodesQuery.data ?? []).map((n) => ({ label: n.node, value: n.node })),
    [nodesQuery.data],
  );

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
      { label: '请选择网桥', value: '' },
      ...list.map((i) => ({
        label: `${i.iface}${i.active ? '' : '（未激活）'}`,
        value: i.iface,
      })),
    ];
  }, [bridgesQuery.data]);

  /* ---- 步骤导航 ---- */
  const goNext = () => {
    const e = validate(step, form);
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
      ...validate(0, form),
      ...validate(1, form),
      ...validate(2, form),
    };
    setErrors(all);
    if (Object.keys(all).length > 0) {
      toast.error('请先修正表单中的错误', '仍有必填项未填写');
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
      /* 先拿到创建结果（后端会回自动分配的 VMID），再交给 runner 等后台任务 */
      const created = await lxcApi.create(payload);
      await runner.run(Promise.resolve(created), {
        title: `创建容器「${payload.name}」`,
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
      title="创建容器（LXC）"
      description="容器比虚拟机更轻，适合跑服务；系统模板需先放到节点的 vztmpl 存储"
      size="lg"
      footer={
        <div className="wizard-footer">
          {/* 左侧放进度：底部只有两个按钮时整条 footer 会显得很空，
              而「第几步 / 共几步」正是向导里最该一直看得见的信息 */}
          <span className="wizard-footer-step">
            第 {step + 1} / {STEPS.length} 步 · {STEPS[step]}
          </span>
          <div className="wizard-footer-actions">
            <Button
              variant="secondary"
              onClick={step === 0 ? onClose : goPrev}
              disabled={submitting}
            >
              {step === 0 ? '取消' : '上一步'}
            </Button>
            {step < 2 ? (
              <Button variant="primary" onClick={goNext}>
                下一步
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={submit}
                loading={submitting}
                disabled={blocked}
                title={blocked ? '可下发容器数量已用尽，请联系管理员' : undefined}
              >
                创建容器
              </Button>
            )}
          </div>
        </div>
      }
    >
      {/* ---- 步骤条 ---- */}
      <div className="wizard-steps" role="list" aria-label="创建步骤">
        {STEPS.map((label, i) => (
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
            {i < STEPS.length - 1 ? (
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
                    ? `还可下发 ${quota.remaining ?? 0} 个容器`
                    : '可下发容器数量已用尽'
                }
              >
                {quota.can_create
                  ? `容器额度 ${quota.quota ?? 0} 个，当前已有 ${quota.used} 个`
                  : `容器额度 ${quota.quota ?? 0} 个，当前 ${quota.used} 个，已无法再创建，请联系管理员`}
                {/* 与虚拟机额度分开记账：说清楚，免得管理员以为被虚拟机占掉了 */}
                。与虚拟机额度相互独立，互不占用。
                {quota.count_error ? (
                  <>（部分 PVE 连接读取失败：{quota.count_error}）</>
                ) : null}
              </Notice>
            ) : null}

            <div className="wizard-section-title">节点与名称</div>
            <div className="form-grid">
              <Select
                label="节点"
                required
                value={form.node}
                onChange={(e) => update('node', e.target.value)}
                options={[{ label: '请选择节点', value: '' }, ...nodeOptions]}
                error={errors.node}
              />
              <Input
                label="VMID"
                hint="留空自动取下一个可用 ID"
                value={form.vmid}
                onChange={(e) => update('vmid', e.target.value)}
                error={errors.vmid}
              />
              <Input
                label="容器名称"
                required
                placeholder="如 web-01"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                error={errors.name}
              />
              <Input
                label="root 口令"
                type="password"
                hint="留空则只能用控制台（或已注入的 SSH 公钥）登录"
                value={form.password}
                onChange={(e) => update('password', e.target.value)}
              />
            </div>

            <div className="wizard-section-title">系统模板</div>
            {templatesQuery.isLoading ? (
              <div className="flex items-center gap-8 fs-sm text-muted">
                <Spinner size={16} label="正在读取模板列表" />
                正在读取模板列表…
              </div>
            ) : null}
            {templatesQuery.isError ? (
              <Notice tone="danger" title="无法读取容器模板">
                {errorMessage(templatesQuery.error)}
              </Notice>
            ) : null}
            {!templatesQuery.isLoading && templateOptions.length === 0 ? (
              <Notice tone="warning" title="该节点没有可用的容器模板">
                请先在「存储」页上传，或在节点上执行
                <code> pveam update && pveam download local debian-12-standard</code>
              </Notice>
            ) : null}
            <Field label="系统模板" required error={errors.ostemplate} hint="来自节点上内容类型含 vztmpl 的存储">
              <Select
                value={form.ostemplate}
                onChange={(e) => update('ostemplate', e.target.value)}
                options={[{ label: '请选择模板', value: '' }, ...templateOptions]}
              />
            </Field>
          </div>
        ) : null}

        {/* ================= 第 2 步：资源 ================= */}
        {step === 1 ? (
          <div className="wizard-section">
            <div className="wizard-section-title">系统盘</div>
            <div className="form-grid">
              <Select
                label="存储池"
                required
                value={form.storage}
                onChange={(e) => update('storage', e.target.value)}
                options={[{ label: '请选择存储池', value: '' }, ...storageOptions]}
                error={errors.storage}
              />
              <Input
                label="rootfs 容量（GB）"
                type="number"
                min={1}
                value={form.rootfs}
                onChange={(e) => update('rootfs', Number(e.target.value) || 0)}
                error={errors.rootfs}
              />
            </div>

            <div className="wizard-section-title">计算资源</div>
            <div className="form-grid">
              <Input
                label="内存（MB）"
                type="number"
                min={16}
                step={128}
                value={form.memory}
                onChange={(e) => update('memory', Number(e.target.value) || 0)}
                error={errors.memory}
              />
              <Input
                label="Swap（MB）"
                type="number"
                min={0}
                step={128}
                value={form.swap}
                onChange={(e) => update('swap', Number(e.target.value) || 0)}
                error={errors.swap}
              />
              <Input
                label="CPU 核心数"
                type="number"
                min={1}
                max={128}
                value={form.cores}
                onChange={(e) => update('cores', Number(e.target.value) || 0)}
                error={errors.cores}
              />
            </div>

            <div className="wizard-section-title">容器属性</div>
            <Switch
              checked={form.unprivileged}
              onChange={(v) => update('unprivileged', v)}
              label="非特权容器"
              hint="推荐。容器内的 root 映射到宿主机的普通用户，逃逸风险更低；要挂 NFS / 用某些设备时才需要关闭"
            />
            <div className="mt-8">
              <div className="field-label">特性（features）</div>
              <div className="flex flex-col gap-4 mt-4">
                {FEATURE_OPTIONS.map((opt) => (
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
            <div className="wizard-section-title">网络</div>
            <div className="form-grid">
              <Select
                label="网桥"
                required
                value={form.bridge}
                onChange={(e) => update('bridge', e.target.value)}
                options={bridgeOptions}
                error={errors.bridge}
              />
              <Input
                label="IPv4"
                hint="dhcp 或静态地址（192.168.1.50/24）；manual 表示只配链路"
                value={form.ip}
                onChange={(e) => update('ip', e.target.value)}
                error={errors.ip}
              />
              <Input
                label="IPv4 网关"
                hint="静态地址时必填"
                value={form.gateway}
                onChange={(e) => update('gateway', e.target.value)}
              />
              <Input
                label="IPv6"
                hint="留空不配；dhcp / auto 或静态地址"
                value={form.ip6}
                onChange={(e) => update('ip6', e.target.value)}
              />
              <Input
                label="VLAN Tag"
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
              label="启用防火墙"
              hint="网卡上打开 firewall=1；规则本身要在「防火墙」页配"
            />

            <div className="wizard-section-title">初始化</div>
            <Notice tone="info" title="容器没有 cloud-init">
              用户名固定为 root。要免密登录就把公钥贴在下面 —— 会写进容器内的
              <code> /root/.ssh/authorized_keys</code>。
            </Notice>
            <Field label="SSH 公钥" hint="支持多行粘贴，一行一个">
              <Textarea
                rows={4}
                placeholder="ssh-rsa AAAAB3NzaC1yc2E…"
                value={form.sshKeys}
                onChange={(e) => update('sshKeys', e.target.value)}
              />
            </Field>
            <Input
              label="DNS"
              hint="留空则套用面板默认 DNS"
              value={form.nameserver}
              onChange={(e) => update('nameserver', e.target.value)}
            />
            <Input
              label="标签"
              hint="分号或逗号分隔"
              value={form.tags}
              onChange={(e) => update('tags', e.target.value)}
            />
            <Field label="描述">
              <Textarea
                rows={2}
                value={form.description}
                onChange={(e) => update('description', e.target.value)}
              />
            </Field>

            <Switch
              checked={form.startOnBoot}
              onChange={(v) => update('startOnBoot', v)}
              label="开机自启"
            />
            <Switch
              checked={form.start}
              onChange={(v) => update('start', v)}
              label="创建后立即启动"
            />
          </div>
        ) : null}
      </div>

      <div className="mt-16 flex items-center gap-8">
        <span className="fs-sm text-muted">
          步骤 {step + 1} / {STEPS.length}
        </span>
      </div>
    </Modal>
  );
}
