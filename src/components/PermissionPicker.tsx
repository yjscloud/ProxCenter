/* ==========================================================================
   ProxCenter — 权限勾选器
   按域分组展示权限目录，支持整组全选/取消与逐项勾选。
   用户编辑与角色编辑共用同一个组件，避免两套逻辑走偏。
   ========================================================================== */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { rolesApi } from '../api/endpoints';

export function PermissionPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** 关闭时只读（例如用户「跟随角色」模式） */
  disabled?: boolean;
}) {
  const catalogQuery = useQuery({
    queryKey: ['permissions', 'catalog'],
    queryFn: () => rolesApi.catalog(),
    staleTime: 300_000,
    retry: false,
  });

  const groups = catalogQuery.data ?? [];
  const selected = useMemo(() => new Set(value), [value]);

  const toggleOne = (key: string, on: boolean) => {
    if (disabled) return;
    onChange(
      on ? Array.from(new Set([...value, key])) : value.filter((k) => k !== key),
    );
  };

  const toggleGroup = (keys: string[], on: boolean) => {
    if (disabled) return;
    onChange(
      on
        ? Array.from(new Set([...value, ...keys]))
        : value.filter((k) => !keys.includes(k)),
    );
  };

  if (catalogQuery.isLoading) {
    return <div className="fs-sm text-muted">正在加载权限目录…</div>;
  }

  return (
    <div className={`perm-grid ${disabled ? 'is-readonly' : ''}`}>
      {groups.map((group) => {
        const keys = group.permissions.map((p) => p.key);
        const allOn = keys.length > 0 && keys.every((k) => selected.has(k));
        return (
          <div className="perm-group" key={group.key}>
            <div className="perm-group-head">
              <span className="fw-500">{group.label}</span>
              <button
                type="button"
                className="perm-group-toggle"
                disabled={disabled}
                onClick={() => toggleGroup(keys, !allOn)}
              >
                {allOn ? '取消全选' : '全选'}
              </button>
            </div>
            <div className="perm-items">
              {group.permissions.map((p) => (
                <label className="perm-item" key={p.key}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={selected.has(p.key)}
                    onChange={(e) => toggleOne(p.key, e.target.checked)}
                  />
                  <span className="perm-label">{p.label}</span>
                  <span className="perm-key mono" title={p.desc}>
                    {p.key}
                  </span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
