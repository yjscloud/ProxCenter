/* ==========================================================================
   ProxCenter — 资源额度编辑器（用户级 / 角色默认共用）

   两层语义，界面必须表达清楚，否则管理员配完了不知道到底生效哪一份：

   * **继承**（``value === null``）：这一层不生效，往下看角色默认；角色也没配
     就是不限制。注意这与「自定义但每一项都留空」**不是**一回事 —— 后者是
     「显式不限制」，会盖掉角色默认的上限（后端 app/quota.py 的三层说明）。
   * **自定义**：整份生效，留空的项表示「这一项不限制」，填 0 表示「明确禁止」。

   单位：内存对外用 GB（后端存 MB），换算只在这一处做。
   ========================================================================== */

import { useMemo } from 'react';
import { Field, Input, SegmentedControl } from './ui/Input';
import { Notice } from './ui/EmptyState';
import { useT, type MessageKey } from '../i18n';
import type {
  GuestQuotaLimits,
  QuotaLimits,
  QuotaUsage,
  SnapshotQuotaLimits,
} from '../api/types';

/** 一份「全都不限制」的额度（自定义模式的起点） */
export function emptyQuotaLimits(): QuotaLimits {
  const guest = (): GuestQuotaLimits => ({
    count: null,
    cores: null,
    memory_mb: null,
    disk_gb: null,
    max_cores: null,
    max_memory_mb: null,
    max_disk_gb: null,
  });
  return { vm: guest(), ct: guest(), snapshot: { count: null, per_guest: null } };
}

type GuestGroup = 'vm' | 'ct';

/**
 * 字段 → 词条键。写成显式映射而不是拼字符串：``t()`` 的入参是字面量联合类型，
 * 拼出来的 ``quota.field.xxx`` 过不了类型检查（也就不会有「拼错了静默回退中文」）。
 */
const FIELD_KEYS: Record<string, MessageKey> = {
  count: 'quota.field.count',
  cores: 'quota.field.cores',
  memory_mb: 'quota.field.memory_mb',
  disk_gb: 'quota.field.disk_gb',
  max_cores: 'quota.field.max_cores',
  max_memory_mb: 'quota.field.max_memory_mb',
  max_disk_gb: 'quota.field.max_disk_gb',
  per_guest: 'quota.field.per_guest',
};

/**
 * 从一份额度里按字段名取一个值。
 *
 * 分组之间字段不同（快照那组只有 count / per_guest），而这里要「按字段名扁平地
 * 遍历一遍」来生成摘要 —— 交给这一个函数做，别在每个调用点各写一次断言。
 */
function limitValue(limits: object, field: string): number | null {
  const raw = (limits as Record<string, number | null | undefined>)[field];
  return raw ?? null;
}

