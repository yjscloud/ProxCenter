/* ==========================================================================
   ProxCenter — 下发额度胶囊 + 明细浮层
   ==========================================================================

   列表页右上角原来并排两颗胶囊：「可下发剩余 6 台」（平台台数上限）和
   「数量 2 台 · CPU 核数 4 核 · 内存 8 GB · 磁盘 200 GB」（按人分配的资源额度）。
   两颗都没主语，一个说还能建 6 台、一个说自己只剩 2 台，并排摆着像自相矛盾 ——
   用户不知道以哪个为准，也不知道那串数字是「剩余」还是「当前的配置」。

   现在合成一颗：正文只说「实际还能建几台」（取两层里更严的那层），点开看明细。
   明细按身份分层，因为两层的**出口不同**：

   * 平台那层是管理员在「设置 → 创建默认值」里配的。普通用户改不了，数字对他没有
     出口，所以只在管理员的浮层里出现；
   * 我名下那层是逐维度的（数量 / 核数 / 内存 / 磁盘），挨行列出来，用户才知道该把
     规格往哪一项调小。

   顺带一个好处：原来胶囊是纯展示，用尽/剩余要各写一套文案；现在数字都在浮层里，
   胶囊正文只需三态（能用几台 / 不限 / 已用尽），措辞自然收敛。
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n';
import type { QuotaGroupReport, VmQuotaInfo } from '../api/types';

export interface QuotaChipProps {
  /** 平台台数上限的读数（``GET /vms/quota`` 或 ``/lxc/quota``）；还没读到就是 undefined */
  quota?: VmQuotaInfo | null;
  /** 我名下（按人分配）的那一层读数；没配额度就是 null */
  mine?: QuotaGroupReport | null;
  /** 计数单位（「台」/「个」） */
  unit: string;
  /** 名词（「虚拟机」/「容器」），浮层标题用 */
  noun: string;
}

