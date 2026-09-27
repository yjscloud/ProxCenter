/* ==========================================================================
   ProxCenter — 登录页
   ========================================================================== */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../hooks/useAuth';
import { authApi, healthApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { SliderCaptcha } from '../components/SliderCaptcha';
import {
  IconAlert,
  IconEye,
  IconEyeOff,
  IconKey,
  IconShield,
  IconUser,
} from '../components/Icons';
import { AuthShell } from '../components/AuthShell';

export function Login() {
  const { login, completeMfa } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  /* 两步验证：密码通过后后端给一枚临时凭据，用它 + 动态码换正式令牌 */
  const [mfaToken, setMfaToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  /* 顶部横幅：只放「不属于某个输入框」的错误（审批未通过、网络故障…） */
  const [error, setError] = useState<string | null>(null);
  /* 字段级错误：密码/验证码输错时标红对应的输入框，而不是只给一句笼统提示 */
  const [fieldErrors, setFieldErrors] = useState<{
    username?: string;
    password?: string;
    captcha?: string;
    mfa?: string;
  }>({});
  const [submitting, setSubmitting] = useState(false);

  /* 后端连接状态 */
  const health = useQuery({
    queryKey: ['health'],
    queryFn: healthApi.check,
    refetchInterval: 15_000,
    retry: false,
  });

  /*
    登录验证：管理员在「设置 → 登录验证」里三选一 —— 关闭 / 图形验证码 /
    拖动滑块。后端把 mode 一起返回，这里据此决定渲染什么。
    挑战是一次性的：每次登录失败都要 refetch 换一个（换图或换题）。
  */
  const captchaQ = useQuery({
    queryKey: ['login-captcha'],
    queryFn: authApi.captcha,
    refetchOnWindowFocus: false,
    /* 不能设成 Infinity：挑战是一次性的，上次会话里那份 id 早已作废。
       缓存留成「新鲜」的话，退出登录再进来会拿着旧挑战提交，
       第一次登录必然报「验证码错误」，用户得再点一次图才能登进去。 */
    staleTime: 0,
    retry: 1,
  });
  /* 老后端不返回 mode，只有 required —— 按图形验证码处理，行为与改造前一致 */
  const captchaMode = captchaQ.data?.mode ?? (captchaQ.data?.required ? 'image' : 'off');
  const captchaRequired = captchaMode !== 'off';

  /*
    滑块位置用 ref 承接：拖动过程中每移动 1px 都会回调一次，走 state 会把整个
    登录表单重渲染一遍。这里只在提交时读一次最终值。
    0 表示「尚未拖动」，也永远不会是正确答案（后端的目标 x 至少离左边半个拼图块）。
  */
  const sliderXRef = useRef(0);

  /* 拖动即视为「正在重新作答」，顺手清掉上一次的验证错误提示 */
  const handleSliderPosition = useCallback((x: number) => {
    sliderXRef.current = x;
    if (x > 0) {
      setFieldErrors((prev) => (prev.captcha ? { ...prev, captcha: undefined } : prev));
    }
  }, []);

  /* 输入变化时清除该字段与横幅的错误 */
  useEffect(() => {
    setFieldErrors((prev) =>
      prev.username ? { ...prev, username: undefined } : prev,
    );
    if (error) setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  useEffect(() => {
    setFieldErrors((prev) =>
      prev.password ? { ...prev, password: undefined } : prev,
    );
    if (error) setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password]);

  useEffect(() => {
    setFieldErrors((prev) =>
      prev.captcha ? { ...prev, captcha: undefined } : prev,
    );
    if (error) setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captchaCode]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    /* 本地校验：错误直接落到对应输入框下方 */
    const local: typeof fieldErrors = {};
    if (!username.trim()) local.username = '请输入用户名';
    if (!password) local.password = '请输入密码';
    const code = captchaCode.trim();
    if (captchaMode === 'image') {
      if (!code) local.captcha = '请输入验证码';
    } else if (captchaMode === 'slider') {
      /* 与后端同一个阈值：没拖到最右端就在本地拦一道，省掉一次必然失败的往返 */
      const max = (captchaQ.data?.width ?? 320) - (captchaQ.data?.handle_size ?? 56);
      if (sliderXRef.current < max - (captchaQ.data?.tolerance ?? 6)) {
        local.captcha = '请拖动滑块到最右端完成验证';
      }
    }
    if (local.username || local.password || local.captcha) {
      setFieldErrors(local);
      return;
    }

    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await login(
        username.trim(),
        password,
        captchaRequired
          ? {
              id: captchaQ.data?.id ?? '',
              code: captchaMode === 'image' ? code : undefined,
              x: captchaMode === 'slider' ? sliderXRef.current : undefined,
            }
          : undefined,
      );
      if (res.mfa_required) {
        // 口令对了，还差动态码：切到第二步，别把密码留在内存里
        setMfaToken(res.mfa_token ?? '');
        setPassword('');
        return;
      }
      // 该角色被要求必须开两步验证但还没绑定：先去个人中心绑定，否则处处 403
      navigate(res.totp_setup_required ? '/profile' : '/dashboard', {
        replace: true,
      });
    } catch (err) {
      const msg = errorMessage(err);
      /*
        后端把失败原因分得很细（验证码错 / 用户名或密码错 / 审批未过…），
        按消息归位到具体字段；归不进去的才走顶部横幅。
      */
      if (captchaRequired && /验证码|滑块/.test(msg)) {
        setFieldErrors({ captcha: msg });
      } else if (msg.includes('用户名或密码')) {
        setFieldErrors({ password: msg });
      } else {
        setError(msg);
      }
      // 挑战一次性：任何失败都换一张（或换一道题），顺带清掉上一次的作答
      if (captchaRequired) {
        setCaptchaCode('');
        sliderXRef.current = 0;
        void captchaQ.refetch();
      }
    } finally {
      setSubmitting(false);
    }
  };

  /* 第二步：动态码（或一次性恢复码）换正式令牌 */
  const handleVerifyMfa = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    const code = mfaCode.trim();
    if (!code) {
      setFieldErrors({ mfa: '请输入动态码或一次性恢复码' });
      return;
    }

    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await completeMfa(mfaToken, code);
      navigate(res.totp_setup_required ? '/profile' : '/dashboard', {
        replace: true,
      });
    } catch (err) {
      setFieldErrors({ mfa: errorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const backendUp = !health.isError;
  const pveConnected = health.data?.pve_connected ?? false;

  return (
    <AuthShell>
      <h1 className="login-title">
        {mfaToken ? '两步验证' : '登录控制台'}
      </h1>
      <p className="login-subtitle">
        {mfaToken
          ? '请输入认证器 App 里的动态码'
          : '请输入面板账号以继续'}
      </p>

      <form
        className="login-form"
        onSubmit={mfaToken ? handleVerifyMfa : handleSubmit}
        noValidate
      >
        {error ? (
          <div className="login-error" role="alert">
            <IconAlert size={16} />
            <span>{error}</span>
          </div>
        ) : null}
        {/* 字段级错误的无障碍播报：Input 内部已有 role=alert，这里补一句
            让读屏用户在提交后立刻听到「哪一项错了」 */}
        <div className="sr-only" role="alert">
          {[
            fieldErrors.username,
            fieldErrors.password,
            fieldErrors.captcha,
            fieldErrors.mfa,
          ]
            .filter(Boolean)
            .join('；')}
        </div>

        {mfaToken ? (
          <>
            <div className="login-error" style={{ background: 'var(--surface-2)' }}>
              <IconShield size={16} />
              <span>
                该账号已开启两步验证：请输入 6 位动态码。手机不在身边时，
                可以改用一张一次性恢复码（形如 ABCD-EFGH）。
              </span>
            </div>
            <Input
              label="动态码 / 恢复码"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              placeholder="123456"
              autoComplete="one-time-code"
              autoFocus
              disabled={submitting}
              maxLength={16}
              prefix={<IconShield size={15} />}
              error={fieldErrors.mfa}
              required
            />
            <button
              type="button"
              className="login-link-btn"
              onClick={() => {
                setMfaToken('');
                setMfaCode('');
                setFieldErrors({});
              }}
            >
              返回重新输入账号密码
            </button>
          </>
        ) : (
          <>
        <Input
          label="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="admin"
          autoComplete="username"
          autoFocus
          disabled={submitting}
          prefix={<IconUser size={15} />}
          error={fieldErrors.username}
          required
        />

        <Input
          label="密码"
          labelExtra={<Link to="/forgot-password">忘记密码？</Link>}
          type={showPassword ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          autoComplete="current-password"
          disabled={submitting}
          prefix={<IconKey size={15} />}
          error={fieldErrors.password}
          required
          suffix={
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? '隐藏密码' : '显示密码'}
              title={showPassword ? '隐藏密码' : '显示密码'}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                display: 'inline-flex',
                padding: 0,
              }}
            >
              {showPassword ? <IconEyeOff size={15} /> : <IconEye size={15} />}
            </button>
          }
        />

        {captchaMode === 'image' ? (
          <div className="login-captcha">
            <div className="login-captcha-input">
              <Input
                label="验证码"
                value={captchaCode}
                onChange={(e) => setCaptchaCode(e.target.value)}
                placeholder="看图输入"
                autoComplete="off"
                autoCapitalize="characters"
                disabled={submitting}
                maxLength={8}
                prefix={<IconShield size={15} />}
                error={fieldErrors.captcha}
                required
              />
            </div>
            <button
              type="button"
              className="login-captcha-img"
              onClick={() => {
                setCaptchaCode('');
                setFieldErrors((prev) => ({ ...prev, captcha: undefined }));
                void captchaQ.refetch();
              }}
              title="看不清？点击更换"
              aria-label="更换验证码"
            >
              {captchaQ.data?.image ? (
                <img src={captchaQ.data.image} alt="验证码" />
              ) : (
                <span>
                  {captchaQ.isFetching ? '加载中…' : '加载失败，点击重试'}
                </span>
              )}
            </button>
          </div>
        ) : captchaMode === 'slider' ? (
          <SliderCaptcha
            /* 首次拉取还没回来时先给一个空壳，组件内部会显示「加载中…」 */
            challenge={captchaQ.data ?? { required: true, mode: 'slider' }}
            onPosition={handleSliderPosition}
            onRefresh={() => {
              sliderXRef.current = 0;
              setFieldErrors((prev) => ({ ...prev, captcha: undefined }));
              void captchaQ.refetch();
            }}
            loading={captchaQ.isFetching}
            disabled={submitting}
            error={fieldErrors.captcha}
          />
        ) : null}
          </>
        )}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          loading={submitting}
        >
          {submitting ? '正在登录…' : mfaToken ? '验证并登录' : '登录'}
        </Button>

        {mfaToken ? null : (
          <div className="login-register-hint">
            还没有账号？
            <Link to="/register">注册申请</Link>
            后由管理员审批开通
          </div>
        )}
      </form>

      {/* ---- 后端状态 ---- */}
      <div className="login-health">
        <div className="login-health-row">
          <span className="login-health-label">后端服务</span>
          <Badge
            variant={backendUp ? 'success' : 'danger'}
            dot
            pulse={backendUp}
            size="sm"
          >
            {backendUp ? '正常' : '无法连接'}
          </Badge>
        </div>
        <div className="login-health-row">
          <span className="login-health-label">Proxmox VE</span>
          <Badge
            variant={pveConnected ? 'success' : 'warning'}
            dot
            pulse={pveConnected}
            size="sm"
          >
            {health.isLoading
              ? '检测中…'
              : pveConnected
                ? '已连接'
                : '未连接'}
          </Badge>
        </div>
        {health.data?.version ? (
          <div className="login-health-row">
            <span className="login-health-label">后端版本</span>
            <span className="mono fs-sm text-secondary">
              {health.data.version}
            </span>
          </div>
        ) : null}
        {!backendUp ? (
          <div className="fs-xs text-muted mt-8">
            提示：请确认后端服务已在 http://localhost:8080 启动。
          </div>
        ) : null}
      </div>
    </AuthShell>
  );
}
