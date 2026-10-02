"""Authentication endpoints."""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .. import captcha, crypto, i18n, mailer, panel_url, password_reset, prefs, security, store, throttle, totp
from ..config import settings
from ..schemas import (
    ForgotPasswordIn,
    LoginMfaRequest,
    LoginRequest,
    LoginResponse,
    PasswordChange,
    ProfileUpdate,
    RegisterRequest,
    ResetPasswordIn,
    ResetTokenIn,
    StepUpRequest,
    TotpCodeIn,
    TotpDisableIn,
    UserOut,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# 注册 / 找回密码都是公开的匿名入口，放开手会被脚本拿来做 CPU 放大（注册要跑
# bcrypt）或刷邮件（SMTP 配额有限）。限速计数落 MySQL（throttle.py），重启不清零。
_LIMIT_WINDOW = 3600


async def _anon_throttled(kind: str, ip: str, limit: int) -> bool:
    """匿名入口的 IP 限速：窗口内超过 ``limit`` 次即拒。"""
    allowed, _ = await throttle.allow(f"{kind}:ip:{ip or 'unknown'}", limit, _LIMIT_WINDOW)
    return not allowed


async def _login_guard(username: str, ip: str) -> None:
    """锁定期内直接拒绝，连 bcrypt 都不跑。"""
    locked = await throttle.login_locked(username, ip)
    if locked:
        await store.add_audit(
            username=username,
            action="auth.login",
            result="failed",
            detail=f"账号或来源 IP 处于锁定状态，剩余 {locked} 秒",
            ip=ip,
        )
        raise HTTPException(
            status_code=429,
            detail=(
                f"登录失败次数过多，已临时锁定，请 {max(1, locked // 60)} 分钟后再试"
            ),
            headers={"Retry-After": str(locked)},
        )


async def _login_count_failure(username: str, ip: str, detail: str) -> None:
    """记一次失败；刚好触发锁定时，审计里留下明确一条。"""
    locked = await throttle.login_failed(username, ip)
    await store.add_audit(
        username=username,
        action="auth.login",
        result="failed",
        detail=detail,
        ip=ip,
    )
    if locked:
        await store.add_audit(
            username=username,
            action="auth.login_lockout",
            target=username,
            result="failed",
            detail=(
                f"连续失败达到 {settings.login_max_failures} 次，"
                f"锁定 {settings.login_lockout_minutes} 分钟（来源 IP：{ip}）"
            ),
            ip=ip,
        )


async def _issue_session(
    response: Response,
    user: Dict[str, Any],
    request: Request,
) -> str:
    """签发 access token + refresh cookie，并登记一台设备（一个 jti）。

    返回 access token；``refresh_tokens`` 表里的那一行就是「已登录设备」，
    撤销它（或把 token_version +1）即可把这次登录踢下线。
    """
    version = int(user.get("token_version", 0) or 0)
    # 先建会话拿到 jti，再把它写进 access token 的 sid —— 这样撤销会话就等于
    # 撤销这枚 access token，登出/踢设备立刻生效。
    refresh, jti, expires_at = security.create_refresh_token(user["username"], version)
    await store.register_refresh_token(
        jti,
        user["username"],
        expires_at,
        ip=security.client_ip(request),
        user_agent=request.headers.get("user-agent", ""),
    )
    access = security.create_access_token(
        user["username"], user["role"], version, session_id=jti
    )
    security.set_session_cookies(response, access, refresh)
    return access


def _requires_totp_setup(user: Dict[str, Any]) -> bool:
    """该用户被强制要求开 2FA，但还没绑定。"""
    return (
        not user.get("totp_enabled")
        and str(user.get("role") or "") in settings.totp_required_role_list
    )


def _user_out(user: Dict[str, Any]) -> UserOut:
    return UserOut(
        id=user.get("id"),
        username=user["username"],
        role=user["role"],
        email=user.get("email", "") or "",
        enabled=bool(user.get("enabled", True)),
        status=user.get("status", store.STATUS_ACTIVE),
        permissions=security.effective_permissions(user),
        totp_enabled=bool(user.get("totp_enabled")),
    )


def _password_weak_reason(password: str) -> Optional[str]:
    """注册 / 改密 / 重置 / 管理员建号共用同一套强度规则。

    规则本体在 :func:`security.password_policy_error`（长度、字母 + 数字、
    常见弱口令），这里只做「返回原因而不是抛异常」的适配。
    """
    return security.password_policy_error(password) or None


async def _panel_url(request: Request) -> str:
    """面板自身地址，用来在邮件里给出可点的登录链接。

    优先用管理员在「设置 → 面板全局地址」里配置的对外域名
    （如 ``https://prox.yjscloud.com``）；未配置时才回落到本次请求的
    base_url —— 走反向代理时它常是 ``localhost``，收件人打不开。
    """
    return await panel_url.resolve(request)


async def _notify_admins_registration(
    username: str, email: str, ip: str, request: Request
) -> str:
    """把新注册申请邮件通知管理员。

    返回一句可供审计的中文说明。**邮件不是关键路径**：没配置或发失败都只
    记录原因，绝不让注册本身失败 —— 否则邮件服务器不可达就会导致没人能注册。
    """
    cfg = await mailer.load_mail()
    if not mailer.is_configured(cfg):
        return "邮件通知未配置，已跳过"
    subject, text, html = mailer.registration_mail(
        username, email, ip, await _panel_url(request)
    )
    ok, detail = await mailer.send_to_admins(subject, text, html=html)
    return detail if ok else f"通知管理员失败：{detail}"


@router.get("/captcha")
async def get_captcha() -> Dict[str, Any]:
    """登录页验证。三种方式：关闭 / 图形验证码 / 拖动滑块。

    ``mode`` 一并返回，前端据此决定渲染输入框、滑块还是什么都不渲染 ——
    拿到挑战再回头问一次「这是什么模式」会让登录页多一次往返。
    关闭时只有 ``{"required": false, "mode": "off"}``。
    """
    mode = await captcha.get_mode()
    if mode == captcha.MODE_OFF:
        return {"required": False, "mode": mode}
    if mode == captcha.MODE_SLIDER:
        return {"required": True, "mode": mode, **captcha.issue_slider()}
    return {"required": True, "mode": captcha.MODE_IMAGE, **captcha.issue()}


@router.post("/login", response_model=LoginResponse)
async def login(
    payload: LoginRequest, request: Request, response: Response
) -> LoginResponse:
    ip = security.client_ip(request)

    # 锁定检查放在最前面：被锁就直接拒，不再跑验证码与 bcrypt（这两个都不便宜），
    # 也不会再给爆破脚本任何反馈。
    await _login_guard(payload.username, ip)

    # 验证码放在校验密码之前：画图与比对都便宜，bcrypt 才贵——
    # 脚本摸不到「密码对不对」的信号，就得先老老实实解验证码。
    #
    # 验证码没过**不**计入失败次数：否则拿一张错图（或一个错误位置）反复提交
    # 就能把任意账号锁死（拿别人的用户名做拒绝服务）。计数只认「口令不对」。
    mode = await captcha.get_mode()
    if mode != captcha.MODE_OFF:
        if mode == captcha.MODE_SLIDER:
            passed = captcha.verify_slider(payload.captcha_id, payload.captcha_x)
            detail = "验证失败，请重新拖动滑块"
        else:
            passed = captcha.verify(payload.captcha_id, payload.captcha_code)
            detail = "验证码错误或已过期，请点击图片更换"
        if not passed:
            await store.add_audit(
                username=payload.username,
                action="auth.login",
                result="failed",
                # 写成人话（「图形验证码未通过」/「拖动滑块未通过」）：
                # 审计日志是给人看的，写 image/slider 还得回头翻代码。
                detail=f"{captcha.MODE_LABEL.get(mode, mode)}未通过",
                ip=ip,
            )
            raise HTTPException(status_code=400, detail=detail)

    user = await store.get_user(payload.username)

    # Uniform error message so the response cannot be used to enumerate users.
    if not user or not security.verify_password(payload.password, user["password_hash"]):
        await _login_count_failure(payload.username, ip, "用户名或密码错误")
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    # 注册审批：密码是对的，但还没被管理员放行。这两种情况分开提示，
    # 否则用户只会以为是密码错了，反复重试。
    status = user.get("status", store.STATUS_ACTIVE)
    if status != store.STATUS_ACTIVE:
        pending = status == store.STATUS_PENDING
        detail = (
            "账号正在等待管理员审批"
            if pending
            else "注册申请未通过，请联系管理员"
        )
        await store.add_audit(
            username=payload.username,
            action="auth.login",
            result="failed",
            detail=detail,
            ip=security.client_ip(request),
        )
        raise HTTPException(
            status_code=403,
            detail=(
                "账号正在等待管理员审批，通过后即可登录"
                if pending
                else "注册申请未通过审批，请联系管理员"
            ),
        )

    if not user.get("enabled", True):
        await store.add_audit(
            username=payload.username,
            action="auth.login",
            result="failed",
            detail="账号已被禁用",
            ip=security.client_ip(request),
        )
        raise HTTPException(status_code=403, detail="账号已被禁用，请联系管理员")

    # 两步验证：口令对了，但还不算登录成功 —— 先发一枚只能走完这次验证的
    # 临时凭据，避免把 access token 直接交给只掌握了密码的一方。
    if user.get("totp_enabled"):
        version = int(user.get("token_version", 0) or 0)
        await store.add_audit(
            username=user["username"],
            action="auth.login",
            result="mfa_required",
            detail="密码校验通过，等待两步验证",
            ip=ip,
        )
        return LoginResponse(
            mfa_required=True,
            mfa_token=security.create_mfa_token(user["username"], version),
        )

    # 登录成功：清掉失败计数（账号与 IP 两个维度），再签发会话
    await throttle.clear_login_failures(payload.username, ip)
    access = await _issue_session(response, user, request)

    await store.add_audit(
        username=user["username"],
        action="auth.login",
        result="success",
        ip=ip,
    )

    return LoginResponse(
        access_token=access,
        token_type="bearer",
        user=_user_out(user),
        totp_setup_required=_requires_totp_setup(user),
    )


@router.post("/login/2fa", response_model=LoginResponse)
async def login_mfa(
    payload: LoginMfaRequest, request: Request, response: Response
) -> LoginResponse:
    """登录第二步：动态码或一次性恢复码换正式令牌。

    动态码同样会被爆破（6 位数字），所以复用登录失败计数与锁定：这里错了
    一样会累计、一样会锁。
    """
    ip = security.client_ip(request)
    mfa = security.decode_token(payload.mfa_token, expected_typ="mfa")
    username = str(mfa.get("sub") or "")
    if not username:
        raise HTTPException(status_code=401, detail="验证已失效，请重新登录")

    await _login_guard(username, ip)

    user = await store.get_user(username)
    if not user or not user.get("totp_enabled"):
        raise HTTPException(
            status_code=401, detail="验证已失效，请重新登录"
        )
    if int(mfa.get("ver", 0)) != int(user.get("token_version", 0) or 0):
        raise HTTPException(status_code=401, detail="登录状态已失效，请重新登录")
    if user.get("status", store.STATUS_ACTIVE) != store.STATUS_ACTIVE:
        raise HTTPException(status_code=403, detail="账号未通过管理员审批")
    if not user.get("enabled", True):
        raise HTTPException(status_code=403, detail="账号已被禁用，请联系管理员")

    ok, used_recovery = await totp.verify_login_code(user, payload.code)
    if not ok:
        await _login_count_failure(username, ip, "两步验证码错误")
        raise HTTPException(
            status_code=401, detail="验证码不正确，请重新获取后再试"
        )

    await throttle.clear_login_failures(username, ip)
    access = await _issue_session(response, user, request)
    await store.add_audit(
        username=username,
        action="auth.login",
        result="success",
        detail="两步验证通过" + ("（使用了恢复码）" if used_recovery else ""),
        ip=ip,
    )
    return LoginResponse(access_token=access, token_type="bearer", user=_user_out(user))


@router.post("/refresh", response_model=LoginResponse)
async def refresh_session(request: Request, response: Response) -> LoginResponse:
    """用 HttpOnly 里的 refresh token 换一枚新的 access token。

    每次刷新都**轮换** refresh token（旧 jti 立刻作废）：一枚被偷走的 refresh
    token 只能用一次，之后要么失效、要么被服务端发现。
    """
    token = request.cookies.get(security.REFRESH_COOKIE, "")
    if not token:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")

    payload = security.decode_token(token, expected_typ="refresh")
    jti = str(payload.get("jti") or "")
    record = await store.get_refresh_token(jti)
    if not record:
        security.clear_session_cookies(response)
        raise HTTPException(status_code=401, detail="登录状态已失效，请重新登录")

    username = str(payload.get("sub") or "")
    user = await store.get_user(username)
    if not user or not user.get("enabled", True):
        await store.revoke_refresh_token(jti)
        security.clear_session_cookies(response)
        raise HTTPException(status_code=401, detail="登录状态已失效，请重新登录")
    if user.get("status", store.STATUS_ACTIVE) != store.STATUS_ACTIVE:
        await store.revoke_refresh_token(jti)
        security.clear_session_cookies(response)
        raise HTTPException(status_code=403, detail="账号未通过管理员审批")
    if int(payload.get("ver", 0)) != int(user.get("token_version", 0) or 0):
        await store.revoke_refresh_token(jti)
        security.clear_session_cookies(response)
        raise HTTPException(status_code=401, detail="登录状态已失效，请重新登录")

    await store.revoke_refresh_token(jti)
    access = await _issue_session(response, user, request)
    return LoginResponse(
        access_token=access,
        token_type="bearer",
        user=_user_out(user),
        totp_setup_required=_requires_totp_setup(user),
    )


@router.post("/register", status_code=201)
async def register(payload: RegisterRequest, request: Request) -> Dict[str, Any]:
    """自助注册（公开接口，无需登录）。

    建出来的账号状态恒为 ``pending``：能登录的前提是管理员审批通过。
    角色先给 viewer，真正的角色与权限由管理员在审批时决定。

    注意这里**不返回任何账号信息**，也不在响应里区分「已存在」的具体状态，
    只说用户名被占用 —— 与登录接口的防枚举口径保持一致。
    """
    ip = security.client_ip(request)
    if await _anon_throttled("register", ip, 5):
        await store.add_audit(
            username=payload.username,
            action="auth.register",
            target=payload.username,
            result="failed",
            detail="提交过于频繁，已被限速",
            ip=ip,
        )
        raise HTTPException(
            status_code=429, detail="提交过于频繁，请稍后再试"
        )

    username = payload.username.strip()
    email = (payload.email or "").strip()

    weak = _password_weak_reason(payload.password)
    if weak:
        raise HTTPException(status_code=400, detail=weak)
    # 邮箱必填：审批结果要发到这里
    if not email:
        raise HTTPException(
            status_code=400, detail="请填写邮箱，审批结果会发送到该邮箱"
        )
    if "@" not in email:
        raise HTTPException(status_code=400, detail="邮箱格式不正确")
    if len(email) > 255:
        raise HTTPException(status_code=400, detail="邮箱长度不能超过 255 个字符")

    # 已存在（无论什么状态）都按「被占用」处理，不透露这个账号的状态
    if await store.get_user(username):
        await store.add_audit(
            username=username,
            action="auth.register",
            target=username,
            result="failed",
            detail="用户名已被占用",
            ip=ip,
        )
        raise HTTPException(status_code=409, detail="该用户名已被占用或正在审批中")

    await store.create_user(
        username,
        payload.password,
        role="viewer",
        email=email,
        status=store.STATUS_PENDING,
    )

    # 通知管理员。发信失败只记进审计，不影响注册结果。
    mail_note = await _notify_admins_registration(username, email, ip, request)

    # 注册是匿名行为，actor 与 target 都是这个新账号本身；
    # 审批队列靠这条记录回溯「谁在什么时候申请过」。
    await store.add_audit(
        username=username,
        action="auth.register",
        target=username,
        result="success",
        detail={
            "email": email,
            "status": store.STATUS_PENDING,
            "mail": mail_note,
        },
        ip=ip,
    )
    return {
        "ok": True,
        "status": store.STATUS_PENDING,
        "message": "注册申请已提交，等待管理员审批",
    }


# ------------------------------------------------------------ 自助重置密码
@router.post("/forgot-password")
async def forgot_password(
    payload: ForgotPasswordIn, request: Request
) -> Dict[str, Any]:
    """自助重置第 1 步：给账号邮箱发一条一次性链接。

    **无论账号是否存在、邮箱填没填，都返回同一句话**。这是公开接口，
    一旦它对「用户名不存在」给出不同响应，就等于提供了一台账号枚举机。
    """
    ip = security.client_ip(request)
    username = (payload.username or "").strip()

    if await _anon_throttled("reset", ip, 5):
        raise HTTPException(status_code=429, detail="提交过于频繁，请稍后再试")

    generic = {
        "ok": True,
        "message": "如果该账号存在且已填写邮箱，重置链接已发送，30 分钟内有效",
    }
    if not username:
        # 空用户名不值得查库，但同样返回通用话术
        return generic

    issued = await password_reset.issue(username)
    if not issued:
        token = None
    else:
        token, to_email = issued
    if not token:
        await store.add_audit(
            username=username,
            action="auth.password_reset.request",
            target=username,
            result="failed",
            detail="账号不存在、未激活或没有可用邮箱",
            ip=ip,
        )
        return generic

    url = f"{await _panel_url(request)}/reset-password?token={token}"
    # 重置邮件按**收件人**的语言渲染，而不是当前请求的语言 —— 两者可能不同：
    # 用户可能在另一台设备上刚切换过语言，或由管理员代触发。
    lang = await prefs.get(username, prefs.PREF_LANGUAGE, i18n.DEFAULT_LANG)
    with i18n.use_language(lang):
        subject, body, html = mailer.password_reset_mail(username, url)
    # 收件人是账号邮箱，不是用户名；用户名投给 SMTP 只会 501 Bad address syntax
    ok, detail = await mailer.send_mail(to_email, subject, body, html=html)

    await store.add_audit(
        username=username,
        action="auth.password_reset.request",
        target=username,
        result="success" if ok else "failed",
        detail=detail,
        ip=ip,
    )
    if not ok:
        # 邮件发不出去是面板配置问题，与账号是否存在无关，可以直说
        raise HTTPException(
            status_code=503,
            detail=f"邮件发送失败：{detail}。请确认「邮件通知」已配置，或联系管理员重置密码。",
        )
    return generic


@router.post("/reset-password/check")
async def check_reset_token(payload: ResetTokenIn) -> Dict[str, Any]:
    """打开重置页面时先确认链接还有效（不消耗令牌）。"""
    username = await password_reset.peek(payload.token or "")
    return {"valid": username is not None, "username": username or ""}


@router.post("/reset-password")
async def reset_password(
    payload: ResetPasswordIn, request: Request
) -> Dict[str, Any]:
    """自助重置第 2 步：凭令牌设置新密码。令牌一次性，用完即废。"""
    ip = security.client_ip(request)

    weak = _password_weak_reason(payload.password)
    if weak:
        raise HTTPException(status_code=400, detail=weak)

    username = await password_reset.redeem(payload.token or "")
    if not username:
        raise HTTPException(
            status_code=400, detail="重置链接无效或已过期，请重新申请"
        )

    updated = await store.update_user(username, password=payload.password)
    if not updated:
        raise HTTPException(status_code=404, detail="账号不存在")

    # 密码已经改了，该账号邮箱里可能还有几条旧链接，一并作废
    await password_reset.purge_user(username)

    # 重置密码往往是「账号可能已被盗」的应对手段：把已经登录的设备全部踢下线
    # 才有意义，否则攻击者手里的旧 token 还能继续用满 12 小时。API Token 也
    # 一并吊销 —— 它可能永不过期，漏掉它等于没做补救。
    revoked = await security.revoke_user_credentials(username)

    await store.add_audit(
        username=username,
        action="auth.password_reset",
        target=username,
        result="success",
        detail={
            "note": "自助重置密码成功",
            "sessions_revoked": revoked["sessions"],
            "api_tokens_revoked": revoked["api_tokens"],
        },
        ip=ip,
    )
    return {"ok": True, "username": username, "message": "密码已重置，请重新登录"}


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, str]:
    """真正的登出：撤销这次登录对应的**服务端会话**。

    只清前端 localStorage 是不够的 —— 那一枚 token 在服务端仍然有效，谁拿到
    （日志、代理、共享电脑）都还能继续用。这里撤销会话记录（sid），于是：

    * refresh token 再也换不出新令牌；
    * 这枚 access token 下一次请求就被拒（认证依赖会核对会话是否有效），
      不必等它自然过期，也不需要额外的黑名单表。
    """
    # 会话 ID 优先用认证时解析出来的那个（access token 里的 sid）：无论请求是
    # Cookie 还是 Authorization 来的，都能准确定位「本次登录」，不会出现
    # 「cookie 里没有 refresh 就撤不掉会话」的漏网。
    session = str(getattr(request.state, "session_id", "") or "")
    if not session:
        token = request.cookies.get(security.REFRESH_COOKIE, "")
        if token:
            try:
                payload = security.decode_token(token, expected_typ="refresh")
                if str(payload.get("sub") or "") == user["username"]:
                    session = str(payload.get("jti") or "")
            except HTTPException:
                # cookie 已过期/损坏：照样把它清掉，不算登出失败
                session = ""

    if session:
        await store.revoke_refresh_token(session)

    # 三枚 cookie 一起清：access 不清的话浏览器还会继续带着它，直到过期
    security.clear_session_cookies(response)
    await security.audit(request, user, "auth.logout", detail={"session": session})
    return {"message": "已退出登录"}


