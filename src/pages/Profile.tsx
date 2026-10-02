/* ==========================================================================
   ProxCenter — 个人中心
   普通用户自助维护：个人信息（邮箱）、登录密码，并查看自己的角色与权限。
   ========================================================================== */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authApi, tokensApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import type { ApiToken, ApiTokenCreated, TwoFactorSetup } from '../api/types';
import { PageShell } from '../components/Layout';
import { Card, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Field, Input, Select } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Notice } from '../components/ui/EmptyState';
import {
  IconCheck,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconKey,
  IconPlus,
  IconSave,
  IconShield,
  IconTerminal,
  IconTrash,
  IconUser,
} from '../components/Icons';
import { roleMeta } from '../utils/status'
import { tStatic, useT } from '../i18n';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';

/* ---------------------------------------------------------------------------
   校验：与后端 security 的规则保持一致（后端仍会再校验一次）
   --------------------------------------------------------------------------- */

function emailError(value: string): string | undefined {
  const email = value.trim();
  if (!email) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return tStatic('profile.emailInvalid');
  if (email.length > 255) return tStatic('profile.emailTooLong');
  return undefined;
}

function passwordError(value: string): string | undefined {
  if (!value) return tStatic('profile.pwdRequired');
  if (value.length < 8) return tStatic('profile.pwdMin');
  if (!/[A-Za-z]/.test(value)) return tStatic('profile.pwdLetter');
  if (!/\d/.test(value)) return tStatic('profile.pwdDigit');
  return undefined;
}

/* ---------------------------------------------------------------------------
   API Token：展示用的小工具
   --------------------------------------------------------------------------- */

/** 三态徽章：已吊销 / 已过期 / 有效。三处展示共用，免得各写一套判定。 */
function tokenState(t: ApiToken): {
  label: string;
  variant: 'success' | 'danger' | 'neutral';
} {
  if (t.revoked) return { label: tStatic('profile.tokenRevoked'), variant: 'neutral' };
  if (t.expired) return { label: tStatic('profile.tokenExpired'), variant: 'danger' };
  return { label: tStatic('profile.tokenValid'), variant: 'success' };
}

/**
 * 有效期文案。`expires_at === 0` 是「永不过期」—— 服务端允许这么签，
 * 但界面必须把它明说出来，否则用户不会意识到这是一份永久通行证。
 */
function tokenExpiry(t: ApiToken): string {
  if (!t.expires_at) return tStatic('profile.tokenNeverExpires');
  const at = new Date(t.expires_at * 1000);
  const days = Math.ceil((t.expires_at * 1000 - Date.now()) / 86_400_000);
  if (days <= 0) {
    return tStatic('profile.tokenExpiredAt', { date: at.toLocaleDateString() });
  }
  return tStatic('profile.tokenExpiresIn', { date: at.toLocaleDateString(), n: days });
}

function tokenLastUsed(t: ApiToken): string {
  if (!t.last_used) return tStatic('profile.tokenNeverUsed');
  const at = new Date(t.last_used * 1000).toLocaleString();
  return t.last_ip ? `${at} · ${t.last_ip}` : at;
}

/* ---------------------------------------------------------------------------
   页面
   --------------------------------------------------------------------------- */

