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
import { roleMeta } from '../utils/status';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';

/* ---------------------------------------------------------------------------
   校验：与后端 security 的规则保持一致（后端仍会再校验一次）
   --------------------------------------------------------------------------- */

function emailError(value: string): string | undefined {
  const email = value.trim();
  if (!email) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '邮箱格式不正确';
  if (email.length > 255) return '邮箱长度不能超过 255 个字符';
  return undefined;
}

function passwordError(value: string): string | undefined {
  if (!value) return '请输入新密码';
  if (value.length < 8) return '新密码至少 8 位';
  if (!/[A-Za-z]/.test(value)) return '新密码需包含字母';
  if (!/\d/.test(value)) return '新密码需包含数字';
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
  if (t.revoked) return { label: '已吊销', variant: 'neutral' };
  if (t.expired) return { label: '已过期', variant: 'danger' };
  return { label: '有效', variant: 'success' };
}

/**
 * 有效期文案。`expires_at === 0` 是「永不过期」—— 服务端允许这么签，
 * 但界面必须把它明说出来，否则用户不会意识到这是一份永久通行证。
 */
function tokenExpiry(t: ApiToken): string {
  if (!t.expires_at) return '永不过期';
  const at = new Date(t.expires_at * 1000);
  const days = Math.ceil((t.expires_at * 1000 - Date.now()) / 86_400_000);
  if (days <= 0) return `已于 ${at.toLocaleDateString()} 过期`;
  return `${at.toLocaleDateString()}（${days} 天后）`;
}

function tokenLastUsed(t: ApiToken): string {
  if (!t.last_used) return '从未使用';
  const at = new Date(t.last_used * 1000).toLocaleString();
  return t.last_ip ? `${at} · ${t.last_ip}` : at;
}

/* ---------------------------------------------------------------------------
   页面
   --------------------------------------------------------------------------- */