@router.post("/logout-all")
async def logout_all(
    request: Request,
    response: Response,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """退出所有设备：撤销全部会话、吊销全部 API Token，并把会话版本 +1。

    会话版本一变，所有已经发出去的 access token（包括当前这枚）立刻失效，
    所以前端拿到这个响应后应当回到登录页。

    这里连 API Token 一起吊销：用户点这个按钮的心智是「把我在外面的东西全
    停掉」（丢了电脑、怀疑泄漏），留一类长期凭据活着不符合预期。令牌是自助
    管理的，需要时重新签发即可。
    """
    revoked = await security.revoke_user_credentials(user["username"])
    security.clear_session_cookies(response)
    await security.audit(
        request,
        user,
        "auth.logout_all",
        detail={
            "sessions_revoked": revoked["sessions"],
            "api_tokens_revoked": revoked["api_tokens"],
        },
    )
    return {
        "message": "已退出所有设备",
        "sessions_revoked": revoked["sessions"],
        "api_tokens_revoked": revoked["api_tokens"],
        "token_version": revoked["token_version"],
    }


@router.get("/sessions")
async def list_sessions(
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """当前账号仍然有效的登录设备（个人中心展示 + 逐个踢下线）。"""
    rows = await store.list_refresh_tokens(user["username"])
    current = ""
    token = request.cookies.get(security.REFRESH_COOKIE, "")
    if token:
        try:
            current = str(
                security.decode_token(token, expected_typ="refresh").get("jti") or ""
            )
        except HTTPException:
            current = ""
    return {
        "sessions": [
            {
                "id": r.get("jti"),
                "created": r.get("created"),
                "expires_at": r.get("expires_at"),
                "ip": r.get("ip", ""),
                "user_agent": r.get("user_agent", ""),
                "current": r.get("jti") == current,
            }
            for r in rows
        ]
    }


@router.delete("/sessions/{jti}")
async def revoke_session(
    jti: str,
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """踢掉自己的一台设备（只允许操作自己的会话）。"""
    record = await store.get_refresh_token(jti)
    if not record or record.get("username") != user["username"]:
        raise HTTPException(status_code=404, detail="会话不存在或已失效")
    await store.revoke_refresh_token(jti)
    await security.audit(request, user, "auth.session_revoke", target=jti)
    return {"ok": True, "message": "该设备已被退出登录"}


# ------------------------------------------------------------ 两步验证（TOTP）
@router.get("/2fa")
async def totp_status(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """两步验证状态：是否开启、是否被强制、还剩几张恢复码。"""
    record = await store.get_user(user["username"]) or {}
    return {
        "enabled": bool(record.get("totp_enabled")),
        "required": str(user.get("role") or "") in settings.totp_required_role_list,
        "recovery_codes_left": totp.remaining_recovery_codes(
            str(record.get("totp_recovery") or "")
        ),
    }


@router.post("/2fa/setup")
async def totp_setup(
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """生成一枚新种子（此时**还没启用**，要再用动态码确认一次）。

    种子用 crypto 加密后落库；返回里的明文只走这一次响应，前端扫完码就丢。
    """
    record = await store.get_user(user["username"])
    if not record:
        raise HTTPException(status_code=404, detail="用户不存在")
    if record.get("totp_enabled"):
        raise HTTPException(
            status_code=400, detail="两步验证已开启；如需更换认证器请先关闭再重新绑定"
        )

    secret = totp.generate_secret()
    await store.set_totp(
        user["username"], secret=crypto.encrypt(secret), enabled=False, recovery="[]"
    )
    uri = totp.provisioning_uri(secret, user["username"])
    await security.audit(request, user, "auth.totp_setup")
    return {
        "secret": secret,
        "otpauth_url": uri,
        "qr_png": totp.qr_png_data_uri(uri),
        "message": "请用认证器 App 扫码，然后输入当前动态码完成绑定",
    }


@router.post("/2fa/enable")
async def totp_enable(
    payload: TotpCodeIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """用一次动态码确认绑定成功，并下发一次性恢复码（只显示这一次）。"""
    record = await store.get_user(user["username"]) or {}
    if not record.get("totp_secret"):
        raise HTTPException(status_code=400, detail="请先生成两步验证密钥")
    if not totp.verify_code(str(record.get("totp_secret") or ""), payload.code):
        await security.audit(
            request, user, "auth.totp_enable", result="failed", detail="动态码不正确"
        )
        raise HTTPException(
            status_code=400,
            detail="动态码不正确，请确认手机时间与服务器同步后重试",
        )

    codes = totp.new_recovery_codes()
    await store.set_totp(
        user["username"], enabled=True, recovery=totp.hash_recovery_codes(codes)
    )
    await security.audit(request, user, "auth.totp_enable")
    return {
        "ok": True,
        "recovery_codes": codes,
        "message": "两步验证已开启，请把恢复码保存在安全的地方（只显示这一次）",
    }


@router.post("/2fa/disable")
async def totp_disable(
    payload: TotpDisableIn,
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """关闭两步验证：口令 + 动态码双确认。

    只有一枚被盗的 access token 关不掉它，光知道密码也关不掉它 —— 否则
    「2FA 开启」在攻击者拿到 token 之后形同虚设。
    """
    record = await store.get_user(user["username"]) or {}
    if not record.get("totp_enabled"):
        raise HTTPException(status_code=400, detail="两步验证尚未开启")
    if str(user.get("role") or "") in settings.totp_required_role_list:
        raise HTTPException(
            status_code=403, detail="该角色被强制要求开启两步验证，无法关闭"
        )
    if not security.verify_password(
        payload.password, str(record.get("password_hash") or "")
    ):
        await security.audit(
            request, user, "auth.totp_disable", result="failed", detail="口令不正确"
        )
        raise HTTPException(status_code=400, detail="当前密码不正确")
    if not payload.code:
        raise HTTPException(status_code=400, detail="请输入当前动态码或一张恢复码")

    ok, _ = await totp.verify_login_code(record, payload.code)
    if not ok:
        await security.audit(
            request, user, "auth.totp_disable", result="failed", detail="动态码不正确"
        )
        raise HTTPException(status_code=400, detail="动态码不正确")

    await store.set_totp(user["username"], secret="", enabled=False, recovery="[]")
    await security.audit(request, user, "auth.totp_disable")
    return {"ok": True, "message": "两步验证已关闭"}


@router.post("/step-up")
async def step_up(
    payload: StepUpRequest,
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """敏感操作（删虚拟机、改连接凭据、增删账号…）前的二次确认。

    只验证密码还不够保险（密码可能和 token 一起泄露），开了两步验证的账号
    这里同样要求动态码或一张恢复码。通过后在**当前会话**上盖一个短时效的章
    （refresh_tokens.elevated_until），窗口内重复做敏感操作不必反复输入；
    换设备 / 换会话都要重新确认。
    """
    session_id = str(getattr(request.state, "session_id", "") or "")
    if not session_id:
        # 旧版本签发的令牌没有会话记录，无处盖章：请重新登录拿一份新会话
        raise HTTPException(status_code=401, detail="登录状态已失效，请重新登录")

    ip = security.client_ip(request)
    if await _anon_throttled("step-up", ip, 20):
        raise HTTPException(status_code=429, detail="提交过于频繁，请稍后再试")

    record = await store.get_user(user["username"]) or {}
    if not security.verify_password(
        payload.password, str(record.get("password_hash") or "")
    ):
        await _login_count_failure(user["username"], ip, "二次确认密码错误")
        await security.audit(
            request, user, "auth.step_up", result="failed", detail="密码不正确"
        )
        raise HTTPException(status_code=400, detail="密码不正确")

    if record.get("totp_enabled"):
        code = (payload.totp_code or "").strip()
        if not code:
            raise HTTPException(status_code=400, detail="请输入两步验证动态码")
        ok, _ = await totp.verify_login_code(record, code)
        if not ok:
            await _login_count_failure(user["username"], ip, "二次确认动态码错误")
            await security.audit(
                request, user, "auth.step_up", result="failed", detail="动态码不正确"
            )
            raise HTTPException(status_code=400, detail="动态码不正确")

    window = int(settings.step_up_window_minutes)
    until = await store.mark_session_elevated(session_id, window * 60)
    await security.audit(
        request, user, "auth.step_up", target=user["username"], detail={"minutes": window}
    )
    return {
        "ok": True,
        "expires_in": window * 60,
        "expires_at": until,
        "message": f"已确认身份，{window} 分钟内无需重复验证",
    }


@router.get("/me", response_model=UserOut)
async def me(user: Dict[str, Any] = Depends(security.get_current_user)) -> UserOut:
    return UserOut(
        id=user.get("id"),
        username=user["username"],
        role=user["role"],
        email=user.get("email", ""),
        enabled=user.get("enabled", True),
        permissions=user.get("permissions", []),
        totp_enabled=bool(user.get("totp_enabled")),
    )


@router.put("/me", response_model=UserOut)
async def update_me(
    payload: ProfileUpdate,
    request: Request,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> UserOut:
    """更新当前登录用户自己的个人信息。

    只允许改邮箱：用户名是登录凭据、角色与启用状态属于管理员职责，
    这里一律以 token 中的身份为准，不接受请求体里的任何提权字段。
    """
    email = (payload.email or "").strip()
    if len(email) > 255:
        raise HTTPException(status_code=400, detail="邮箱长度不能超过 255 个字符")
    if email and "@" not in email:
        raise HTTPException(status_code=400, detail="邮箱格式不正确")

    updated = await store.update_user(user["username"], email=email) or {}
    await security.audit(
        request,
        user,
        "auth.profile_update",
        target=user["username"],
        detail={"email": email},
    )
    return _user_out(updated)


@router.post("/password")
async def change_password(
    payload: PasswordChange,
    request: Request,
    response: Response,
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """修改当前登录用户自己的密码（需校验当前密码，开了 2FA 还要动态码）。

    改完密码会把**其它设备**全部踢下线（撤销会话 + 会话版本 +1），当前这次
    请求换一份新令牌继续用 —— 「密码可能泄露了」的第一反应就是改密码，那么
    旧 token 不能还留着。
    """
    record = await store.get_user(user["username"])
    if not record:
        raise HTTPException(status_code=404, detail="用户不存在")

    if not security.verify_password(payload.current_password, record["password_hash"]):
        await security.audit(
            request,
            user,
            "auth.password_change",
            target=user["username"],
            result="failed",
            detail="当前密码不正确",
        )
        raise HTTPException(status_code=400, detail="当前密码不正确")

    # 两步验证：改密码属于敏感操作，即使 token 被盗也不能单靠密码完成
    if record.get("totp_enabled"):
        if not payload.totp_code:
            raise HTTPException(status_code=400, detail="请输入两步验证动态码")
        ok, _ = await totp.verify_login_code(record, payload.totp_code)
        if not ok:
            await security.audit(
                request,
                user,
                "auth.password_change",
                target=user["username"],
                result="failed",
                detail="两步验证码不正确",
            )
            raise HTTPException(status_code=400, detail="两步验证码不正确")

    if payload.new_password == payload.current_password:
        raise HTTPException(status_code=400, detail="新密码不能与当前密码相同")

    weak = _password_weak_reason(payload.new_password)
    if weak:
        raise HTTPException(status_code=400, detail=weak)

    await store.update_user(user["username"], password=payload.new_password)
    # 旧凭据一律作废（含已签发的 API Token，它们可能永不过期）；本次请求重新
    # 签发一份会话，用户不必立刻重登。
    revoked = await security.revoke_user_credentials(user["username"])
    fresh = await store.get_user(user["username"]) or record
    access = await _issue_session(response, fresh, request)

    await security.audit(
        request,
        user,
        "auth.password_change",
        target=user["username"],
        detail={
            "sessions_revoked": revoked["sessions"],
            "api_tokens_revoked": revoked["api_tokens"],
        },
    )
    return {
        "ok": True,
        "message": "密码已更新，其它设备已退出登录",
        "access_token": access,
        "other_sessions_revoked": revoked["sessions"],
        "api_tokens_revoked": revoked["api_tokens"],
    }


@router.get("/my-permissions")
async def my_permissions(
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """当前用户自己的角色与生效权限（含中文名，供「个人中心」只读展示）。

    普通用户没有 users.view，拿不到 /api/roles 与 /api/permissions/catalog，
    所以这里由服务端把权限 key 翻译成可读标签，只返回自己的那一份。
    """
    admin = security.is_admin(user)
    granted = set(user.get("permissions") or [])
    role_id = str(user.get("role") or "")
    role = await store.get_role(role_id) or {}

    groups = []
    for group in i18n.localize_permission_catalog(security.PERMISSION_CATALOG):
        items = [
            {
                "key": item["key"],
                "label": item.get("label", item["key"]),
                "desc": item.get("desc", ""),
            }
            for item in group.get("permissions", [])
            if admin or item["key"] in granted
        ]
        if items:
            groups.append({"key": group["key"], "label": group["label"], "permissions": items})

    return {
        "role": role_id,
        "role_name": i18n.tr(role.get("name") or role_id),
        "role_description": i18n.tr(role.get("description") or ""),
        "is_admin": admin,
        "permissions": sorted(granted),
        "groups": groups,
    }


@router.get("/permissions")
async def permissions() -> Dict[str, Any]:
    """Expose the role model so the UI can render the permission matrix."""
    return {
        "roles": [
            {
                "role": role,
                "description": security.ROLE_DESCRIPTIONS.get(role, ""),
                "permissions": perms,
            }
            for role, perms in security.ROLE_PERMISSIONS.items()
        ]
    }
