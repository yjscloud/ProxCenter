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
import { useT, type TFunc } from '../i18n';
import type { GuestPasswordMethodId, VmSummary } from '../api/types';

/** 面板账号与客户机账号共用一份口令强度口径（后端 security.password_policy_error） */
function passwordProblem(password: string, t: TFunc): string {
  if (password.length < 8) return t('guestPw.errMinLength');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return t('guestPw.errAlnum');
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
  const t = useT();
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
  const policyProblem = password ? passwordProblem(password, t) : '';
  const fieldError = error || policyProblem;

  const submit = async () => {
    if (!guest) return;
    if (!username.trim()) {
      setError(t('guestPw.errUsernameRequired'));
      return;
    }
    const weak = passwordProblem(password, t);
    if (weak) {
      setError(weak);
      return;
    }
    if (password !== confirm) {
      setError(t('guestPw.errMismatch'));
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
        t('guestPw.resetDone', { name: res.username }),
        res.detail ||
          t('guestPw.resetDoneDetail', {
            name: guest.name || guest.vmid,
          }),
      );
      onDone();
    } catch (err) {
      /* 二次确认（step-up）由 axios 拦截器弹框并自动重放，这里只报真正的失败 */
      toast.error(t('guestPw.resetFailed'), errorMessage(err));
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
      title={t('guestPw.title', {
        noun,
        name: guest?.name || guest?.vmid || '',
      })}
      description={t('guestPw.desc', { noun })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<IconKey size={15} />}
            onClick={() => void submit()}
            loading={busy}
            disabled={!canSubmit}
          >
            {t('guestPw.confirm')}
          </Button>
        </>
      }
    >
      {probe.isLoading ? (
        <div className="flex items-center gap-8">
          <Spinner size={16} />
          <span className="fs-sm text-muted">{t('guestPw.probeLoading')}</span>
        </div>
      ) : null}

      {probe.isError ? (
        <Notice tone="danger" title={t('guestPw.probeFailed')}>
          {errorMessage(probe.error)}
        </Notice>
      ) : null}

      {data && !available.length ? (
        <Notice tone="warning" title={t('guestPw.noMethodTitle')}>
          <ul className="m-0 pl-16">
            {data.methods.map((m) => (
              <li key={m.id}>
                <strong>{m.label}</strong>：{m.reason || t('guestPw.unavailable')}
              </li>
            ))}
          </ul>
          {data.kind === 'lxc' ? (
            <>{t('guestPw.lxcNoAgent')}</>
          ) : (
            <>{t('guestPw.vmNoAgent')}</>
          )}
        </Notice>
      ) : null}

      {data && available.length ? (
        <>
          <div className="dyn-list">
            <Input
              label={t('guestPw.fieldUsername')}
              required
              value={username}
              onChange={(e) => {
                usernameTouched.current = true;
                setUsername(e.target.value);
              }}
              placeholder="root"
              hint={t('guestPw.usernameHint')}
            />
            <Input
              label={t('guestPw.fieldPassword')}
              required
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder={t('guestPw.passwordPlaceholder')}
              error={fieldError || undefined}
              hint={fieldError ? undefined : t('guestPw.passwordHint')}
              suffix={
                <IconButton
                  label={
                    show ? t('guestPw.hidePassword') : t('guestPw.showPassword')
                  }
                  onClick={() => setShow((v) => !v)}
                >
                  {show ? <IconEyeOff size={15} /> : <IconEye size={15} />}
                </IconButton>
              }
            />
            <Input
              label={t('guestPw.fieldConfirm')}
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
                label={t('guestPw.fieldMethod')}
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
                  hint: m.available
                    ? m.description
                    : t('guestPw.methodHintUnavailable', {
                        reason: m.reason || t('guestPw.methodUnavailable'),
                      }),
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
            <Notice tone="warning" title={t('guestPw.restartsTitle')}>
              {t('guestPw.restartsBody', {
                name: guest?.name || guest?.vmid,
              })}
            </Notice>
          ) : (
            <Notice tone="info" title={t('guestPw.noRestartTitle')}>
              {t('guestPw.noRestartBody')}
            </Notice>
          )}
        </>
      ) : null}
    </Modal>
  );
}
