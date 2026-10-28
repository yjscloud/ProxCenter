/* ==========================================================================
   ProxCenter — 权限勾选器
   按域分组展示权限目录，支持整组全选/取消与逐项勾选。
   用户编辑与角色编辑共用同一个组件，避免两套逻辑走偏。
   ========================================================================== */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { rolesApi } from '../api/endpoints';
import type { PermissionEntry } from '../api/types';
import { useT } from '../i18n';

export function PermissionPicker({
  value,
  onChange,
  disabled = false,
  roleId,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** 关闭时只读（例如用户「跟随角色」模式） */
  disabled?: boolean;
  /**
   * 正在编辑的角色 id（新建角色、或不知道该给谁勾时留空）。
   *
   * 目录里有些权限点了 `roles`（如 `vm.assign`：归属改派是管理动作，只在
   * 管理员 / 区域管理员视角下成立）。对不适用的角色**置灰并说明原因**，
   * 而不是让人勾上之后发现没反应 —— 后者是这个页面最常被问的问题。
   * 留空按「不适用」处理：新建的自定义角色一定不是内置管理员角色。
   */
  roleId?: string;
}) {
  const t = useT();
  const catalogQuery = useQuery({
    queryKey: ['permissions', 'catalog'],
    queryFn: () => rolesApi.catalog(),
    staleTime: 300_000,
    retry: false,
  });

  const groups = catalogQuery.data ?? [];
  const selected = useMemo(() => new Set(value), [value]);

  /** 该权限对当前角色是否「不适用」（目录没写 roles 就一律适用） */
  const restrictedFor = (item: PermissionEntry): boolean =>
    Boolean(item.roles?.length) && !item.roles?.includes(roleId ?? '');

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
    return <div className="fs-sm text-muted">{t('permPicker.loading')}</div>;
  }

  return (
    <div className={`perm-grid ${disabled ? 'is-readonly' : ''}`}>
      {groups.map((group) => {
        // 全选只覆盖「对当前角色适用」的项：否则一键全选就把置灰项也塞进去，
        // 保存时被后端拒掉，看起来像是全选坏了。
        const keys = group.permissions
          .filter((p) => !restrictedFor(p))
          .map((p) => p.key);
        const allOn =
          keys.length > 0 && keys.every((k) => selected.has(k));
        return (
          <div className="perm-group" key={group.key}>
            <div className="perm-group-head">
              <span className="fw-500">{group.label}</span>
              <button
                type="button"
                className="perm-group-toggle"
                disabled={disabled || keys.length === 0}
                onClick={() => toggleGroup(keys, !allOn)}
              >
                {allOn ? t('permPicker.clearAll') : t('permPicker.selectAll')}
              </button>
            </div>
            <div className="perm-items">
              {group.permissions.map((p) => {
                const blocked = restrictedFor(p);
                const checked = selected.has(p.key);
                // 已勾上的历史数据要能取消，所以文案分开写：勾着的时候明确说
                // 「保存前取消」，否则管理员只会看到灰框、以为改不了
                const hint = blocked
                  ? t(
                      checked
                        ? 'permPicker.roleRestrictedChosen'
                        : 'permPicker.roleRestricted',
                    )
                  : '';
                return (
                  <label
                    className={`perm-item ${blocked ? 'is-restricted' : ''}`}
                    key={p.key}
                    title={[p.desc, hint].filter(Boolean).join('\n')}
                  >
                    <input
                      type="checkbox"
                      /* 不适用的项勾不上；但历史数据里已经勾上的仍允许取消 ——
                         否则「置灰 + 已勾选」会变成一个谁也解不开的死结。 */
                      disabled={disabled || (blocked && !checked)}
                      checked={checked}
                      onChange={(e) => toggleOne(p.key, e.target.checked)}
                    />
                    <span className="perm-label">{p.label}</span>
                    <span className="perm-key mono">{p.key}</span>
                    {/* 说明占满下一行：塞在标签与键之间时，两段文字会互相压
                        （卡片只有 260px 宽，长句直接把 key 挤出去） */}
                    {blocked ? (
                      <span className="perm-note">{hint}</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
