/* ==========================================================================
   ProxCenter — 重置客户机内用户口令（虚拟机与容器共用）
   ==========================================================================

   入口在列表页的行操作菜单里。打开时先问后端「这台机器现在能怎么改口令」：

   * 虚拟机 —— Guest Agent（即时生效、不重启）或 cloud-init（要重启）；
   * 容器   —— 只能借「SSH → 受管主机」的凭据在宿主机上执行
               `pct exec <vmid> -- chpasswd`（PVE 的 API 里没有在容器里执行
               命令的端点，详见 backend/app/guestpasswd.py 的说明）。

   探测结果决定这个弹窗长什么样：能走两条就出现方式单选（不可选的那条灰掉并
   写明缺什么），只能走一条就只显示说明，一条都走不了则直接给出缺什么、不提交。

   口令强度沿用面板自己那一套规则（后端 security.password_policy_error 是权威，
   这里只是让用户在按提交之前就看到问题）：至少 8 位，且同时含字母与数字。
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { guestsApi } from '../api/guests';
import { errorMessage } from '../api/client';
import { Modal } from './ui/Modal';
import { Button, IconButton } from './ui/Button';
import { Input, RadioGroup } from './ui/Input';
import { Notice } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import { IconEye, IconEyeOff, IconKey } from './Icons';
import { useToast } from '../hooks/useToast';
import type { GuestPasswordMethodId, VmSummary } from '../api/types';

/** 面板账号与客户机账号共用一份口令强度口径（后端 security.password_policy_error） */
function passwordProblem(password: string): string {
  if (password.length < 8) return '口令至少 8 位';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return '口令需同时包含字母与数字';
  }
  return '';
}

