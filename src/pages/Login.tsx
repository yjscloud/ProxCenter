/* ==========================================================================
   ProxCenter — 登录页
   ========================================================================== */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../hooks/useAuth';
import { useMaintenance } from '../hooks/useMaintenance';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
import { authApi, healthApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Button } from '../components/ui/Button';
import { Checkbox, Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { SliderCaptcha } from '../components/SliderCaptcha';
import type { SliderTracePoint } from '../api/types';
import {
  IconAlert,
  IconChevronLeft,
  IconEye,
  IconEyeOff,
  IconKey,
  IconShield,
  IconUser,
  IconWrench,
} from '../components/Icons';
import { AuthShell } from '../components/AuthShell';
import { useT } from '../i18n';

export function Login() {
  const { login, completeMfa } = useAuth();
  const t = useT();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  /* 两步验证：密码通过后后端给一枚临时凭据，用它 + 动态码换正式令牌 */
  const [mfaToken, setMfaToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  /* 「信任设备（7 天后重新校验）」。默认**不勾** —— 勾上等于把第二因子在这台
     浏览器上关掉 7 天，属于用户主动降低安全性的选择，不能替他默认选好。 */
  const [trustDevice, setTrustDevice] = useState(false);
  /* 面板是否允许信任设备（第一步由后端告知）。管理员关掉时整个勾选框不出现 ——
     勾了不生效比不给勾更让人困惑。 */
  const [trustAvailable, setTrustAvailable] = useState(false);
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
  /* 轮询间隔跟「设置 → 面板设置 → 数据刷新间隔」走（见 useRefreshInterval） */
  const refresh = useRefreshInterval();

  /* 后端连接状态。
     key 带 'public' 前缀：这里是**匿名**请求，后端只回 {"status":"ok"}（不含
     pve_configured，见 routers/config.health 的两档设计）。若与登录后的
     usePveStatus 共用 ['health']，登录瞬间会命中这份匿名缓存（全局 staleTime
     30 秒），把「还没配连接」误判成「已配置」—— 引导条与初始化跳转一起消失。 */
  const health = useQuery({
    queryKey: ['health', 'public'],
    queryFn: healthApi.check,
    refetchInterval: refresh,
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
    0 表示「尚未拖动」，也永远不会是正确答案（后端要求拖到轨道右端）。
  */
  const sliderXRef = useRef(0);

  /* 拖动轨迹（采样点 + 时间戳）：服务端据此判断「是不是人拖的」，
     只交 sliderXRef 一个坐标会被判失败（安全审计 H-1）。 */
  const sliderPathRef = useRef<SliderTracePoint[]>([]);

  /* 拖动即视为「正在重新作答」，顺手清掉上一次的验证错误提示 */
  const handleSliderPosition = useCallback((x: number, path: SliderTracePoint[]) => {
    sliderXRef.current = x;
    sliderPathRef.current = path;
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
    if (!username.trim()) local.username = t('auth.err.usernameRequired');
    if (!password) local.password = t('auth.err.passwordRequired');
    const code = captchaCode.trim();
    if (captchaMode === 'image') {
      if (!code) local.captcha = t('auth.err.captchaRequired');
    } else if (captchaMode === 'slider') {
      /* 目标位置只在轨道图里，前端无从判断「对齐了没有」—— 这里只拦「压根
         没拖」，其余交给服务端判定（它对不上会返回「请重新拖动滑块」）。 */
      if (sliderXRef.current <= 0) {
        local.captcha = t('auth.err.sliderRequired');
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
              path: captchaMode === 'slider' ? sliderPathRef.current : undefined,
            }
          : undefined,
      );
      if (res.mfa_required) {
        // 口令对了，还差动态码：切到第二步，别把密码留在内存里
        setMfaToken(res.mfa_token ?? '');
        setTrustAvailable(Boolean(res.trust_device_available));
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
      setFieldErrors({ mfa: t('auth.err.mfaRequired') });
      return;
    }

    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await completeMfa(mfaToken, code, trustDevice);
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

  /* 维护模式：先问一次公开接口，把「现在只允许管理员登录」说在前头 ——
     否则普通用户输完账号密码才收到拒绝，会以为是自己记错了密码。 */
  const maint = useMaintenance();


  return (
    <AuthShell>
      <h1 className="login-title">
        {mfaToken ? t('auth.mfa.title') : t('auth.login.title')}
      </h1>
      <p className="login-subtitle">
        {mfaToken
          ? t('auth.mfa.subtitle')
          : t('auth.login.subtitle')}
      </p>

      <form
        className="login-form"
        onSubmit={mfaToken ? handleVerifyMfa : handleSubmit}
        noValidate
      >
        {maint.data?.enabled ? (
          <div className="login-notice" role="status">
            <IconWrench size={16} />
            <span>
              {maint.data.message || t('auth.maintenanceBanner')}
            </span>
          </div>
        ) : null}
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
            <div className="login-notice">
              <IconShield size={16} />
              <span>{t('auth.mfa.notice')}</span>
            </div>
            <Input
              label={t('auth.mfa.code')}
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
            {/* 「信任设备」：勾上之后这台浏览器 7 天内只需口令即可登录。
                放在输入框下方、主按钮上方，与参考实现一致 —— 它是这次提交的
                一个附加选项，贴着要提交的内容，而不是另一个独立动作。
                说明文字刻意写出代价（「同一台浏览器」），不让人以为换个设备也免验。 */}
            {trustAvailable ? (
              <div className="login-trust">
                <Checkbox
                  checked={trustDevice}
                  disabled={submitting}
                  onChange={(e) => setTrustDevice(e.target.checked)}
                  label={t('auth.mfa.trustDevice', { days: 7 })}
                />
                <div className="fs-xs text-muted">{t('auth.mfa.trustDeviceHint')}</div>
              </div>
            ) : null}
          </>
        ) : (
          <>
        <Input
          label={t('auth.login.username')}
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
          label={t('auth.login.password')}
          labelExtra={<Link to="/forgot-password">{t('auth.login.forgot')}</Link>}
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
              aria-label={
                showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')
              }
              title={
                showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')
              }
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
                label={t('auth.login.captcha')}
                value={captchaCode}
                onChange={(e) => setCaptchaCode(e.target.value)}
                placeholder={t('auth.login.captchaPlaceholder')}
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
              title={t('auth.login.captchaRefresh')}
              aria-label={t('auth.login.captchaRefreshAria')}
            >
              {captchaQ.data?.image ? (
                <img src={captchaQ.data.image} alt={t('auth.login.captchaAlt')} />
              ) : (
                <span>
                  {captchaQ.isFetching
                    ? t('auth.login.captchaLoading')
                    : t('auth.login.captchaFailed')}
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
          {submitting
            ? t('auth.login.submitting')
            : mfaToken
              ? t('auth.mfa.verify')
              : t('auth.login.submit')}
        </Button>

        {/* 主按钮下方这一行，两步是两种「退路」：
              登录步骤 → 没有账号？去注册
              两步验证 → 返回重新输入账号密码
            两者位置相同、分量相同（都是文字链接），主线动作始终只有上方那颗主按钮。
            原先「返回」摆在动态码输入框和主按钮**之间**，还带着浏览器默认的
            整行灰底，读起来像是「填完这里再点一次」的第二步，主次完全颠倒。 */}
        {mfaToken ? (
          <button
            type="button"
            className="login-link-btn"
            disabled={submitting}
            onClick={() => {
              setMfaToken('');
              setMfaCode('');
              setFieldErrors({});
              /* 勾选也一并清掉：退回去多半是要换个账号登录，而「信任设备」
                 是替**当前这个账号**做的安全让步，不能顺延到下一个人。 */
              setTrustDevice(false);
              setTrustAvailable(false);
            }}
          >
            <IconChevronLeft size={14} />
            {t('auth.mfa.back')}
          </button>
        ) : (
          <div className="login-register-hint">
            {t('auth.login.noAccount')}
            <Link to="/register">{t('auth.login.registerLink')}</Link>
            {t('auth.login.registerSuffix')}
          </div>
        )}
      </form>

      {/* ---- 后端状态 ----
          匿名访问时 /api/health 只回 {"status":"ok"}：PVE 连接状态、版本、
          节点数属于内网指纹，未登录不该看到（见后端 routers/config.py）。
          所以这里只保留「面板服务是否可达」这一条。 */}
      <div className="login-health">
        <div className="login-health-row">
          <span className="login-health-label">{t('auth.health.backend')}</span>
          <Badge
            variant={backendUp ? 'success' : 'danger'}
            dot
            pulse={backendUp}
            size="sm"
          >
            {backendUp ? t('auth.health.up') : t('auth.health.down')}
          </Badge>
        </div>
        {!backendUp ? (
          <div className="fs-xs text-muted mt-8">{t('auth.health.hint')}</div>
        ) : null}
      </div>
    </AuthShell>
  );
}
