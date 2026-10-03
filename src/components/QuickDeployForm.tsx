/* ==========================================================================
   ProxCenter — 快速部署表单

   原来这是一个独立页面（/deploy，侧边栏「快速部署」）。但「部署」和「创建」
   本来就是同一件事的两种做法：一页下单适合标准机器，六步向导适合要调 NUMA /
   PCI 直通 / 多网卡多磁盘的机器。做成两个入口后，用户得先想清楚「我该进哪个
   页面」—— 而这个问题本身就不该存在。

   现在它内嵌在「创建虚拟机」与「创建容器」的同一个弹窗里，顶部一个
   「快速部署 / 自定义部署」开关切换，入口只有一个。

   顺序按运维的实际填写习惯排：**先起名，再选规格与位置，最后选镜像与网络**。
   规格由管理员在「设置 → 资源规格」里定义，用户不必自己算核数与内存。

   两个刻意的固定做法：

   * **链接克隆**：快速部署只做链接克隆 —— 秒级完成、不额外占空间，是「标准
     机器」的常态；要独立磁盘请走「自定义部署」。正因如此，虚拟机的「存储」
     在这里不出现：链接克隆不往任何存储写数据，摆一个必填的下拉框只会让人
     以为必须选。
   * **静态 IP**：绝大多数机器要固定地址，所以默认静态，并从「网络 → IP 地址池」
     里自动挑一个空闲地址（可改）。池子为空时退回 DHCP，而不是让用户卡在
     一个选不出东西的下拉框前。

   刻意**不做**新的后端下单接口：规格在这里被翻译成现有的 POST /api/vms 与
   POST /api/lxc 入参，配额判定、归属记录、创建时间、审计这些都已经在那条
   链路上跑通了，另起一条只会让两边的行为慢慢分叉。

   客户机类型（虚拟机 / 容器）由外层向导决定，本组件不再自选 —— 用户点的就是
   「创建虚拟机」或「创建容器」。
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  configApi,
  connectionsApi,
  ipPoolsApi,
  lxcApi,
  nodesApi,
  storagesApi,
  templatesApi,
  vmsApi,
} from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Card, CardHeader } from './ui/Card';
import { Button } from './ui/Button';
import {
  Field,
  Input,
  SegmentedControl,
  Select,
  Switch,
} from './ui/Input';
import { Notice } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import { NodePicker } from './NodePicker';
import { IconCloud } from './Icons';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n';
import { formatBytes } from '../utils/format';
import type { VmCreateRequest } from '../api/types';

/** 客户机类型：与向导的 kind 对齐（qemu = 虚拟机，lxc = 容器） */
export type QuickDeployKind = 'qemu' | 'lxc';

type IpMode = 'dhcp' | 'static';

/** GB → MB（规格里存 MB，界面上说 GB） */
const gb = (mb: number) => Math.round(mb / 1024);

export interface QuickDeployFormProps {
  /** 弹窗是否打开：关闭时停掉所有取数，打开时把表单重置为干净状态 */
  open: boolean;
  /** 由外层向导决定，本组件不再自选类型 */
  kind: QuickDeployKind;
  /** 创建成功（拿得到 VMID 时带上） */
  onCreated?: (vmid: number) => void;
  /** 取消 / 关闭弹窗 */
  onClose: () => void;
  /** 切到同弹窗里的自定义向导 */
  onSwitchToCustom: () => void;
}

