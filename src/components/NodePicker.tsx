/* ==========================================================================
   ProxCenter — 节点下拉选择（创建虚拟机 / 容器时用）
   ==========================================================================

   操作方式跟表单里其它 Select 一致：点一下展开、上下键移动、回车选中、Esc 关闭、
   点外面收起。但下拉项是**富行** —— 除了节点名，还带 CPU 负载、内存使用率、
   磁盘使用率。挑节点真正要看的是「这台还剩多少资源」，原来一行
   「8 核 · 负载 12%」看不出磁盘快满了，往往等创建到一半报「存储不足」才发现。

   为什么不用原生 Select：``<option>`` 里只能放纯文本，塞不进进度条与配色。
   所以自己实现一个 listbox：样式沿用 .input-wrap / .colset-panel 那一套，
   键盘与外部点击的行为和其它下拉保持一致（role="listbox" + aria-selected）。

   离线节点不可选：PVE 本来也不允许在离线节点上创建，与其选了再报错，不如在
   这里就禁掉并说明原因。
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { NodeInfo } from '../api/types';
import { toPercent, usageColor } from '../utils/format';
import { IconCheck, IconChevronDown } from './Icons';
import { Badge } from './ui/Badge';
import { useT } from '../i18n';

/** 三条指标的百分比。口径与节点页一致：cpu 是 0~1 的使用率，内存 / 磁盘按已用 / 总量。 */
function usageOf(node: NodeInfo) {
  return {
    offline: node.status !== 'online',
    cpu: toPercent(node.cpu),
    mem: node.maxmem > 0 ? ((node.mem ?? 0) / node.maxmem) * 100 : 0,
    disk: node.maxdisk > 0 ? ((node.disk ?? 0) / node.maxdisk) * 100 : 0,
  };
}

function pctText(percent: number, offline: boolean) {
  return offline ? '—' : `${percent.toFixed(0)}%`;
}

/** 下拉项里的一条指标：名称 + 百分比（不显示总量之类，只看用了多少） */
function UsageText({
  label,
  percent,
  offline,
}: {
  label: string;
  percent: number;
  offline: boolean;
}) {
  return (
    <span className="node-select-usage">
      {label}
      <b className="mono" style={{ color: offline ? 'var(--text-muted)' : usageColor(percent) }}>
        {pctText(percent, offline)}
      </b>
    </span>
  );
}

export function NodePicker({
  nodes,
  value,
  onChange,
  loading = false,
  disabled = false,
  emptyHint,
}: {
  nodes: NodeInfo[];
  value: string;
  onChange: (node: string) => void;
  loading?: boolean;
  disabled?: boolean;
  emptyHint?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  /* 点外面 / 按 Esc 收起：与其它下拉（列设置、通知铃）同一套行为 */
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = nodes.find((n) => n.node === value) ?? null;
  const selectedUsage = selected ? usageOf(selected) : null;

  const firstUsable = () => {
    const index = nodes.findIndex((n) => n.status === 'online');
    return index >= 0 ? index : 0;
  };

  const openPanel = () => {
    const index = nodes.findIndex((n) => n.node === value);
    setActive(index >= 0 ? index : firstUsable());
    setOpen(true);
  };

  const pick = (node: NodeInfo) => {
    if (node.status !== 'online') return;
    onChange(node.node);
    setOpen(false);
  };

  const onPanelKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, nodes.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const node = nodes[active];
      if (node) pick(node);
    }
  };

  return (
    <div className="node-select" ref={rootRef}>
      <button
        type="button"
        className="node-select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openPanel();
          }
        }}
      >
        {selected && selectedUsage ? (
          <>
            <span className="node-select-name truncate">{selected.node}</span>
            <span className="node-select-inline">
              <span>
                {t('nodePicker.load')}{' '}
                {pctText(selectedUsage.cpu, selectedUsage.offline)}
              </span>
              <span>
                {t('nodePicker.mem')}{' '}
                {pctText(selectedUsage.mem, selectedUsage.offline)}
              </span>
              <span>
                {t('nodePicker.disk')}{' '}
                {pctText(selectedUsage.disk, selectedUsage.offline)}
              </span>
            </span>
          </>
        ) : (
          <span className="node-select-placeholder">
            {loading ? t('nodePicker.loading') : t('nodePicker.placeholder')}
          </span>
        )}
        <span className={`node-select-caret ${open ? 'is-open' : ''}`}>
          <IconChevronDown size={14} />
        </span>
      </button>

      {open ? (
        <div
          className="node-select-panel"
          role="listbox"
          aria-label={t('nodePicker.aria')}
          tabIndex={-1}
          onKeyDown={onPanelKey}
        >
          {nodes.length === 0 ? (
            <div className="node-select-empty">
              {emptyHint ?? t('nodePicker.emptyHint')}
            </div>
          ) : (
            nodes.map((node, index) => {
              const usage = usageOf(node);
              const isSelected = node.node === value;
              return (
                <div
                  key={node.node}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={usage.offline}
                  title={usage.offline ? t('nodePicker.offlineTitle') : undefined}
                  className={
                    'node-select-option' +
                    (isSelected ? ' is-selected' : '') +
                    (usage.offline ? ' is-offline' : '') +
                    (index === active ? ' is-active' : '')
                  }
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(node)}
                >
                  <div className="node-select-option-head">
                    <span className="node-select-option-name truncate">
                      {node.node}
                    </span>
                    <span className="node-select-option-spacer" />
                    {isSelected ? (
                      <IconCheck size={14} className="node-select-check" />
                    ) : null}
                    <Badge
                      variant={usage.offline ? 'neutral' : 'success'}
                      size="sm"
                      dot
                      pulse={!usage.offline}
                    >
                      {usage.offline
                        ? t('nodePicker.offline')
                        : t('nodePicker.online')}
                    </Badge>
                  </div>
                  <div className="node-select-usages">
                    <UsageText label="CPU" percent={usage.cpu} offline={usage.offline} />
                    <UsageText
                      label={t('nodePicker.mem')}
                      percent={usage.mem}
                      offline={usage.offline}
                    />
                    <UsageText
                      label={t('nodePicker.disk')}
                      percent={usage.disk}
                      offline={usage.offline}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