/** 读数可能是 null（不限）或干脆没有，统一收成 number | null */
function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 取两层里更严的那个；null = 至少有一层不限，另一层也没限 */
function tighter(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** 浮层里的一行（只列被限制的维度） */
interface QuotaRow {
  field: string;
  label: string;
  /** 还能用多少（已带单位） */
  left: string;
  /** 「已用 x / 上限 y」，没配上限就是空串 */
  detail: string;
  /** 这一项自己见底了没有（逐项，不是跟着胶囊的总体状态走） */
  empty: boolean;
  /** 已经**超出**了多少（正数）。额度被下调之后已建的机器会落到这里 */
  over: number;
}

/** 逐维度列表的字段顺序、词条与单位。内存后端按 MB 存，界面一律换算成 GB。 */
const DIMENSIONS: Array<{
  field: string;
  labelKey:
    | 'quota.fieldLabel.count'
    | 'quota.fieldLabel.cores'
    | 'quota.fieldLabel.memory'
    | 'quota.fieldLabel.disk';
  /** 值后面跟什么单位：计数单位 / 核 / GB */
  unitKey: 'count' | 'cores' | 'gb';
  scale: number;
}> = [
  { field: 'count', labelKey: 'quota.fieldLabel.count', unitKey: 'count', scale: 1 },
  { field: 'cores', labelKey: 'quota.fieldLabel.cores', unitKey: 'cores', scale: 1 },
  { field: 'memory_mb', labelKey: 'quota.fieldLabel.memory', unitKey: 'gb', scale: 1024 },
  { field: 'disk_gb', labelKey: 'quota.fieldLabel.disk', unitKey: 'gb', scale: 1 },
];

export function QuotaChip({ quota, mine, unit, noun }: QuotaChipProps) {
  const t = useT();
  const { isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  /* 点外面 / 滚动 / 改窗口大小都收起：浮层贴着胶囊绝对定位，滚动后位置会歪
     （与详情页的「更多操作」菜单同一套处理） */
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const rows = useMemo<QuotaRow[]>(() => {
    const limits: Record<string, number | null> = mine?.limits ?? {};
    const remaining: Record<string, number | null> = mine?.remaining ?? {};
    /* usage 是具名字段（count / cores / memory_mb / disk_gb），按上面那张表的
       字段名取时要先收成同一种索引形状 */
    const usage = mine?.usage;
    const usedOf = (field: string): number =>
      usage ? (asNumber(usage[field as keyof typeof usage]) ?? 0) : 0;
    const unitOf = (key: 'count' | 'cores' | 'gb') =>
      key === 'count' ? unit : key === 'cores' ? t('quota.unitCore') : 'GB';

    const out: QuotaRow[] = [];
    for (const dim of DIMENSIONS) {
      const total = asNumber(limits[dim.field]);
      const left = asNumber(remaining[dim.field]);
      if (total === null && left === null) continue;
      const scale = dim.scale;
      const dimUnit = unitOf(dim.unitKey);
      out.push({
        field: dim.field,
        label: t(dim.labelKey),
        left:
          left === null
            ? t('quota.unlimitedShort')
            : left < 0
              ? /* 负数剩余是在说「已经超了」。写成「还剩 -3 台」要人多读一遍才算
                   得过来，直接说「已超额」是同一件事的白话 */
                t('quota.overTotal', {
                  n: Math.round(-left / scale),
                  unit: dimUnit,
                })
              : t('quota.leftOfTotal', {
                  n: Math.round(left / scale),
                  unit: dimUnit,
                }),
        detail:
          total === null
            ? ''
            : t('quota.usedOfTotal', {
                used: Math.round(usedOf(dim.field) / scale),
                total: Math.round(total / scale),
                unit: dimUnit,
              }),
        /* 只有这一项见底才点红。磁盘还剩 100 GB 的时候把它一起标红是在说谎 ——
           胶囊的「已用尽」是「**有一项**见底」，那是另一回事 */
        empty: left !== null && left <= 0,
        over: left !== null && left < 0 ? Math.round(-left / scale) : 0,
      });
    }
    return out;
  }, [mine, t, unit]);

  const platformRemaining = quota?.limited ? (asNumber(quota.remaining) ?? 0) : null;
  const remaining = tighter(platformRemaining, asNumber(mine?.remaining?.count));

  /* 只要有一项（含平台台数）见底就是「用尽」—— 用户关心的是还能不能建，而不是
     哪一项先见底；具体哪一项在浮层里逐行写着 */
  const exhausted =
    Boolean(quota && !quota.can_create) ||
    DIMENSIONS.some((dim) => {
      const left = asNumber(mine?.remaining?.[dim.field]);
      return left !== null && left <= 0;
    });

  /* 两份读数都还没到手（或都取不到）时整只不渲染：「不限」和「不知道」不是一回事，
     宁可少一个控件，也不要把「没读到」说成「随便建」 */
  if (!quota && !mine) return null;

  const label = exhausted
    ? t('quota.usedUp')
    : remaining === null
      ? t('guestList.quotaUnlimited')
      : t('guestList.quotaRemaining', { remaining, unit });

  return (
    <span className="quota-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`quota-chip${exhausted ? ' is-empty' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('quota.detailsHint')}
      >
        {label}
      </button>

      {open ? (
        <div
          className={`quota-popover${exhausted ? ' is-empty' : ''}`}
          role="dialog"
          aria-label={t('quota.detailsTitle', { noun })}
        >
          <div className="quota-popover-head">{t('quota.detailsTitle', { noun })}</div>

          <div className="quota-popover-main">
            <span>{t('quota.canCreate')}</span>
            <strong>
              {remaining === null
                ? t('quota.unlimitedShort')
                : t('quota.leftOfTotal', { n: Math.max(0, remaining), unit })}
            </strong>
          </div>

          {isAdmin ? (
            <div className="quota-popover-block">
              <div className="quota-popover-block-title">{t('quota.platformLabel')}</div>
              <div className="quota-popover-line">
                <span className="quota-popover-label">
                  {t('quota.fieldLabel.count')}
                </span>
                {/* 平台这层只有这一个值，它就是这一行的重点 —— 用「还剩」那格
                    的样式（右对齐 + 加重），而不是当注解用灰色 */}
                <span className="quota-popover-left">
                  {quota?.limited
                    ? t('quota.usedOfTotal', {
                        used: quota.used,
                        total: quota.quota ?? 0,
                        unit,
                      })
                    : t('quota.noLimit')}
                </span>
              </div>
            </div>
          ) : null}

          {rows.length ? (
            <div className="quota-popover-block">
              <div className="quota-popover-block-title">{t('quota.mineLabel')}</div>
              {/* 三段各自成格：标签 | 还剩 x | 已用 y / 上限 z。
                  原先三段挤在同一个行内流里，标签会被长数值压到换行
                  （「磁盘」断成「磁 / 盘」），数值接着断成三行 ——
                  拆成三格才各归各位（见 .quota-popover-line 的注释）。 */}
              {rows.map((row) => (
                <div
                  className={`quota-popover-line${row.empty ? ' is-empty' : ''}`}
                  key={row.field}
                >
                  <span className="quota-popover-label">{row.label}</span>
                  <span className="quota-popover-left">{row.left}</span>
                  <span className="quota-popover-detail">{row.detail}</span>
                </div>
              ))}
            </div>
          ) : null}

          {/* 出口：管理员去设置里改，普通用户找管理员。这是两层额度唯一需要「行动」
              的地方，所以放在最后一行 —— 也是原先两条文案里最容易被抄错的一句 */}
          {/* 口径写在这里，别让人猜：额度数的是**配置容量**（配了多大），不是
              实际占用；模板也计入（它同样占一个 VMID 与一份存储）。这两点最容易
              被理解成「我明明没开机怎么也在扣」。 */}
          <div className="quota-popover-note">{t('quota.usageBasis')}</div>

          <div className="quota-popover-foot">
            {isAdmin ? t('quota.adminWhere') : exhausted ? t('quota.askAdmin') : t('quota.byAdmin')}
          </div>
        </div>
      ) : null}
    </span>
  );
}
