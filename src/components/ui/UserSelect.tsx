/* ==========================================================================
   ProxCenter — UserSelect（可搜索的用户选择器）

   为什么不用原生 <select>：指派归属就是在一长串账号里挑人 —— 原生下拉只能按键
   逐项跳，账号一多根本没法用；而手打用户名同样不行：归属在库里就是一串用户名
   字符串，打错一个字母等于「指派给了一个不存在的人」，接口照收，界面上却谁也
   看不到这台机器。

   所以这里是一个自带的 combobox：输入即过滤（用户名 / 角色 / 邮箱都能搜）、
   上下键选择、回车确认、点外面收起。

   列表**内联展开**而不是绝对定位的浮层：这个控件基本都出现在 Modal 里，而
   .modal-body 是 overflow-y:auto —— 浮层会被裁掉一半。内联展开顶多把弹窗
   撑高，交给 Modal 自己滚动，稳得多。
   ========================================================================== */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usersApi } from '../../api/endpoints';
import { useT } from '../../i18n';
import { Field } from './Input';

export interface UserSelectProps {
  /** 当前归属用户名，空串 = 没有归属 */
  value: string;
  onChange: (username: string) => void;
  /** 允许「不指派」：列表首项用于清空归属（默认允许） */
  allowEmpty?: boolean;
  label?: ReactNode;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}

interface Option {
  value: string;
  label: string;
  hint: string;
}

export function UserSelect({
  value,
  onChange,
  allowEmpty = true,
  label,
  hint,
  placeholder,
  disabled = false,
  id,
}: UserSelectProps) {
  const t = useT();
  const autoId = useId();
  const inputId = id ?? autoId;
  const listId = `${inputId}-list`;

  const [open, setOpen] = useState(false);
  /** null = 不在搜索，输入框显示已选的用户名；字符串 = 用户正在敲的搜索词 */
  const [keyword, setKeyword] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* 与 GuestList 用同一个缓存键：两处选人共用一份用户列表，不重复请求 */
  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list(),
    staleTime: 60_000,
    retry: false,
  });

  /* 候选账号：待审批 / 已停用的还登不进来，指派给他没有意义。
     但**当前归属那一行无论状态如何都要留下** —— 否则打开弹窗看到的是空的，
     用户会以为自己没设过归属，顺手一存就把归属抹掉了。 */
  const users = useMemo(() => {
    const all = usersQuery.data ?? [];
    const usable = all.filter(
      (u) => u.enabled !== false && (u.status ?? 'active') === 'active',
    );
    if (value && !usable.some((u) => u.username === value)) {
      const current = all.find((u) => u.username === value);
      if (current) usable.unshift(current);
    }
    return usable;
  }, [usersQuery.data, value]);

  const options = useMemo<Option[]>(() => {
    const kw = (keyword ?? '').trim().toLowerCase();
    const matched = kw
      ? users.filter((u) =>
          `${u.username} ${u.role ?? ''} ${u.email ?? ''}`
            .toLowerCase()
            .includes(kw),
        )
      : users;
    const items: Option[] = matched.map((u) => ({
      value: u.username,
      label: u.role ? `${u.username}（${u.role}）` : u.username,
      hint: u.email ?? '',
    }));
    return allowEmpty
      ? [{ value: '', label: t('userSelect.none'), hint: '' }, ...items]
      : items;
  }, [users, keyword, allowEmpty, t]);

  /* 收起时显示已选值，展开且开始输入后显示搜索词 */
  const text = keyword ?? value;

  const close = () => {
    setOpen(false);
    setKeyword(null);
  };

  /** 展开并把高亮定位到当前归属上（找不到就从头开始） */
  const openMenu = () => {
    setOpen(true);
    setKeyword(null);
    const index = options.findIndex((item) => item.value === value);
    setActive(index >= 0 ? index : 0);
  };

  const choose = (username: string) => {
    onChange(username);
    close();
    inputRef.current?.blur();
  };

  /* 点到组件外面就收起 */
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setKeyword(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      if (!options.length) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((prev) => (prev + delta + options.length) % options.length);
      return;
    }
    if (event.key === 'Enter') {
      if (!open) return;
      event.preventDefault();
      const item = options[active];
      if (item) choose(item.value);
      return;
    }
    if (event.key === 'Tab') close();
  };

  return (
    <Field label={label} hint={hint} htmlFor={inputId}>
      <div className={`user-select ${open ? 'is-open' : ''}`} ref={rootRef}>
        <div className="input-wrap">
          <input
            ref={inputRef}
            id={inputId}
            className="input"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && options[active] ? `${listId}-${active}` : undefined
            }
            autoComplete="off"
            disabled={disabled}
            value={disabled ? value : text}
            placeholder={placeholder ?? t('userSelect.placeholder')}
            onFocus={() => {
              openMenu();
              /* 聚焦即全选：接着敲字就是替换，不必先删掉旧值 */
              window.setTimeout(() => inputRef.current?.select(), 0);
            }}
            onChange={(event) => {
              const next = event.target.value;
              setKeyword(next);
              setOpen(true);
              /* 敲了搜索词就把高亮放在第一个**真实用户**上：输入名字后直接
                 回车是很自然的动作，而它会选中列表第一项 —— 那是「（不指派）」，
                 于是「指派」变成了「收回归属」，正是最不该搞反的一步。 */
              setActive(next.trim() && allowEmpty ? 1 : 0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>

        {open && !disabled ? (
          <div className="user-select-menu" role="listbox" id={listId} aria-label={t('userSelect.listAria')}>
            {options.length === 0 ? (
              <div className="user-select-empty">
                {usersQuery.isLoading ? t('common.loading') : t('userSelect.noMatch')}
              </div>
            ) : (
              options.map((item, index) => (
                <div
                  key={item.value || '__none__'}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={item.value === value}
                  className={`user-select-option ${
                    index === active ? 'is-active' : ''
                  } ${item.value === value ? 'is-selected' : ''}`}
                  /* mousedown 而不是 click：click 之前输入框会先失焦，
                     Modal 里的焦点跳动会让列表闪一下 */
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(item.value);
                  }}
                  onMouseEnter={() => setActive(index)}
                >
                  <span className="user-select-name">{item.label}</span>
                  {item.hint ? (
                    <span className="user-select-hint">{item.hint}</span>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </Field>
  );
}