export function Profile() {
  const t = useT();
  const { user, refresh, logoutAll } = useAuth();
  const toast = useToast();

  /* ---- 个人信息 ---- */
  const [email, setEmail] = useState(user?.email ?? '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | undefined>();

  const savedEmail = user?.email ?? '';
  const emailDirty = email.trim() !== savedEmail;

  /* ---- 修改密码 ---- */
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [savingPwd, setSavingPwd] = useState(false);
  const [pwdError, setPwdError] = useState<string | undefined>();

  /* ---- 修改密码：开了两步验证还要动态码 ---- */
  const [pwdTotp, setPwdTotp] = useState('');

  /* ---- 两步验证（TOTP）---- */
  const tfaQuery = useQuery({
    queryKey: ['auth', '2fa'],
    queryFn: authApi.twoFactorStatus,
    retry: false,
  });
  const [tfaSetup, setTfaSetup] = useState<TwoFactorSetup | null>(null);
  const [tfaCode, setTfaCode] = useState('');
  const [tfaError, setTfaError] = useState<string | undefined>();
  const [tfaBusy, setTfaBusy] = useState(false);
  /* 恢复码只在开启成功那一刻返回一次，先用本地状态留住给用户抄 */
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [disablePwd, setDisablePwd] = useState('');
  const [disableCode, setDisableCode] = useState('');

  /* ---- 已登录设备（服务端会话）---- */
  const sessionsQuery = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: authApi.sessions,
    retry: false,
  });

  /* ---- 个人 API Token（脚本 / 外部系统对接）---- */
  const tokensQuery = useQuery({
    queryKey: ['auth', 'tokens'],
    queryFn: tokensApi.list,
    retry: false,
  });
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [tokenTtl, setTokenTtl] = useState('90');
  const [tokenError, setTokenError] = useState<string | undefined>();
  const [tokenBusy, setTokenBusy] = useState(false);
  /* 创建成功那一刻的明文：只活在这次表单里，关掉弹框就再也取不回来了 */
  const [issued, setIssued] = useState<ApiTokenCreated | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiToken | null>(null);

  /* ---- 我的角色与权限 ---- */
  const permsQuery = useQuery({
    queryKey: ['auth', 'my-permissions'],
    queryFn: authApi.myPermissions,
    staleTime: 300_000,
    retry: false,
  });

  const role = useMemo(() => roleMeta(user?.role, t), [user?.role, t]);
  const perms = permsQuery.data;

  /* ------------------------------------------------------------------ 提交 */

  const saveProfile = async () => {
    const invalid = emailError(email);
    if (invalid) {
      setProfileError(invalid);
      return;
    }
    setProfileError(undefined);
    setSavingProfile(true);
    try {
      const updated = await authApi.updateProfile({ email: email.trim() });
      // 后端返回的是权威值：用它覆盖本地状态与缓存，避免界面与库不一致
      await refresh().catch(() => undefined);
      setEmail(updated.email ?? email.trim());
      toast.success(t('profile.saved'), t('profile.savedDetail'));
    } catch (err) {
      setProfileError(errorMessage(err));
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async () => {
    const invalid = passwordError(next);
    if (invalid) {
      setPwdError(invalid);
      return;
    }
    if (next !== confirm) {
      setPwdError(t('profile.pwdMismatch'));
      return;
    }
    if (next === current) {
      setPwdError(t('profile.pwdSame'));
      return;
    }
    if (user?.totp_enabled && !pwdTotp.trim()) {
      setPwdError(t('profile.totpRequired'));
      return;
    }
    setPwdError(undefined);
    setSavingPwd(true);
    try {
      const res = await authApi.changePassword({
        current_password: current,
        new_password: next,
        totp_code: user?.totp_enabled ? pwdTotp.trim() : undefined,
      });
      // 后端改完密码会踢掉其它设备，并给本次响应换发新的 HttpOnly Cookie
      // （access/refresh/CSRF 一起换），前端不需要再做任何令牌处理。
      setCurrent('');
      setNext('');
      setConfirm('');
      setPwdTotp('');
      toast.success(
        t('profile.pwdUpdated'),
        res.other_sessions_revoked
          ? t('profile.pwdRevokedOther', { n: res.other_sessions_revoked })
          : t('profile.pwdNextLogin'),
      );
    } catch (err) {
      setPwdError(errorMessage(err));
    } finally {
      setSavingPwd(false);
    }
  };

  /* ------------------------------------------------------- 两步验证操作 */

  const startTfaSetup = async () => {
    setTfaBusy(true);
    setTfaError(undefined);
    try {
      const res = await authApi.setupTwoFactor();
      setTfaSetup(res);
      setTfaCode('');
      setRecoveryCodes([]);
    } catch (err) {
      setTfaError(errorMessage(err));
    } finally {
      setTfaBusy(false);
    }
  };

  const confirmTfa = async () => {
    if (!tfaCode.trim()) {
      setTfaError(t('profile.tfaInvalidCode'));
      return;
    }
    setTfaBusy(true);
    setTfaError(undefined);
    try {
      const res = await authApi.enableTwoFactor(tfaCode.trim());
      setRecoveryCodes(res.recovery_codes);
      setTfaSetup(null);
      setTfaCode('');
      await refresh().catch(() => undefined);
      await tfaQuery.refetch();
      toast.success(t('profile.tfaEnabled'), t('profile.tfaEnabledDetail'));
    } catch (err) {
      setTfaError(errorMessage(err));
    } finally {
      setTfaBusy(false);
    }
  };

  const disableTfa = async () => {
    if (!disablePwd || !disableCode.trim()) {
      setTfaError(t('profile.tfaDisableNeed'));
      return;
    }
    setTfaBusy(true);
    setTfaError(undefined);
    try {
      await authApi.disableTwoFactor(disablePwd, disableCode.trim());
      setDisablePwd('');
      setDisableCode('');
      setRecoveryCodes([]);
      await refresh().catch(() => undefined);
      await tfaQuery.refetch();
      toast.success(t('profile.tfaDisabled'), t('profile.tfaDisabledDetail'));
    } catch (err) {
      setTfaError(errorMessage(err));
    } finally {
      setTfaBusy(false);
    }
  };

  /* ------------------------------------------------------- 登录设备操作 */

  const revokeSession = async (id: string) => {
    try {
      await authApi.revokeSession(id);
      await sessionsQuery.refetch();
      toast.success(t('profile.sessionRevoked'));
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
    }
  };

  const handleLogoutAll = async () => {
    // 后端会让所有凭据失效（含当前会话与全部 API Token），本地会话随之清空并
    // 跳回登录页
    await logoutAll();
  };

  /* ------------------------------------------------------ API Token 操作 */

  const copyText = async (text: string, title = t('common.copied')) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(title);
    } catch {
      toast.error(t('common.copyFailed'), t('profile.copyFailedHint'));
    }
  };

  const openTokenModal = () => {
    setTokenName('');
    setTokenTtl(String(tokenMeta?.default_ttl_days ?? 90));
    setTokenError(undefined);
    setTokenOpen(true);
  };

  const createToken = async () => {
    const name = tokenName.trim();
    if (!name) {
      setTokenError(t('profile.tokenNameRequired'));
      return;
    }
    setTokenError(undefined);
    setTokenBusy(true);
    try {
      const created = await tokensApi.create({
        name,
        ttl_days: Number(tokenTtl) || 0,
      });
      setTokenOpen(false);
      // 明文只在这一刻存在：切到「已签发」视图让用户当场复制走
      setIssued(created);
      await tokensQuery.refetch();
    } catch (err) {
      setTokenError(errorMessage(err));
    } finally {
      setTokenBusy(false);
    }
  };

  const revokeToken = async () => {
    const target = revokeTarget;
    if (!target) return;
    try {
      await tokensApi.revoke(target.id);
      setRevokeTarget(null);
      await tokensQuery.refetch();
      toast.success(
        t('profile.tokenRevokedToast'),
        t('profile.tokenRevokedDetail', { name: target.name }),
      );
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
    }
  };

  const tfa = tfaQuery.data;
  const sessions = sessionsQuery.data?.sessions ?? [];
  const tokenMeta = tokensQuery.data;
  const tokens = tokenMeta?.items ?? [];

  /* ------------------------------------------------------------------ 渲染 */

  const pwdField = (
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
  ) => (
    <Input
      type={showPwd ? 'text' : 'password'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete="new-password"
      placeholder={placeholder}
      suffix={
        <IconButton
          label={showPwd ? t('profile.hidePassword') : t('profile.showPassword')}
          onClick={() => setShowPwd((v) => !v)}
        >
          {showPwd ? <IconEyeOff size={15} /> : <IconEye size={15} />}
        </IconButton>
      }
    />
  );

  return (
    <PageShell
      title={t('profile.title')}
      subtitle={t('profile.subtitle')}
    >
      {/* ---------------- 账号概要 ----------------
          这一页有六个区块、将近两屏，直接铺卡片会让人不知道从哪里看起。
          顶部先把「我是谁、安不安全」讲清楚：身份 + 四个关键状态，
          顺便充当二级导航。 */}
      <section className="profile-hero" aria-label={t('profile.heroAria')}>
        <div className="profile-identity">
          <span className="profile-avatar" aria-hidden="true">
            {(user?.username ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <div className="profile-identity-text">
            <div className="profile-name">
              {user?.username ?? t('profile.notLoggedIn')}
              <Badge variant={role.variant} size="sm">
                {role.label}
              </Badge>
            </div>
            <div className="profile-email">
              {savedEmail || t('profile.noEmail')}
            </div>
          </div>
        </div>

        <div className="profile-stats">
          <a className="profile-stat" href="#profile-security">
            <span className="profile-stat-label">{t('profile.statTfa')}</span>
            <span
              className={`profile-stat-value ${
                tfa?.enabled ? 'is-on' : 'is-off'
              }`}
            >
              {tfaQuery.isLoading
                ? '…'
                : tfa?.enabled
                  ? t('profile.tfaOn')
                  : t('profile.tfaOff')}
            </span>
          </a>
          <a className="profile-stat" href="#profile-security">
            <span className="profile-stat-label">{t('profile.statSessions')}</span>
            <span className="profile-stat-value">{sessions.length}</span>
          </a>
          <a className="profile-stat" href="#profile-tokens">
            <span className="profile-stat-label">{t('profile.statTokens')}</span>
            <span className="profile-stat-value">
              {tokenMeta ? `${tokenMeta.active}/${tokenMeta.max}` : '—'}
            </span>
          </a>
          <a className="profile-stat" href="#profile-perms">
            <span className="profile-stat-label">{t('profile.statPerms')}</span>
            <span className="profile-stat-value">
              {perms
                ? perms.is_admin
                  ? t('profile.allPerms')
                  : perms.permissions.length
                : '—'}
            </span>
          </a>
        </div>
      </section>

      <nav className="profile-nav" aria-label={t('profile.navAria')}>
        <a href="#profile-account">{t('profile.navAccount')}</a>
        <a href="#profile-security">{t('profile.navSecurity')}</a>
        <a href="#profile-tokens">API Token</a>
        <a href="#profile-perms">{t('profile.navPerms')}</a>
      </nav>

      <div className="grid grid-2" id="profile-account">
        {/* ---------------- 基本信息 ---------------- */}
        <Card collapsible={false}>
          <CardHeader
            title={t('profile.basicTitle')}
            subtitle={t('profile.basicSubtitle')}
            icon={<IconUser size={16} />}
          />
          <div className="dyn-list">
            <Field
              label={t('profile.fieldUsername')}
              hint={t('profile.fieldUsernameHint')}
            >
              <Input value={user?.username ?? ''} disabled />
            </Field>

            <Field
              label={t('profile.fieldRole')}
              hint={perms?.role_description || undefined}
            >
              <div className="form-row">
                <Badge variant={role.variant} size="sm">
                  {role.label}
                </Badge>
                {user?.permissions_override ? (
                  <span className="fs-xs text-muted">
                    {t('profile.permsOverride')}
                  </span>
                ) : null}
              </div>
            </Field>

            <Field
              label={t('profile.fieldEmail')}
              error={profileError}
              hint={t('profile.fieldEmailHint')}
            >
              <Input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (profileError) setProfileError(undefined);
                }}
                placeholder="user@example.com"
                autoComplete="email"
              />
            </Field>

            <div className="form-row">
              <Button
                variant="primary"
                icon={<IconSave size={15} />}
                onClick={() => void saveProfile()}
                loading={savingProfile}
                disabled={!emailDirty}
              >
                {t('profile.saveChanges')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setEmail(savedEmail);
                  setProfileError(undefined);
                }}
                disabled={!emailDirty || savingProfile}
              >
                {t('profile.revert')}
              </Button>
            </div>
          </div>
        </Card>

        {/* ---------------- 修改密码 ---------------- */}
        <Card collapsible={false}>
          <CardHeader
            title={t('profile.pwdTitle')}
            subtitle={t('profile.pwdSubtitle')}
            icon={<IconKey size={16} />}
          />
          <div className="dyn-list">
            <Field label={t('profile.fieldCurrentPwd')} required error={pwdError}>
              {pwdField(current, setCurrent, t('profile.currentPwdPlaceholder'))}
            </Field>

            <Field
              label={t('profile.fieldNewPwd')}
              required
              hint={t('profile.fieldNewPwdHint')}
            >
              {pwdField(next, (v) => {
                setNext(v);
                if (pwdError) setPwdError(undefined);
              }, t('profile.newPwdPlaceholder'))}
            </Field>

            <Field label={t('profile.fieldConfirmPwd')} required>
              {pwdField(confirm, setConfirm, t('profile.confirmPwdPlaceholder'))}
            </Field>

            {user?.totp_enabled ? (
              <Field
                label={t('profile.fieldTotp')}
                required
                hint={t('profile.fieldTotpHint')}
              >
                <Input
                  value={pwdTotp}
                  onChange={(e) => setPwdTotp(e.target.value)}
                  placeholder={t('profile.totpPlaceholder')}
                  autoComplete="one-time-code"
                  prefix={<IconShield size={15} />}
                />
              </Field>
            ) : null}

            <Notice tone="info">{t('profile.pwdNotice')}</Notice>

            <div className="form-row">
              <Button
                variant="primary"
                icon={<IconCheck size={15} />}
                onClick={() => void changePassword()}
                loading={savingPwd}
                disabled={!current || !next || !confirm}
              >
                {t('profile.updatePwd')}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-2" id="profile-security">
        {/* ---------------- 两步验证 ---------------- */}
        <Card collapsible={false}>
          <CardHeader
            title={t('profile.tfaTitle')}
            subtitle={t('profile.tfaSubtitle')}
            icon={<IconShield size={16} />}
          />
          <div className="dyn-list">
            <Field label={t('profile.fieldStatus')}>
              <div className="form-row">
                <Badge variant={tfa?.enabled ? 'success' : 'neutral'} size="sm">
                  {tfaQuery.isLoading
                    ? t('profile.checking')
                    : tfa?.enabled
                      ? t('profile.tfaOn')
                      : t('profile.tfaOff')}
                </Badge>
                {tfa?.required ? (
                  <span className="fs-xs text-muted">
                    {t('profile.tfaRequiredNote')}
                  </span>
                ) : null}
                {tfa?.enabled ? (
                  <span className="fs-xs text-muted">
                    {t('profile.recoveryLeft', { n: tfa.recovery_codes_left })}
                  </span>
                ) : null}
              </div>
            </Field>

            {tfaError ? (
              <Notice tone="warning" title={t('profile.opIncomplete')}>
                {tfaError}
              </Notice>
            ) : null}

            {recoveryCodes.length > 0 ? (
              <Notice tone="info" title={t('profile.saveRecoveryNow')}>
                <div className="mono fs-sm">{recoveryCodes.join('  ')}</div>
                <div className="fs-xs text-muted mt-8">
                  {t('profile.recoveryHint')}
                </div>
              </Notice>
            ) : null}

            {!tfa?.enabled ? (
              tfaSetup ? (
                <>
                  <Field
                    label={t('profile.step1Scan')}
                    hint={t('profile.step1Hint')}
                  >
                    <div className="text-center">
                      <img
                        className="tfa-qr"
                        src={tfaSetup.qr_png}
                        alt={t('profile.qrAlt')}
                      />
                    </div>
                  </Field>
                  <Field label={t('profile.fieldSecret')}>
                    <Input value={tfaSetup.secret} readOnly />
                  </Field>
                  <Field label={t('profile.step2Code')} required>
                    <Input
                      value={tfaCode}
                      onChange={(e) => setTfaCode(e.target.value)}
                      placeholder="123456"
                      autoComplete="one-time-code"
                      maxLength={6}
                    />
                  </Field>
                  <div className="form-row">
                    <Button
                      variant="primary"
                      icon={<IconCheck size={15} />}
                      onClick={() => void confirmTfa()}
                      loading={tfaBusy}
                    >
                      {t('profile.confirmEnable')}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setTfaSetup(null);
                        setTfaError(undefined);
                      }}
                      disabled={tfaBusy}
                    >
                      取消
                    </Button>
                  </div>
                </>
              ) : (
                <div className="form-row">
                  <Button
                    variant="primary"
                    icon={<IconShield size={15} />}
                    onClick={() => void startTfaSetup()}
                    loading={tfaBusy}
                  >
                    {t('profile.startTfa')}
                  </Button>
                </div>
              )
            ) : tfa?.required ? (
              <div className="fs-sm text-muted">{t('profile.tfaCannotDisable')}</div>
            ) : (
              <>
                <Field label={t('profile.fieldCurrentPwd')} required>
                  <Input
                    type="password"
                    value={disablePwd}
                    onChange={(e) => setDisablePwd(e.target.value)}
                    autoComplete="current-password"
                    placeholder={t('profile.disablePwdPlaceholder')}
                  />
                </Field>
                <Field label={t('profile.fieldCodeOrRecovery')} required>
                  <Input
                    value={disableCode}
                    onChange={(e) => setDisableCode(e.target.value)}
                    placeholder="123456"
                    autoComplete="one-time-code"
                    maxLength={16}
                  />
                </Field>
                <div className="form-row">
                  <Button
                    variant="danger"
                    onClick={() => void disableTfa()}
                    loading={tfaBusy}
                  >
                    {t('profile.disableTfa')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </Card>

        {/* ---------------- 登录设备 ---------------- */}
        <Card collapsible={false}>
          <CardHeader
            title={t('profile.sessionsTitle')}
            subtitle={t('profile.sessionsSubtitle')}
            icon={<IconKey size={16} />}
          />
          <div className="dyn-list">
            {sessionsQuery.isError ? (
              <Notice tone="warning" title={t('profile.sessionsLoadFailed')}>
                {errorMessage(sessionsQuery.error)}
              </Notice>
            ) : sessions.length === 0 ? (
              <div className="profile-empty">{t('profile.noSessions')}</div>
            ) : (
              sessions.map((s) => (
                <div key={s.id} className={`profile-item${s.current ? ' is-current' : ''}`}>
                  <div className="profile-item-main">
                    <div className="profile-item-title">
                      <span className="mono">{s.ip || t('profile.unknownSource')}</span>
                      {s.current ? (
                        <Badge variant="accent" size="sm">
                          {t('profile.currentDevice')}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="profile-item-meta">
                      {new Date(s.created * 1000).toLocaleString()} ·{' '}
                      {s.user_agent || t('profile.unknownClient')}
                    </div>
                  </div>
                  {s.current ? null : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void revokeSession(s.id)}
                    >
                      {t('profile.revokeSession')}
                    </Button>
                  )}
                </div>
              ))
            )}

            <div className="form-row">
              <Button
                variant="ghost"
                onClick={() => void sessionsQuery.refetch()}
                disabled={sessionsQuery.isFetching}
              >
                {t('profile.refreshList')}
              </Button>
              <Button variant="danger" onClick={() => void handleLogoutAll()}>
                {t('profile.logoutAll')}
              </Button>
            </div>
          </div>
        </Card>

      </div>

      {/* ---------------- 个人 API Token ----------------
          令牌单独占满一行：名称、创建时间、有效期、最后使用（含来源 IP）
          这些串起来很长，挤在半栏里必然折行折得没法看。 */}
      <div id="profile-tokens">
        <Card collapsible={false}>
          <CardHeader
            title={t('profile.tokensTitle')}
            subtitle={t('profile.tokensSubtitle')}
            icon={<IconTerminal size={16} />}
          />
          <div className="dyn-list">
            {tokensQuery.isError ? (
              <Notice tone="warning" title={t('profile.tokensLoadFailed')}>
                {errorMessage(tokensQuery.error)}
              </Notice>
            ) : null}

            {tokenMeta && !tokenMeta.enabled ? (
              <Notice tone="warning" title={t('profile.tokensDisabledTitle')}>
                {t('profile.tokensDisabledBody')}
              </Notice>
            ) : null}

            {!tokensQuery.isError && tokens.length === 0 ? (
              <div className="profile-empty">{t('profile.noTokens')}</div>
            ) : (
              tokens.map((tok) => {
                const state = tokenState(tok);
                const dead = tok.revoked || tok.expired;
                return (
                  <div
                    key={tok.id}
                    className={`profile-item${dead ? ' is-muted' : ''}`}
                  >
                    <div className="profile-item-main">
                      <div className="profile-item-title">
                        <span>{tok.name}</span>
                        <Badge variant={state.variant} size="sm">
                          {state.label}
                        </Badge>
                        <code className="fs-xs text-muted">{tok.prefix}…</code>
                      </div>
                      <div className="profile-item-meta">
                        {t('profile.tokenCreatedAt', {
                          date: new Date(tok.created * 1000).toLocaleString(),
                        })}{' '}
                        ·{' '}
                        {t('profile.tokenValidFor', {
                          expiry: tokenExpiry(tok),
                        })}{' '}
                        ·{' '}
                        {t('profile.tokenLastUsedLabel', {
                          used: tokenLastUsed(tok),
                        })}
                      </div>
                    </div>
                    {dead ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<IconTrash size={14} />}
                        onClick={() => setRevokeTarget(tok)}
                      >
                        {t('profile.revoke')}
                      </Button>
                    )}
                  </div>
                );
              })
            )}

            <div className="profile-item profile-item-foot">
              <div className="profile-item-meta">
                {tokenMeta
                  ? t('profile.tokenUsage', {
                      active: tokenMeta.active,
                      max: tokenMeta.max,
                    })
                  : ''}
              </div>
              <div className="form-row">
                <Button
                  variant="ghost"
                  onClick={() => void tokensQuery.refetch()}
                  disabled={tokensQuery.isFetching}
                >
                  {t('profile.refreshList')}
                </Button>
                <Button
                  variant="primary"
                  onClick={openTokenModal}
                  icon={<IconPlus size={15} />}
                  disabled={
                    tokenMeta
                      ? !tokenMeta.enabled || tokenMeta.active >= tokenMeta.max
                      : false
                  }
                >
                  {t('profile.createToken')}
                </Button>
              </div>
            </div>

            <div className="fs-xs text-muted">{t('profile.tokenFootnote')}</div>
          </div>
        </Card>
      </div>

      {/* ---------------- 我的权限 ---------------- */}
      <div id="profile-perms">
        <Card>
          <CardHeader
            title={t('profile.myPermsTitle')}
            subtitle={
              perms
                ? perms.is_admin
                  ? t('profile.permsSubtitleAdmin', { role: perms.role_name })
                  : t('profile.permsSubtitle', {
                      role: perms.role_name,
                      n: perms.permissions.length,
                    })
                : t('profile.loading')
            }
            icon={<IconShield size={16} />}
          />
          {permsQuery.isError ? (
            <Notice tone="warning" title={t('profile.permsLoadFailed')}>
              {errorMessage(permsQuery.error)}
            </Notice>
          ) : perms && perms.groups.length > 0 ? (
            /* 按域分组，每组一行小标题 + 一票权限胶囊。
               权限十几项，混在一起排会分不清「能删机器」和「能看机器」。 */
            <div className="perm-groups">
              {perms.groups.map((group) => (
                <div className="perm-group" key={group.key}>
                  <div className="perm-group-label">{group.label}</div>
                  <div className="perm-chips">
                    {group.permissions.map((item) => (
                      <span
                        className="perm-chip"
                        key={item.key}
                        title={item.desc || item.key}
                      >
                        {item.label}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-muted fs-sm">{t('profile.permsEmpty')}</div>
          )}
        </Card>
      </div>

      {/* ---------------- API Token：创建 ---------------- */}
      <Modal
        open={tokenOpen}
        onClose={() => setTokenOpen(false)}
        title={t('profile.createTokenTitle')}
        description={t('profile.createTokenDesc')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTokenOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void createToken()}
              loading={tokenBusy}
            >
              {t('common.create')}
            </Button>
          </>
        }
      >
        {tokenError ? (
          <Notice tone="warning" title={t('profile.cannotCreate')}>
            {tokenError}
          </Notice>
        ) : null}
        <Field
          label={t('profile.fieldTokenName')}
          required
          hint={t('profile.fieldTokenNameHint')}
        >
          <Input
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            placeholder={t('profile.tokenNamePlaceholder')}
            maxLength={128}
            autoFocus
          />
        </Field>
        <Field label={t('profile.fieldTtl')} hint={t('profile.fieldTtlHint')}>
          <Select
            value={tokenTtl}
            onChange={(e) => setTokenTtl(e.target.value)}
            options={[
              { label: t('profile.ttl30'), value: '30' },
              { label: t('profile.ttl90'), value: '90' },
              { label: t('profile.ttl180'), value: '180' },
              { label: t('profile.ttl365'), value: '365' },
              { label: t('profile.tokenNeverExpires'), value: '0' },
            ]}
          />
        </Field>
        <Notice tone="info" title={t('profile.stepUpTitle')}>
          {t('profile.stepUpBody')}
        </Notice>
      </Modal>

      {/* ---------------- API Token：明文（只此一次） ---------------- */}
      <Modal
        open={issued !== null}
        onClose={() => setIssued(null)}
        title={t('profile.issuedTitle')}
        description={t('profile.issuedDesc')}
        /* 这枚明文是不可再生的，误点遮罩关掉就永久丢了，所以禁用遮罩关闭 */
        closeOnOverlay={false}
        hideClose
        footer={
          <Button
            variant="primary"
            icon={<IconCopy size={15} />}
            onClick={() => {
              void copyText(issued?.token ?? '', t('profile.tokenCopied'));
              setIssued(null);
            }}
          >
            {t('profile.copyAndClose')}
          </Button>
        }
      >
        <Notice tone="warning" title={t('profile.onceOnlyTitle')}>
          {t('profile.onceOnlyBody')}
        </Notice>
        <Field label={t('profile.fieldToken')}>
          <Input
            readOnly
            value={issued?.token ?? ''}
            onFocus={(e) => e.target.select()}
          />
        </Field>
        <div className="fs-xs text-muted">
          {t('profile.usage')} <code>Authorization: Bearer &lt;token&gt;</code>
        </div>
      </Modal>

      {/* ---------------- API Token：吊销确认 ---------------- */}
      <ConfirmDialog
        open={revokeTarget !== null}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => void revokeToken()}
        title={t('profile.revokeTitle')}
        message={t('profile.revokeMessage', {
          name: revokeTarget?.name ?? '',
        })}
        confirmText={t('profile.revokeConfirm')}
        danger
      />
    </PageShell>
  );
}