export function QuickDeployForm({
  open,
  kind,
  onCreated,
  onClose,
  onSwitchToCustom,
}: QuickDeployFormProps) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('vm.create');
  const isVm = kind === 'qemu';

  /* ---- 选择项 ---- */
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const [specId, setSpecId] = useState('');
  /** 内存气球的最低保留量（MB），'' = 不下发该键（PVE 默认，不回收） */
  const [balloon, setBalloon] = useState('');
  const [targetConn, setTargetConn] = useState('');
  const [node, setNode] = useState('');
  const [templateRef, setTemplateRef] = useState(''); // "node/vmid"
  const [osTemplate, setOsTemplate] = useState('');
  const [storage, setStorage] = useState('');
  const [bridge, setBridge] = useState('');
  /* 默认静态：机器一般要固定地址；网段与地址由下面的 effect 自动挑 */
  const [ipMode, setIpMode] = useState<IpMode>('static');
  const [poolId, setPoolId] = useState('');
  const [staticIp, setStaticIp] = useState('');
  const [gateway, setGateway] = useState('');
  const [ciUser, setCiUser] = useState('root');
  const [password, setPassword] = useState('');
  /* 接入安全管控：把面板公钥写进 cloud-init，机器起来后自动登记为受管主机。
     与「自定义部署」向导里的那个开关同一套后端能力。 */
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState(false);

  /** 用户自己点过 IP 获取方式：之后不再被「有没有可用网段」的自动判断覆盖 */
  const ipModeTouchedRef = useRef(false);
  const pickIpMode = (next: IpMode) => {
    ipModeTouchedRef.current = true;
    setIpMode(next);
  };

  /* 每次打开都从干净状态开始：弹窗关闭时组件并没有卸载，残留的字段会带到下一台 */
  useEffect(() => {
    if (!open) return;
    setName('');
    setTags('');
    setSpecId('');
    setBalloon('');
    setNode('');
    setTemplateRef('');
    setOsTemplate('');
    setStorage('');
    setBridge('');
    setIpMode('static');
    setPoolId('');
    setStaticIp('');
    setGateway('');
    setCiUser('root');
    setPassword('');
    setManage(false);
    ipModeTouchedRef.current = false;
    /* targetConn 不清：保留上次选的主机（多台 PVE 时省一次选择），下面那个
       effect 只在它为空时兜底选当前连接 */
  }, [open]);

  /* ---- 数据 ---- */
  const specsQuery = useQuery({
    queryKey: ['config', 'specs'],
    queryFn: configApi.getSpecs,
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  /* 目标主机列表只有管理员拿得到（/connections 需要 settings.manage）；
     普通用户用面板当前连接 —— 单台 PVE 的面板上本来就该是这样 */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  const nodesQuery = useQuery({
    queryKey: ['nodes', targetConn],
    queryFn: () => nodesApi.list(targetConn),
    enabled: open,
    staleTime: 60_000,
  });

  /* 只有容器需要选存储（建 rootfs）：虚拟机的链接克隆不写任何存储，别白读一次 */
  const storagesQuery = useQuery({
    queryKey: ['storages', targetConn, node || 'all'],
    queryFn: () => storagesApi.list(node || undefined, targetConn),
    enabled: open && !isVm && Boolean(node),
    staleTime: 60_000,
  });

  const bridgesQuery = useQuery({
    queryKey: ['nodes', targetConn, node, 'network'],
    queryFn: () => nodesApi.network(node, targetConn),
    enabled: open && Boolean(node),
    staleTime: 60_000,
    retry: false,
  });

  /* 只列虚拟机模板：快速部署固定「从模板克隆」（容器走系统模板） */
  const templatesQuery = useQuery({
    queryKey: ['templates', 'all', targetConn],
    queryFn: () => templatesApi.list(targetConn, 'qemu'),
    enabled: open && isVm,
    staleTime: 30_000,
  });

  const osTemplatesQuery = useQuery({
    queryKey: ['lxc', 'templates', targetConn, node],
    queryFn: () => lxcApi.templates(node, targetConn),
    enabled: open && !isVm && Boolean(node),
    staleTime: 60_000,
    retry: false,
  });

  const poolsQuery = useQuery({
    queryKey: ['ip-pools'],
    queryFn: ipPoolsApi.get,
    enabled: open && ipMode === 'static',
    staleTime: 30_000,
    retry: false,
  });

  const quotaQuery = useQuery({
    queryKey: [isVm ? 'vms' : 'lxc', 'quota'],
    queryFn: isVm ? vmsApi.quota : lxcApi.quota,
    enabled: open,
  });

  /* ---- 派生 ---- */
  const specs = useMemo(
    () =>
      (specsQuery.data?.specs ?? []).filter(
        (s) => s.kind === (isVm ? 'vm' : 'lxc') || s.kind === 'both',
      ),
    [specsQuery.data, isVm],
  );
  const spec = specs.find((s) => s.id === specId);

  const connectionOptions = useMemo(() => {
    const list = connectionsQuery.data ?? [];
    if (list.length === 0) return [];
    return list.map((c) => ({
      label: `${c.name || c.host}${
        c.active ? t('quickDeploy.currentConn') : ''
      } · ${c.host}`,
      value: c.id,
    }));
  }, [connectionsQuery.data, t]);

  /* 默认落在「当前连接」上：不指定连接时后端会把所有 PVE 的节点合并返回 */
  useEffect(() => {
    if (!open || targetConn) return;
    const list = connectionsQuery.data ?? [];
    const active = list.find((c) => c.active) ?? list[0];
    if (active) setTargetConn(active.id);
  }, [open, targetConn, connectionsQuery.data]);

  /* 换主机：节点、存储、模板都不通用，全部清掉重选 */
  useEffect(() => {
    setNode('');
    setStorage('');
    setTemplateRef('');
    setOsTemplate('');
  }, [targetConn]);

  /* 换节点：节点名不通用，存储与模板也跟着变 */
  useEffect(() => {
    setStorage('');
    setOsTemplate('');
  }, [node]);

  /* 网桥默认取节点上的第一个（通常是 vmbr0） */
  useEffect(() => {
    if (bridge) return;
    const bridgesOnly = (bridgesQuery.data ?? []).filter((i) => i.type === 'bridge');
    const first = bridgesOnly.find((b) => b.iface?.startsWith('vmbr')) ?? bridgesOnly[0];
    if (first?.iface) setBridge(first.iface);
  }, [bridge, bridgesQuery.data]);

  /* 存储默认：容器建 rootfs 要 rootdir 存储 */
  useEffect(() => {
    if (isVm || storage) return;
    const first = (storagesQuery.data ?? []).find(
      (s) => s.active && s.content.split(/[,;]/).some((c) => c.trim() === 'rootdir'),
    );
    if (first) setStorage(first.storage);
  }, [storage, storagesQuery.data, isVm]);

  /* 可选网段：只列与当前网桥一致的池（不同网桥的池选了也不通） */
  const usablePools = useMemo(() => {
    const pools = poolsQuery.data?.pools ?? [];
    return bridge ? pools.filter((p) => !p.bridge || p.bridge === bridge) : pools;
  }, [poolsQuery.data, bridge]);

  const poolOptions = useMemo(
    () => [
      { label: t('quickDeploy.selectPool'), value: '' },
      ...usablePools.map((p) => ({
        label: t('quickDeploy.poolOption', {
          name: p.name,
          subnet: p.subnet,
          n: p.free_count,
        }),
        value: p.id,
      })),
    ],
    [usablePools, t],
  );

  /* 没选网段（或所选网段已不适用，例如换了网桥）时自动挑一个：用户不必先知道
     「哪台机器的 IP 池在哪」。挑完由下一个 effect 填具体地址。 */
  useEffect(() => {
    if (!open || ipMode !== 'static' || !poolsQuery.data) return;
    if (usablePools.some((p) => p.id === poolId)) return;
    const first = usablePools.find((p) => p.free_count > 0) ?? usablePools[0];
    if (!first) return;
    setPoolId(first.id);
    setStaticIp('');
  }, [open, ipMode, poolId, usablePools, poolsQuery.data]);

  /* 选好网段但还没填地址：取该网段的第一个空闲地址，用户仍可改 */
  useEffect(() => {
    if (ipMode !== 'static' || staticIp || !poolId) return;
    const pool = (poolsQuery.data?.pools ?? []).find((p) => p.id === poolId);
    const next = pool?.free?.[0];
    if (!next) return;
    setStaticIp(next);
    if (pool?.gateway) setGateway(pool.gateway);
  }, [ipMode, staticIp, poolId, poolsQuery.data]);

  /* 一个可用网段都没有（没配 IP 池、或池已满）：静态无从选起，退回 DHCP，
     而不是让用户对着空下拉框找原因。用户手动选过静态就不再干预。 */
  useEffect(() => {
    if (!open || ipModeTouchedRef.current || ipMode !== 'static') return;
    if (!poolsQuery.data) return;
    if (usablePools.length === 0) setIpMode('dhcp');
  }, [open, ipMode, poolsQuery.data, usablePools]);

  const quota = quotaQuery.data;
  const quotaBlocked = Boolean(quota && !quota.can_create);

  const templateOptions = useMemo(() => {
    const list = (templatesQuery.data ?? []).filter(
      (t) => !targetConn || !t.connection_id || t.connection_id === targetConn,
    );
    return [
      { label: t('quickDeploy.selectTemplate'), value: '' },
      ...list.map((tpl) => ({
        label: `${t('quickDeploy.templateOption', {
          name: tpl.name,
          vmid: tpl.vmid,
          node: tpl.node,
        })}${
          tpl.maxdisk
            ? t('quickDeploy.diskSuffix', {
                size: formatBytes(tpl.maxdisk, 0),
              })
            : ''
        }`,
        value: `${tpl.node}/${tpl.vmid}`,
      })),
    ];
  }, [templatesQuery.data, targetConn, t]);

  const osTemplateOptions = useMemo(
    () => [
      { label: t('quickDeploy.selectOsTemplate'), value: '' },
      ...(osTemplatesQuery.data ?? []).map((tpl) => ({
        label: `${tpl.name}${
          tpl.size ? `（${formatBytes(tpl.size, 0)}）` : ''
        }`,
        value: tpl.volid,
      })),
    ],
    [osTemplatesQuery.data, t],
  );

  const storageOptions = useMemo(() => {
    const want = isVm ? 'images' : 'rootdir';
    return [
      { label: t('quickDeploy.selectStorage'), value: '' },
      ...(storagesQuery.data ?? [])
        .filter(
          (s) => s.active && s.content.split(/[,;]/).some((c) => c.trim() === want),
        )
        .map((s) => ({
          label: t('quickDeploy.storageOption', {
            name: s.storage,
            type: s.type,
            avail: formatBytes(s.avail, 0),
          }),
          value: s.storage,
        })),
    ];
  }, [storagesQuery.data, isVm, t]);

  const bridgeOptions = useMemo(
    () =>
      (bridgesQuery.data ?? [])
        .filter((i) => i.type === 'bridge' && i.iface)
        .map((i) => ({ label: i.iface, value: i.iface })),
    [bridgesQuery.data],
  );

  /* 虚拟机的链接克隆不往任何存储写数据（磁盘留在模板所在存储），所以只有容器
     建 rootfs 时才需要选存储 */
  const storageNeeded = !isVm;

  const error = useMemo(() => {
    if (!name.trim()) return t('quickDeploy.errName');
    if (!spec) return t('quickDeploy.errSpec');
    /* 内存气球：留空 = 不回收（不下发该键）；填了就必须低于规格的内存上限 */
    if (balloon.trim()) {
      const value = Number(balloon);
      if (!Number.isFinite(value) || value < 0) {
        return t('quickDeploy.errBalloonInt');
      } else if (value > 0 && value < 128) {
        return t('quickDeploy.errBalloonMin');
      } else if (value > 0 && value >= spec.memory) {
        return t('quickDeploy.errBalloonMax');
      }
    }
    if (!node) return t('quickDeploy.errNode');
    if (isVm && !templateRef) return t('quickDeploy.errTemplate');
    if (!isVm && !osTemplate) return t('quickDeploy.errOsTemplate');
    if (storageNeeded && !storage) return t('quickDeploy.errStorage');
    if (ipMode === 'static' && !staticIp.trim()) return t('quickDeploy.errStaticIp');
    if (quotaBlocked) {
      return t('quickDeploy.errQuota', {
        label: quota?.label ?? t('quickDeploy.quotaFallback'),
      });
    }
    return '';
  }, [
    name,
    spec,
    balloon,
    node,
    isVm,
    templateRef,
    osTemplate,
    storageNeeded,
    storage,
    ipMode,
    staticIp,
    quotaBlocked,
    quota,
    t,
  ]);

  const submit = async () => {
    if (!spec || error || !canCreate) return;
    setBusy(true);
    try {
      /* 静态时补 /24（云镜像默认掩码），网关留空就交给 DHCP/RA —— 后端对空
         网关不下发 gw=，与面板其它地方一致 */
      const ipConfig =
        ipMode === 'static'
          ? {
              ip: staticIp.includes('/') ? staticIp : `${staticIp}/24`,
              gateway: gateway || '',
            }
          : { ip: 'dhcp', gateway: '' };

      if (isVm) {
        const [tplNode, tplVmid] = templateRef.split('/');
        const payload: VmCreateRequest = {
          node,
          /* 0 = 交给后端取下一个可用 VMID（PVE 的 VMID 空间每台主机各自独立） */
          vmid: 0,
          name: name.trim(),
          memory: spec.memory,
          cores: spec.cores,
          sockets: 1,
          /* 留空就不下发：PVE 默认按整份内存算，宿主机收不回空闲内存 */
          balloon: balloon.trim() ? Number(balloon) : undefined,
          disks: [],
          networks: [{ bridge, model: 'virtio' }],
          tags: tags || undefined,
          cloudinit: {
            enabled: true,
            user: ciUser || 'root',
            password: password || undefined,
            ip_configs: [ipConfig],
          },
          manage,
          clone_from: {
            node: tplNode,
            vmid: Number(tplVmid),
            /* 固定链接克隆：磁盘与新盘都留在模板所在存储，秒级完成、不额外占空间。
               需要独立磁盘（完整克隆）请用「自定义部署」。 */
            full: false,
          },
        };
        const result = await vmsApi.create(payload, targetConn);
        toast.success(
          t('quickDeploy.created'),
          t('quickDeploy.createdVmHint', { vmid: result.vmid ?? '-' }),
        );
        queryClient.invalidateQueries({ queryKey: ['vms'] });
        onCreated?.(result.vmid ?? 0);
        onClose();
      } else {
        const result = await lxcApi.create(
          {
            node,
            ostemplate: osTemplate,
            storage,
            name: name.trim(),
            rootfs: spec.disk,
            memory: spec.memory,
            /* 交换分区沿用后端默认量级：容器很少需要单独调它 */
            swap: 512,
            cores: spec.cores,
            unprivileged: true,
            start: true,
            tags: tags || undefined,
            networks: [
              {
                name: 'eth0',
                bridge,
                ip: ipMode === 'static' ? ipConfig.ip : 'dhcp',
                gateway: ipMode === 'static' ? gateway || undefined : undefined,
                firewall: true,
              },
            ],
            setup: {
              password: password || undefined,
            },
          },
          targetConn,
        );
        toast.success(
          t('quickDeploy.created'),
          t('quickDeploy.createdLxcHint', { vmid: result.vmid ?? '-' }),
        );
        queryClient.invalidateQueries({ queryKey: ['lxc'] });
        onCreated?.(result.vmid ?? 0);
        onClose();
      }
    } catch (err) {
      toast.error(t('quickDeploy.createFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const summary = spec
    ? t('quickDeploy.summary', {
        cores: spec.cores,
        mem: gb(spec.memory),
        disk: isVm
          ? t('quickDeploy.summaryVm')
          : t('quickDeploy.summaryLxc', { n: spec.disk }),
      })
    : '';

  return (
    <div className="wizard-body">
      <div className="wizard-section">
        {!canCreate ? (
          <Notice tone="warning" title={t('quickDeploy.noPermTitle')}>
            {t('quickDeploy.noPermBody')}
          </Notice>
        ) : null}

        {quotaBlocked ? (
          <Notice
            tone="warning"
            title={t('quickDeploy.quotaBlockedTitle', {
              label: quota?.label ?? '',
            })}
          >
            {t('quickDeploy.quotaBlockedBody', {
              used: quota?.used,
              quota: quota?.quota,
            })}
          </Notice>
        ) : null}

        {!specsQuery.isLoading && specs.length === 0 ? (
          <Notice tone="info" title={t('quickDeploy.noSpecTitle')}>
            {t('quickDeploy.noSpecPre')}{' '}
            <button type="button" className="link-button" onClick={onSwitchToCustom}>
              {t('quickDeploy.noSpecCustom')}
            </button>
            {t('quickDeploy.noSpecPost')}
          </Notice>
        ) : null}

        {/* ---- 1. 实例名称 ---- */}
        <Card>
          <CardHeader
            title={t('quickDeploy.sectionName')}
            subtitle={
              isVm
                ? t('quickDeploy.nameSubtitleVm')
                : t('quickDeploy.nameSubtitleLxc')
            }
          />
          <div className="form-grid-2">
            <Input
              label={t('quickDeploy.labelName')}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                isVm
                  ? t('quickDeploy.namePlaceholderVm')
                  : t('quickDeploy.namePlaceholderLxc')
              }
            />
            <Input
              label={t('quickDeploy.labelTags')}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t('quickDeploy.tagsPlaceholder')}
            />
          </div>
        </Card>

        {/* ---- 2. 资源规格 ---- */}
        <Card>
          <CardHeader
            title={t('quickDeploy.sectionSpec')}
            subtitle={t('quickDeploy.specSubtitle')}
          />
          {specsQuery.isLoading ? (
            <Spinner />
          ) : specs.length === 0 ? (
            /* 空态已在上面用 Notice 说明；这里不重复占位 */
            null
          ) : (
            <div className="spec-cards">
              {specs.map((item) => {
                const selected = item.id === specId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`spec-card ${selected ? 'is-selected' : ''}`}
                    aria-pressed={selected}
                    onClick={() => setSpecId(item.id)}
                  >
                    <span className="spec-card-name">{item.name}</span>
                    <span className="spec-card-spec">
                      <b>{item.cores}</b> {t('quickDeploy.specUnitCores')} ·{' '}
                      <b>{gb(item.memory)}</b> {t('quickDeploy.specUnitMem')} ·{' '}
                      <b>{item.disk}</b> {t('quickDeploy.specUnitDisk')}
                    </span>
                    {item.description ? (
                      <span className="spec-card-desc">{item.description}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}

          {/* 内存气球：PVE 没有这个键时按整份内存算，宿主机收不回客户机的空闲内存。
              留空保持原行为，填了才有回收空间。容器没有气球，只给虚拟机。 */}
          {isVm ? (
            <div className="form-grid-2 mt-12">
              <Input
                label={t('quickDeploy.labelBalloon')}
                type="number"
                min={0}
                step={256}
                value={balloon}
                onChange={(e) => setBalloon(e.target.value)}
                hint={t('quickDeploy.balloonHint')}
              />
            </div>
          ) : null}
        </Card>

        {/* ---- 3. 部署位置 ---- */}
        <Card>
          <CardHeader
            title={t('quickDeploy.sectionLocation')}
            subtitle={t('quickDeploy.locationSubtitle')}
          />
          {connectionOptions.length > 0 ? (
            <div className="form-grid-2">
              <Select
                label={t('quickDeploy.labelConn')}
                value={targetConn}
                onChange={(e) => setTargetConn(e.target.value)}
                options={connectionOptions}
                hint={t('quickDeploy.connHint')}
              />
            </div>
          ) : null}
          <Field
            label={t('quickDeploy.labelNode')}
            required
            error={nodesQuery.isError ? t('quickDeploy.nodeError') : undefined}
            hint={nodesQuery.isError ? errorMessage(nodesQuery.error) : undefined}
          >
            <NodePicker
              nodes={nodesQuery.data ?? []}
              value={node}
              onChange={setNode}
              loading={nodesQuery.isLoading}
            />
          </Field>
        </Card>

        {/* ---- 4. 系统镜像 ---- */}
        <Card>
          <CardHeader
            title={t('quickDeploy.sectionImage')}
            subtitle={
              isVm
                ? t('quickDeploy.imageSubtitleVm')
                : t('quickDeploy.imageSubtitleLxc')
            }
          />
          <div className="form-grid-2">
            {isVm ? (
              <Select
                label={t('quickDeploy.labelTemplate')}
                required
                value={templateRef}
                onChange={(e) => setTemplateRef(e.target.value)}
                options={templateOptions}
                hint={
                  templatesQuery.isError
                    ? errorMessage(templatesQuery.error)
                    : t('quickDeploy.templateHint')
                }
              />
            ) : (
              <Select
                label={t('quickDeploy.labelOsTemplate')}
                required
                value={osTemplate}
                onChange={(e) => setOsTemplate(e.target.value)}
                options={osTemplateOptions}
                hint={
                  osTemplatesQuery.isError
                    ? errorMessage(osTemplatesQuery.error)
                    : t('quickDeploy.osTemplateHint')
                }
              />
            )}

            {/* 容器建 rootfs 必须选存储；虚拟机的链接克隆不往任何存储写数据 */}
            {storageNeeded ? (
              <Select
                label={t('quickDeploy.labelStorage')}
                required
                value={storage}
                onChange={(e) => setStorage(e.target.value)}
                options={storageOptions}
                hint={t('quickDeploy.storageHint')}
              />
            ) : null}
          </div>

          {isVm && spec ? (
            <div className="mt-12 field-message">
              {t('quickDeploy.linkedCloneNote', { n: spec.disk })}
            </div>
          ) : null}
        </Card>

        {/* ---- 5. 网络 ---- */}
        <Card>
          <CardHeader
            title={t('quickDeploy.sectionNetwork')}
            subtitle={
              isVm
                ? t('quickDeploy.networkSubtitleVm')
                : t('quickDeploy.networkSubtitleLxc')
            }
          />
          <div className="form-grid-2">
            <Select
              label={t('quickDeploy.labelBridge')}
              value={bridge}
              onChange={(e) => setBridge(e.target.value)}
              options={
                bridgeOptions.length
                  ? bridgeOptions
                  : [{ label: bridge || 'vmbr0', value: bridge || 'vmbr0' }]
              }
              hint={bridgesQuery.isError ? errorMessage(bridgesQuery.error) : undefined}
            />
            <Field label={t('quickDeploy.labelIpMode')}>
              <SegmentedControl<IpMode>
                value={ipMode}
                onChange={pickIpMode}
                ariaLabel={t('quickDeploy.labelIpMode')}
                options={[
                  { label: t('quickDeploy.ipModeStatic'), value: 'static' },
                  { label: 'DHCP', value: 'dhcp' },
                ]}
              />
            </Field>
          </div>

          {/* 接入安全管控：**只有虚拟机有这条能力**（与「自定义部署」向导里同一个
              开关）。快速部署走链接克隆，公钥由后端注入 cloud-init，机器起来后自动
              登记为受管主机。容器没有 cloud-init，后端 /api/lxc 也不接受这个字段 ——
              给容器露出这个开关只会让人白勾一下，所以这里按 kind 收掉。
              包在与相邻字段一致的网格里 —— 否则它夹在两段 form-grid-2 之间既没有
              上边距也不参与列对齐，看起来像浮在页面上。 */}
          {isVm ? (
            <div className="form-grid-2 mt-12">
              <Switch
                label={t('vmCreate.ciManage')}
                checked={manage}
                onChange={setManage}
                hint={
                  ipMode === 'static'
                    ? t('vmCreate.ciManageHint')
                    : t('vmCreate.ciManageNeedIp')
                }
              />
            </div>
          ) : null}

          {ipMode === 'static' ? (
            <div className="form-grid-2 mt-12">
              <Select
                label={t('quickDeploy.labelPool')}
                value={poolId}
                onChange={(e) => {
                  setPoolId(e.target.value);
                  setStaticIp('');
                }}
                options={poolOptions}
                hint={
                  poolsQuery.isError
                    ? errorMessage(poolsQuery.error)
                    : t('quickDeploy.poolHint')
                }
              />
              <Input
                label={t('quickDeploy.labelIp')}
                required
                value={staticIp}
                onChange={(e) => setStaticIp(e.target.value)}
                placeholder={t('quickDeploy.ipPlaceholder')}
              />
              <Input
                label={t('quickDeploy.labelGateway')}
                value={gateway}
                onChange={(e) => setGateway(e.target.value)}
                placeholder={t('quickDeploy.gatewayPlaceholder')}
              />
            </div>
          ) : null}
        </Card>

        {/* ---- 6. 登录信息 ---- */}
        <Card>
          <CardHeader
            title={t('quickDeploy.sectionLogin')}
            subtitle={
              isVm
                ? t('quickDeploy.loginSubtitleVm')
                : t('quickDeploy.loginSubtitleLxc')
            }
          />
          <div className="form-grid-2">
            {isVm ? (
              <Input
                label={t('quickDeploy.labelUser')}
                value={ciUser}
                onChange={(e) => setCiUser(e.target.value)}
                placeholder="root"
              />
            ) : null}
            <Input
              label={
                isVm
                  ? t('quickDeploy.labelPassword')
                  : t('quickDeploy.labelRootPassword')
              }
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('quickDeploy.passwordPlaceholder')}
            />
          </div>
        </Card>

        {/* ---- 提交 ---- */}
        <div>
          {/* 用中性提示而不是红色报错：这是「还差什么」的引导，不是用户填错了 */}
          {error ? <div className="field-message">{error}</div> : null}
          <div className="mt-12 flex items-center gap-12 flex-wrap">
            <Button
              variant="primary"
              icon={<IconCloud size={15} />}
              loading={busy}
              disabled={Boolean(error) || !canCreate}
              onClick={() => void submit()}
            >
              {isVm ? t('quickDeploy.createVm') : t('quickDeploy.createLxc')}
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            {quota ? (
              <span className="fs-sm text-muted">
                {quota.limited
                  ? t('quickDeploy.quotaLimited', {
                      label: quota.label,
                      used: quota.used,
                      quota: quota.quota,
                      remaining: quota.remaining,
                    })
                  : t('quickDeploy.quotaUnlimited', { label: quota.label })}
                {summary ? t('quickDeploy.willCreate', { summary }) : ''}
              </span>
            ) : (
              <span className="flex items-center gap-6 fs-sm text-muted">
                <Spinner size={12} /> {t('quickDeploy.loadingQuota')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