export function Profile() {
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

  const role = useMemo(() => roleMeta(user?.role), [user?.role]);
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
      toast.success('已保存', '个人信息已更新');
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
      setPwdError('两次输入的新密码不一致');
      return;
    }
    if (next === current) {
      setPwdError('新密码不能与当前密码相同');
      return;
    }
    if (user?.totp_enabled && !pwdTotp.trim()) {
      setPwdError('请输入两步验证动态码');
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
        '密码已更新',
        res.other_sessions_revoked
          ? `已在其它 ${res.other_sessions_revoked} 台设备上退出登录`
          : '下次登录请使用新密码',
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
      setTfaError('请输入认证器 App 里显示的 6 位动态码');
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
      toast.success('两步验证已开启', '请把恢复码保存到安全的地方');
    } catch (err) {
      setTfaError(errorMessage(err));
    } finally {
      setTfaBusy(false);
    }
  };

  const disableTfa = async () => {
    if (!disablePwd || !disableCode.trim()) {
      setTfaError('关闭两步验证需要同时提供当前密码与动态码');
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
      toast.success('两步验证已关闭', '只用密码即可登录了');
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
      toast.success('该设备已被退出登录');
    } catch (err) {
      toast.error('操作失败', errorMessage(err));
    }
  };

  const handleLogoutAll = async () => {
    // 后端会让所有凭据失效（含当前会话与全部 API Token），本地会话随之清空并
    // 跳回登录页
    await logoutAll();
  };

  /* ------------------------------------------------------ API Token 操作 */

  const copyText = async (text: string, title = '已复制到剪贴板') => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(title);
    } catch {
      toast.error('复制失败', '浏览器不允许访问剪贴板，请手动选中复制');
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
      setTokenError('请给令牌起个名字，便于日后辨认');
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
      toast.success('令牌已吊销', `「${target.name}」立刻失效`);
    } catch (err) {
      toast.error('操作失败', errorMessage(err));
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
          label={showPwd ? '隐藏密码' : '显示密码'}
          onClick={() => setShowPwd((v) => !v)}
        >
          {showPwd ? <IconEyeOff size={15} /> : <IconEye size={15} />}
        </IconButton>
      }
    />
  );

  return (
    <PageShell
      title="个人中心"
      subtitle="维护你自己的账号信息与登录密码，这里只影响当前账号"
    >
      {/* ---------------- 账号概要 ----------------
          这一页有六个区块、将近两屏，直接铺卡片会让人不知道从哪里看起。
          顶部先把「我是谁、安不安全」讲清楚：身份 + 四个关键状态，
          顺便充当二级导航。 */}
      <section className="profile-hero" aria-label="账号概要">
        <div className="profile-identity">
          <span className="profile-avatar" aria-hidden="true">
            {(user?.username ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <div className="profile-identity-text">
            <div className="profile-name">
              {user?.username ?? '未登录'}
              <Badge variant={role.variant} size="sm">
                {role.label}
              </Badge>
            </div>
            <div className="profile-email">
              {savedEmail || '未设置邮箱（可用于接收告警与审批结果）'}
            </div>
          </div>
        </div>

        <div className="profile-stats">
          <a className="profile-stat" href="#profile-security">
            <span className="profile-stat-label">两步验证</span>
            <span
              className={`profile-stat-value ${
                tfa?.enabled ? 'is-on' : 'is-off'
              }`}
            >
              {tfaQuery.isLoading ? '…' : tfa?.enabled ? '已开启' : '未开启'}
            </span>
          </a>
          <a className="profile-stat" href="#profile-security">
            <span className="profile-stat-label">登录设备</span>
            <span className="profile-stat-value">{sessions.length}</span>
          </a>
          <a className="profile-stat" href="#profile-tokens">
            <span className="profile-stat-label">有效令牌</span>
            <span className="profile-stat-value">
              {tokenMeta ? `${tokenMeta.active}/${tokenMeta.max}` : '—'}
            </span>
          </a>
          <a className="profile-stat" href="#profile-perms">
            <span className="profile-stat-label">权限项</span>
            <span className="profile-stat-value">
              {perms ? (perms.is_admin ? '全部' : perms.permissions.length) : '—'}
            </span>
          </a>
        </div>
      </section>

      <nav className="profile-nav" aria-label="个人中心区块导航">
        <a href="#profile-account">账号信息</a>
        <a href="#profile-security">登录与安全</a>
        <a href="#profile-tokens">API Token</a>
        <a href="#profile-perms">我的权限</a>
      </nav>

      <div className="grid grid-2" id="profile-account">
        {/* ---------------- 基本信息 ---------------- */}
        <Card collapsible={false}>
          <CardHeader
            title="基本信息"
            subtitle="用户名与角色由管理员维护"
            icon={<IconUser size={16} />}
          />
          <div className="dyn-list">
            <Field label="用户名" hint="登录凭据，创建后不可修改">
              <Input value={user?.username ?? ''} disabled />
            </Field>

            <Field label="角色" hint={perms?.role_description || undefined}>
              <div className="form-row">
                <Badge variant={role.variant} size="sm">
                  {role.label}
                </Badge>
                {user?.permissions_override ? (
                  <span className="fs-xs text-muted">
                    已由管理员单独指定权限（不随角色变化）
                  </span>
                ) : null}
              </div>
            </Field>

            <Field
              label="邮箱"
              error={profileError}
              hint="可选，用于接收通知；留空表示不设置"
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
                保存修改
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setEmail(savedEmail);
                  setProfileError(undefined);
                }}
                disabled={!emailDirty || savingProfile}
              >
                还原
              </Button>
            </div>
          </div>
        </Card>

        {/* ---------------- 修改密码 ---------------- */}
        <Card collapsible={false}>
          <CardHeader
            title="修改密码"
            subtitle="需要先验证当前密码"
            icon={<IconKey size={16} />}
          />
          <div className="dyn-list">
            <Field label="当前密码" required error={pwdError}>
              {pwdField(current, setCurrent, '请输入当前登录密码')}
            </Field>

            <Field label="新密码" required hint="至少 8 位，需同时包含字母与数字">
              {pwdField(next, (v) => {
                setNext(v);
                if (pwdError) setPwdError(undefined);
              }, '8 位以上，含字母与数字')}
            </Field>

            <Field label="确认新密码" required>
              {pwdField(confirm, setConfirm, '再次输入新密码')}
            </Field>

            {user?.totp_enabled ? (
              <Field label="两步验证动态码" required hint="改密码属于敏感操作">
                <Input
                  value={pwdTotp}
                  onChange={(e) => setPwdTotp(e.target.value)}
                  placeholder="认证器 App 里的 6 位动态码"
                  autoComplete="one-time-code"
                  prefix={<IconShield size={15} />}
                />
              </Field>
            ) : null}

            <Notice tone="info">
              修改成功后，其它设备会全部退出登录（当前这台会换发新令牌继续用）；
              忘记密码只能请管理员重置。
            </Notice>

            <div className="form-row">
              <Button
                variant="primary"
                icon={<IconCheck size={15} />}
                onClick={() => void changePassword()}
                loading={savingPwd}
                disabled={!current || !next || !confirm}
              >
                更新密码
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-2" id="profile-security">
        {/* ---------------- 两步验证 ---------------- */}
        <Card collapsible={false}>
          <CardHeader
            title="两步验证"
            subtitle="用认证器 App 生成动态码，登录时多加一道校验"
            icon={<IconShield size={16} />}
          />
          <div className="dyn-list">
            <Field label="状态">
              <div className="form-row">
                <Badge variant={tfa?.enabled ? 'success' : 'neutral'} size="sm">
                  {tfaQuery.isLoading
                    ? '检测中…'
                    : tfa?.enabled
                      ? '已开启'
                      : '未开启'}
                </Badge>
                {tfa?.required ? (
                  <span className="fs-xs text-muted">
                    该角色被要求必须开启，未绑定前只能访问本页
                  </span>
                ) : null}
                {tfa?.enabled ? (
                  <span className="fs-xs text-muted">
                    剩余恢复码 {tfa.recovery_codes_left} 张
                  </span>
                ) : null}
              </div>
            </Field>

            {tfaError ? (
              <Notice tone="warning" title="操作未完成">
                {tfaError}
              </Notice>
            ) : null}

            {recoveryCodes.length > 0 ? (
              <Notice tone="info" title="请立刻保存恢复码（只显示这一次）">
                <div className="mono fs-sm">{recoveryCodes.join('  ')}</div>
                <div className="fs-xs text-muted mt-8">
                  手机丢失时用其中任意一张登录，每张只能用一次。
                </div>
              </Notice>
            ) : null}

            {!tfa?.enabled ? (
              tfaSetup ? (
                <>
                  <Field
                    label="1. 用认证器 App 扫描二维码"
                    hint="扫码不便时可以手填下面的密钥"
                  >
                    <div className="text-center">
                      <img
                        className="tfa-qr"
                        src={tfaSetup.qr_png}
                        alt="两步验证二维码"
                      />
                    </div>
                  </Field>
                  <Field label="密钥">
                    <Input value={tfaSetup.secret} readOnly />
                  </Field>
                  <Field label="2. 输入 App 里显示的 6 位动态码" required>
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
                      确认开启
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
                    开启两步验证
                  </Button>
                </div>
              )
            ) : tfa?.required ? (
              <div className="fs-sm text-muted">
                当前角色要求必须开启两步验证，无法在此关闭。
              </div>
            ) : (
              <>
                <Field label="当前密码" required>
                  <Input
                    type="password"
                    value={disablePwd}
                    onChange={(e) => setDisablePwd(e.target.value)}
                    autoComplete="current-password"
                    placeholder="确认是你本人"
                  />
                </Field>
                <Field label="动态码 / 恢复码" required>
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
                    关闭两步验证
                  </Button>
                </div>
              </>
            )}
          </div>
        </Card>

        {/* ---------------- 登录设备 ---------------- */}
        <Card collapsible={false}>
          <CardHeader
            title="登录设备"
            subtitle="撤销某台设备的会话即可让它立刻下线"
            icon={<IconKey size={16} />}
          />
          <div className="dyn-list">
            {sessionsQuery.isError ? (
              <Notice tone="warning" title="设备列表加载失败">
                {errorMessage(sessionsQuery.error)}
              </Notice>
            ) : sessions.length === 0 ? (
              <div className="profile-empty">没有已登录的设备记录。</div>
            ) : (
              sessions.map((s) => (
                <div key={s.id} className={`profile-item${s.current ? ' is-current' : ''}`}>
                  <div className="profile-item-main">
                    <div className="profile-item-title">
                      <span className="mono">{s.ip || '未知来源'}</span>
                      {s.current ? (
                        <Badge variant="accent" size="sm">
                          当前设备
                        </Badge>
                      ) : null}
                    </div>
                    <div className="profile-item-meta">
                      {new Date(s.created * 1000).toLocaleString()} ·{' '}
                      {s.user_agent || '未知客户端'}
                    </div>
                  </div>
                  {s.current ? null : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void revokeSession(s.id)}
                    >
                      退出该设备
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
                刷新列表
              </Button>
              <Button variant="danger" onClick={() => void handleLogoutAll()}>
                退出所有设备
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
            title="API Token"
            subtitle="给脚本 / 外部系统的长期凭据，不必再让脚本保管你的登录口令"
            icon={<IconTerminal size={16} />}
          />
          <div className="dyn-list">
            {tokensQuery.isError ? (
              <Notice tone="warning" title="令牌列表加载失败">
                {errorMessage(tokensQuery.error)}
              </Notice>
            ) : null}

            {tokenMeta && !tokenMeta.enabled ? (
              <Notice tone="warning" title="管理员已停用 API Token">
                面板当前不接受 API Token，已签发的也一律失效。
              </Notice>
            ) : null}

            {!tokensQuery.isError && tokens.length === 0 ? (
              <div className="profile-empty">
                还没有创建过 API Token。脚本可以拿它调用面板接口，不必保管你的登录口令。
              </div>
            ) : (
              tokens.map((t) => {
                const state = tokenState(t);
                const dead = t.revoked || t.expired;
                return (
                  <div
                    key={t.id}
                    className={`profile-item${dead ? ' is-muted' : ''}`}
                  >
                    <div className="profile-item-main">
                      <div className="profile-item-title">
                        <span>{t.name}</span>
                        <Badge variant={state.variant} size="sm">
                          {state.label}
                        </Badge>
                        <code className="fs-xs text-muted">{t.prefix}…</code>
                      </div>
                      <div className="profile-item-meta">
                        创建 {new Date(t.created * 1000).toLocaleString()} · 有效期{' '}
                        {tokenExpiry(t)} · 最后使用 {tokenLastUsed(t)}
                      </div>
                    </div>
                    {dead ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<IconTrash size={14} />}
                        onClick={() => setRevokeTarget(t)}
                      >
                        吊销
                      </Button>
                    )}
                  </div>
                );
              })
            )}

            <div className="profile-item profile-item-foot">
              <div className="profile-item-meta">
                {tokenMeta
                  ? `已用 ${tokenMeta.active} / ${tokenMeta.max} 枚有效令牌`
                  : ''}
              </div>
              <div className="form-row">
                <Button
                  variant="ghost"
                  onClick={() => void tokensQuery.refetch()}
                  disabled={tokensQuery.isFetching}
                >
                  刷新列表
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
                  创建令牌
                </Button>
              </div>
            </div>

            <div className="fs-xs text-muted">
              令牌继承你当前的角色权限，但不能执行需要二次确认的操作（删除虚拟机、
              修改连接凭据等）—— 那些只能从浏览器里做。修改密码或「退出所有设备」
              会一并吊销全部令牌，脚本需要重新换一枚。
            </div>
          </div>
        </Card>
      </div>

      {/* ---------------- 我的权限 ---------------- */}
      <div id="profile-perms">
        <Card>
          <CardHeader
            title="我的权限"
            subtitle={
              perms
                ? `${perms.role_name}${perms.is_admin ? '（全部权限）' : ` · 共 ${perms.permissions.length} 项`}`
                : '正在加载…'
            }
            icon={<IconShield size={16} />}
          />
          {permsQuery.isError ? (
            <Notice tone="warning" title="权限信息加载失败">
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
            <div className="text-muted fs-sm">
              当前角色没有可展示的权限项，如有疑问请联系管理员。
            </div>
          )}
        </Card>
      </div>

      {/* ---------------- API Token：创建 ---------------- */}
      <Modal
        open={tokenOpen}
        onClose={() => setTokenOpen(false)}
        title="创建 API Token"
        description="明文只显示一次，请当场复制到脚本或密钥管理系统里"
        footer={
          <>
            <Button variant="ghost" onClick={() => setTokenOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => void createToken()}
              loading={tokenBusy}
            >
              创建
            </Button>
          </>
        }
      >
        {tokenError ? (
          <Notice tone="warning" title="无法创建">
            {tokenError}
          </Notice>
        ) : null}
        <Field
          label="名称"
          required
          hint="用于辨认用途，泄漏时才知道该吊销哪一枚，例如「监控采集」「CI 下发」"
        >
          <Input
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            placeholder="监控采集"
            maxLength={128}
            autoFocus
          />
        </Field>
        <Field
          label="有效期"
          hint="到期后自动失效。「永不过期」适合长期无人值守，风险也最高"
        >
          <Select
            value={tokenTtl}
            onChange={(e) => setTokenTtl(e.target.value)}
            options={[
              { label: '30 天', value: '30' },
              { label: '90 天（推荐）', value: '90' },
              { label: '180 天', value: '180' },
              { label: '365 天', value: '365' },
              { label: '永不过期', value: '0' },
            ]}
          />
        </Field>
        <Notice tone="info" title="创建需要二次确认">
          签发令牌等于多发一份密码，所以会要求你先输入登录密码
          （开了两步验证还要动态码）。
        </Notice>
      </Modal>

      {/* ---------------- API Token：明文（只此一次） ---------------- */}
      <Modal
        open={issued !== null}
        onClose={() => setIssued(null)}
        title="令牌已创建，请立刻复制"
        description="关闭后无法再次查看 —— 服务端只保存摘要，取不回明文"
        /* 这枚明文是不可再生的，误点遮罩关掉就永久丢了，所以禁用遮罩关闭 */
        closeOnOverlay={false}
        hideClose
        footer={
          <Button
            variant="primary"
            icon={<IconCopy size={15} />}
            onClick={() => {
              void copyText(issued?.token ?? '', '令牌已复制');
              setIssued(null);
            }}
          >
            复制并关闭
          </Button>
        }
      >
        <Notice tone="warning" title="这是唯一一次显示明文">
          请立即粘贴到脚本或密钥管理系统。忘了就只能吊销后重新创建一枚。
        </Notice>
        <Field label="API Token">
          <Input
            readOnly
            value={issued?.token ?? ''}
            onFocus={(e) => e.target.select()}
          />
        </Field>
        <div className="fs-xs text-muted">
          用法：请求头 <code>Authorization: Bearer &lt;令牌&gt;</code>
        </div>
      </Modal>

      {/* ---------------- API Token：吊销确认 ---------------- */}
      <ConfirmDialog
        open={revokeTarget !== null}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => void revokeToken()}
        title="吊销 API Token"
        message={`「${revokeTarget?.name ?? ''}」将立即失效，正在用它的脚本会马上开始收到 401。此操作不可撤销。`}
        confirmText="吊销"
        danger
      />
    </PageShell>
  );
}