/** 空的输入框 = 不限制；非法输入也按不限制处理（后端同样容忍坏值） */
function toNumber(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

/** 内存对外用 GB：后端是 MB，输入框里换算一次，别让每个调用点各算一遍 */
function toGb(mb: number | null): string {
  return mb === null || mb === undefined ? '' : String(mb / 1024);
}

function fromGb(raw: string): number | null {
  const gb = toNumber(raw);
  return gb === null ? null : Math.round((gb * 1024) / 1) || 0;
}

/** 数字输入格：留空 = 不限制；下面顺带显示这一项的当前用量 */
function NumberCell({
  label,
  value,
  used,
  unit,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  used?: number | null;
  unit?: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <Field
      label={label}
      hint={
        used === undefined || used === null
          ? undefined
          : t('quota.usedHint', { used, unit: unit ?? '' })
      }
    >
      <Input
        type="number"
        min={0}
        inputMode="numeric"
        value={value}
        placeholder={t('quota.unlimitedPlaceholder')}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function GuestLimitsFields({
  group,
  limits,
  usage,
  onChange,
  disabled,
}: {
  group: GuestGroup;
  limits: GuestQuotaLimits;
  usage?: QuotaUsage | null;
  onChange: (next: GuestQuotaLimits) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const set = (patch: Partial<GuestQuotaLimits>) => onChange({ ...limits, ...patch });

  return (
    <>
      <div className="field-row">
        <NumberCell
          label={t('quota.count')}
          value={limits.count === null ? '' : String(limits.count)}
          used={usage?.count}
          unit={t('quota.unitGuest')}
          disabled={disabled}
          onChange={(v) => set({ count: toNumber(v) })}
        />
        <NumberCell
          label={t('quota.cores')}
          value={limits.cores === null ? '' : String(limits.cores)}
          used={usage?.cores}
          unit={t('quota.unitCore')}
          disabled={disabled}
          onChange={(v) => set({ cores: toNumber(v) })}
        />
      </div>
      <div className="field-row">
        <NumberCell
          label={t('quota.memory')}
          value={toGb(limits.memory_mb)}
          used={usage ? Math.round(usage.memory_mb / 1024) : undefined}
          unit={t('quota.unitGb')}
          disabled={disabled}
          onChange={(v) => set({ memory_mb: fromGb(v) })}
        />
        <NumberCell
          label={t('quota.disk')}
          value={limits.disk_gb === null ? '' : String(limits.disk_gb)}
          used={usage?.disk_gb}
          unit={t('quota.unitGb')}
          disabled={disabled}
          onChange={(v) => set({ disk_gb: toNumber(v) })}
        />
      </div>
      {/* 单台封顶：只给总量不封单台，用户建一台超大机器就能把池子占满 */}
      <div className="field-row">
        <NumberCell
          label={t('quota.maxCores')}
          value={limits.max_cores === null ? '' : String(limits.max_cores)}
          unit={t('quota.unitCore')}
          disabled={disabled}
          onChange={(v) => set({ max_cores: toNumber(v) })}
        />
        <NumberCell
          label={t('quota.maxMemory')}
          value={toGb(limits.max_memory_mb)}
          unit={t('quota.unitGb')}
          disabled={disabled}
          onChange={(v) => set({ max_memory_mb: fromGb(v) })}
        />
        <NumberCell
          label={t('quota.maxDisk')}
          value={limits.max_disk_gb === null ? '' : String(limits.max_disk_gb)}
          unit={t('quota.unitGb')}
          disabled={disabled}
          onChange={(v) => set({ max_disk_gb: toNumber(v) })}
        />
      </div>
      <span className="fs-xs text-muted">
        {t(group === 'vm' ? 'quota.vmHint' : 'quota.ctHint')}
      </span>
    </>
  );
}

export interface QuotaEditorProps {
  /** 这一层的配置；``null`` = 继承上一层 */
  value: QuotaLimits | null;
  onChange: (next: QuotaLimits | null) => void;
  /** 上一层（角色默认）的配置，用于说明「继承到手的是什么」 */
  inherited?: QuotaLimits | null;
  /** 该用户名下的实时用量（用户编辑器才有） */
  usage?: {
    vm?: QuotaUsage | null;
    ct?: QuotaUsage | null;
    /** 快照用量只统计「总数」（后端只在配了额度时才会去逐台枚举） */
    snapshot?: { count: number } | null;
  } | null;
  disabled?: boolean;
}

export function QuotaEditor({
  value,
  onChange,
  inherited,
  usage,
  disabled,
}: QuotaEditorProps) {
  const t = useT();
  const custom = value !== null;

  /* 「继承」时把继承到的那份摘成一句人话：到底有哪些维度被限住了 */
  const inheritedText = useMemo(() => {
    if (!inherited) return t('quota.inheritNone');
    const parts: string[] = [];
    for (const [group, labelKey] of [
      ['vm', 'quota.groupVm'],
      ['ct', 'quota.groupCt'],
      ['snapshot', 'quota.groupSnapshot'],
    ] as const) {
      const limited = Object.keys(FIELD_KEYS)
        .map((field) => [field, limitValue(inherited[group], field)] as const)
        .filter(([, value]) => value !== null);
      if (limited.length) {
        parts.push(
          `${t(labelKey)}：${limited
            .map(([field, value]) => `${t(FIELD_KEYS[field])} ${value}`)
            .join('、')}`,
        );
      }
    }
    return parts.length ? parts.join('；') : t('quota.inheritAllUnlimited');
  }, [inherited, t]);

  return (
    <div className="dyn-list">
      <SegmentedControl<'inherit' | 'custom'>
        value={custom ? 'custom' : 'inherit'}
        onChange={(next) => onChange(next === 'custom' ? emptyQuotaLimits() : null)}
        options={[
          { label: t('quota.modeInherit'), value: 'inherit' },
          { label: t('quota.modeCustom'), value: 'custom' },
        ]}
        ariaLabel={t('quota.modeAria')}
      />

      {custom ? (
        <>
          <Notice tone="info">{t('quota.customNote')}</Notice>

          <h4 className="fs-sm fw-600 mt-8">{t('quota.groupVm')}</h4>
          <GuestLimitsFields
            group="vm"
            limits={value.vm}
            usage={usage?.vm}
            disabled={disabled}
            onChange={(next) => onChange({ ...value, vm: next })}
          />

          <h4 className="fs-sm fw-600 mt-8">{t('quota.groupCt')}</h4>
          <GuestLimitsFields
            group="ct"
            limits={value.ct}
            usage={usage?.ct}
            disabled={disabled}
            onChange={(next) => onChange({ ...value, ct: next })}
          />

          <h4 className="fs-sm fw-600 mt-8">{t('quota.groupSnapshot')}</h4>
          <div className="field-row">
            <NumberCell
              label={t('quota.snapshotTotal')}
              value={value.snapshot.count === null ? '' : String(value.snapshot.count)}
              used={usage?.snapshot?.count}
              unit={t('quota.unitItem')}
              disabled={disabled}
              onChange={(v) =>
                onChange({
                  ...value,
                  snapshot: { ...value.snapshot, count: toNumber(v) } as SnapshotQuotaLimits,
                })
              }
            />
            <NumberCell
              label={t('quota.snapshotPerGuest')}
              value={
                value.snapshot.per_guest === null ? '' : String(value.snapshot.per_guest)
              }
              unit={t('quota.unitItem')}
              disabled={disabled}
              onChange={(v) =>
                onChange({
                  ...value,
                  snapshot: {
                    ...value.snapshot,
                    per_guest: toNumber(v),
                  } as SnapshotQuotaLimits,
                })
              }
            />
          </div>
          {/* 说清这两项各自怎么判：单机上限按「这台机器现有几张」，总数按「名下合计」 */}
          <span className="fs-xs text-muted">{t('quota.snapshotHint')}</span>
        </>
      ) : (
        <Notice tone="info">
          {t('quota.inheritFrom')}
          {inheritedText}
        </Notice>
      )}
    </div>
  );
}