export function ResetGuestPasswordDialog({
  guest,
  noun,
  onClose,
  onDone,
}: {
  /** 目标客户机；为 null 时弹窗关闭 */
  guest: VmSummary | null;
  /** 「虚拟机」/「容器」，用于文案 */
  noun: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [method, setMethod] = useState<GuestPasswordMethodId | ''>('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /* 用户动过的字段不再被探测结果覆盖：他可能就是想用 ubuntu 而不是默认的 root */
  const usernameTouched = useRef(false);
  const methodTouched = useRef(false);

  const probe = useQuery({
    queryKey: [
      'guest-password-methods',
      guest?.type ?? 'qemu',
      guest?.node ?? '',
      guest?.vmid ?? 0,
    ],
    queryFn: () => guestsApi.passwordMethods(guest as VmSummary),
    enabled: Boolean(guest),
    staleTime: 10_000,
    retry: false,
  });

  /* 换一台机器就整个重置，别把上一台的输入带过来 */
  useEffect(() => {
    if (!guest) return;
    setUsername('');
    setPassword('');
    setConfirm('');
    setMethod('');
    setShow(false);
    setError('');
    setBusy(false);
    usernameTouched.current = false;
    methodTouched.current = false;
  }, [guest]);

  /* 探测回来后填默认值：默认用户名、默认方式（后端推荐的那条） */
  useEffect(() => {
    const data = probe.data;
    if (!data) return;
    if (!usernameTouched.current) setUsername(data.username || 'root');
    if (!methodTouched.current) {
      const fallback = data.methods.find((m) => m.available)?.id ?? '';
      setMethod((data.recommended as GuestPasswordMethodId) || fallback);
    }
  }, [probe.data]);

  const data = probe.data;
  const available = (data?.methods ?? []).filter((m) => m.available);
  const chosen = (data?.methods ?? []).find((m) => m.id === method);
  /* 边输边提示强度：等按了提交才说不合格，用户白输一遍 */
  const policyProblem = password ? passwordProblem(password) : '';
  const fieldError = error || policyProblem;

  const submit = async () => {
    if (!guest) return;
    if (!username.trim()) {
      setError('请填写客户机内的用户名');
      return;
    }
    const weak = passwordProblem(password);
    if (weak) {
      setError(weak);
      return;
    }
    if (password !== confirm) {
      setError('两次输入的口令不一致');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const res = await guestsApi.resetPassword(guest, {
        username: username.trim(),
        password,
        method,
      });
      toast.success(
        `已重置「${res.username}」的口令`,
        res.detail || `${guest.name || guest.vmid} 已更新`,
      );
      onDone();
    } catch (err) {
      /* 二次确认（step-up）由 axios 拦截器弹框并自动重放，这里只报真正的失败 */
      toast.error('重置口令失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    Boolean(available.length) &&
    Boolean(username.trim()) &&
    Boolean(password) &&
    Boolean(confirm) &&
    !policyProblem &&
    !busy;

  return (
    <Modal
      open={Boolean(guest)}
      onClose={onClose}
      title={`重置${noun}内的用户口令 — ${guest?.name || guest?.vmid || ''}`}
      description={`直接设置这台${noun}里某个账号的登录口令，改完即可用新口令登录`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={<IconKey size={15} />}
            onClick={() => void submit()}
            loading={busy}
            disabled={!canSubmit}
          >
            重置口令
          </Button>
        </>
      }
    >
      {probe.isLoading ? (
        <div className="flex items-center gap-8">
          <Spinner size={16} />
          <span className="fs-sm text-muted">正在检查这台机器的可用方式…</span>
        </div>
      ) : null}

      {probe.isError ? (
        <Notice tone="danger" title="读不到可用的重置方式">
          {errorMessage(probe.error)}
        </Notice>
      ) : null}

      {data && !available.length ? (
        <Notice tone="warning" title="这台机器现在改不了口令">
          <ul className="m-0 pl-16">
            {data.methods.map((m) => (
              <li key={m.id}>
                <strong>{m.label}</strong>：{m.reason || '不可用'}
              </li>
            ))}
          </ul>
          {data.kind === 'lxc' ? (
            <>
              容器没有 Guest Agent，PVE 的 API 也不提供「在容器里执行命令」，所以只有
              宿主机 SSH 这一条路：去「SSH → 受管主机」把该宿主机加进去（需要
              root 或能免密 sudo 的账号），或者进容器控制台自己执行 passwd。
            </>
          ) : (
            <>给客户机装上 qemu-guest-agent 后即可在这里改口令；也可以进控制台手动改。</>
          )}
        </Notice>
      ) : null}

      {data && available.length ? (
        <>
          <div className="dyn-list">
            <Input
              label="客户机内的用户名"
              required
              value={username}
              onChange={(e) => {
                usernameTouched.current = true;
                setUsername(e.target.value);
              }}
              placeholder="root"
              hint="容器一般是 root；虚拟机按你机器里实际的账号填"
            />
            <Input
              label="新口令"
              required
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="至少 8 位，含字母与数字"
              error={fieldError || undefined}
              hint={fieldError ? undefined : '与面板账号同一套强度要求'}
              suffix={
                <IconButton
                  label={show ? '隐藏口令' : '显示口令'}
                  onClick={() => setShow((v) => !v)}
                >
                  {show ? <IconEyeOff size={15} /> : <IconEye size={15} />}
                </IconButton>
              }
            />
            <Input
              label="确认新口令"
              required
              type={show ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />

            {/* 只有一条路时摆单选组是纯噪音，把说明写在下面就够了 */}
            {data.methods.length > 1 ? (
              <RadioGroup
                name="guest-password-method"
                label="重置方式"
                vertical
                value={method}
                onChange={(v) => {
                  methodTouched.current = true;
                  setMethod(v as GuestPasswordMethodId);
                }}
                options={data.methods.map((m) => ({
                  value: m.id,
                  label: m.label,
                  // 不可选的那条也要把原因带上：用户看到「灰的」必须知道缺什么
                  hint: m.available ? m.description : '不可用：' + (m.reason || '当前不可用'),
                  disabled: !m.available,
                }))}
              />
            ) : (
              <div className="field-message">
                {available[0]?.label}：{available[0]?.description}
              </div>
            )}
          </div>

          {chosen?.restarts ? (
            <Notice tone="warning" title="这条方式会重启客户机">
              口令会在开机时由 cloud-init 写入，所以提交后会立即重启
              {guest?.name || guest?.vmid}（先尝试正常关机，最多等 5 分钟）。
              正在跑业务的话，请挑个维护窗口再操作。
            </Notice>
          ) : (
            <Notice tone="info" title="不会重启客户机">
              口令即时生效。改完请通过安全渠道告知使用这台机器的人，面板不会替他
              们记住这个口令。
            </Notice>
          )}
        </>
      ) : null}
    </Modal>
  );
}
