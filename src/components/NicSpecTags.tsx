/* ==========================================================================
   ProxCenter — 网卡参数标签

   虚拟机和容器的 ``netN`` 本质都是「一串 PVE 键值对」：

     virtio=BC:24:11:6F:37:7F,bridge=vmbr1,firewall=1,link_down=1,mtu=14500,rate=3,tag=20

   详情页原先只挑了网桥 / VLAN / MAC 展示，于是 ``link_down``（链路被人为关闭）、
   ``mtu``、``rate``（限速）这些排障时最该看到的参数全被藏进「配置」页的原始
   JSON —— 反倒是 PVE 后台的硬件列表把它们显示全了。

   这里把整行拆成一组标签直接摆在网卡下面，并留一个兜底：后端多返回了没识别的
   键（PVE 升级会加参数）也照 ``key=value`` 列出来，不静默丢掉。
   ========================================================================== */

import { useT } from '../i18n';
import { Tag } from './ui/Badge';

/** 有专用文案的字段，也是调用方 ``fields`` 允许的取值 */
export const NIC_SPEC_FIELDS = [
  'model',
  'bridge',
  'vlan',
  'mac',
  'name',
  'ip',
  'gw',
  'ip6',
  'gw6',
  'firewall',
  'mtu',
  'rate',
  'queues',
  'link_down',
] as const;

export type NicSpecField = (typeof NIC_SPEC_FIELDS)[number];

/* 已经由上面那组字段消费掉的原始键，剩下的才走 ``key=value`` 兜底。
   ``interface`` 是键名本身、``raw`` 是整串原文，都不是参数，跳过。 */
const CONSUMED_KEYS = new Set<string>([
  'model',
  'bridge',
  'vlan_tag',
  'tag',
  'macaddr',
  'hwaddr',
  'name',
  'ip',
  'gw',
  'ip6',
  'gw6',
  'firewall',
  'mtu',
  'rate',
  'queues',
  'link_down',
  'interface',
  'raw',
]);

/** PVE 的布尔开关在配置里写作 1 / 0，过了 JSON 之后也可能变成 bool */
function isOn(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'on';
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

interface SpecItem {
  key: string;
  label: string;
  title?: string;
  tone?: 'warn';
}

export function NicSpecTags({
  spec,
  fields,
  className,
}: {
  /** 后端解析出的网卡字段（QEMU 与 LXC 的键并不完全一致，按需取用） */
  spec: object;
  /** 只展示这些字段（顺序即渲染顺序）；不传 = 全部已知字段 */
  fields?: readonly NicSpecField[];
  className?: string;
}) {
  const t = useT();
  const source = spec as Record<string, unknown>;
  const wanted = fields ?? NIC_SPEC_FIELDS;
  const has = (field: NicSpecField) => wanted.includes(field);

  const items: SpecItem[] = [];

  if (has('model')) {
    const model = text(source.model);
    if (model) items.push({ key: 'model', label: t('nicSpec.model', { model }) });
  }

  if (has('bridge')) {
    const bridge = text(source.bridge);
    items.push(
      bridge
        ? { key: 'bridge', label: t('nicSpec.bridge', { bridge }) }
        : { key: 'bridge', label: t('nicSpec.noBridge') },
    );
  }

  if (has('vlan')) {
    const vlan = text(source.vlan_tag ?? source.tag);
    if (vlan) items.push({ key: 'vlan', label: t('nicSpec.vlan', { vlan }) });
  }

  if (has('mac')) {
    const mac = text(source.macaddr ?? source.hwaddr);
    if (mac) items.push({ key: 'mac', label: t('nicSpec.mac', { mac }) });
  }

  if (has('name')) {
    const name = text(source.name);
    if (name) items.push({ key: 'name', label: t('nicSpec.ifname', { name }) });
  }

  if (has('ip')) {
    const ip = text(source.ip);
    if (ip) {
      items.push({
        key: 'ip',
        label: ip.toLowerCase() === 'dhcp' ? t('nicSpec.ipDhcp') : t('nicSpec.ip', { ip }),
      });
    }
  }

  if (has('gw')) {
    const gw = text(source.gw);
    if (gw) items.push({ key: 'gw', label: t('nicSpec.gw', { gw }) });
  }

  if (has('ip6')) {
    const ip6 = text(source.ip6);
    if (ip6) items.push({ key: 'ip6', label: t('nicSpec.ip6', { ip6 }) });
  }

  if (has('gw6')) {
    const gw6 = text(source.gw6);
    if (gw6) items.push({ key: 'gw6', label: t('nicSpec.gw6', { gw6 }) });
  }

  if (has('firewall') && isOn(source.firewall)) {
    items.push({ key: 'firewall', label: t('nicSpec.firewall') });
  }

  if (has('mtu')) {
    const mtu = text(source.mtu);
    if (mtu) items.push({ key: 'mtu', label: t('nicSpec.mtu', { mtu }) });
  }

  if (has('rate')) {
    const rate = text(source.rate);
    if (rate) items.push({ key: 'rate', label: t('nicSpec.rate', { rate }) });
  }

  if (has('queues')) {
    const queues = text(source.queues);
    if (queues) items.push({ key: 'queues', label: t('nicSpec.queues', { queues }) });
  }

  if (has('link_down') && isOn(source.link_down)) {
    items.push({
      key: 'link_down',
      label: t('nicSpec.linkDown'),
      title: t('nicSpec.linkDownHint'),
      tone: 'warn',
    });
  }

  /* 兜底：后端给了但我们还没写文案的键，原样列出来 */
  for (const key of Object.keys(source)) {
    if (CONSUMED_KEYS.has(key)) continue;
    const value = text(source[key]);
    if (!value) continue;
    items.push({ key, label: `${key}=${value}` });
  }

  if (items.length === 0) return null;

  return (
    <span className={`tag-list${className ? ` ${className}` : ''}`}>
      {items.map((item) => (
        <Tag key={item.key} className={item.tone === 'warn' ? 'tag-warn' : undefined}>
          <span title={item.title}>{item.label}</span>
        </Tag>
      ))}
    </span>
  );
}
