/**
 * 认证 API 路由 — /api/auth/*、/api/me
 * 与 GO 后端 server/handles/auth.go 对齐
 *
 * 端点：
 *   POST /api/auth/login          — 明文密码登录（内部 SHA256 哈希）
 *   POST /api/auth/login/hash     — 已哈希密码登录
 *   GET  /api/auth/logout         — 登出
 *   POST /api/auth/2fa/generate   — 生成 TOTP 二维码
 *   POST /api/auth/2fa/verify     — 验证并绑定 2FA
 *   GET  /api/me                  — 获取当前用户信息
 *   POST /api/me/update           — 更新当前用户信息
 */
import type { Hono, Context } from 'hono';
import { UsersManage } from '../users/UsersManage';
import { successResp, errorResp } from '../types/HttpResponse';

// OAuth 提供商端点映射（auth=授权端点，token=令牌交换端点，userinfo=用户信息端点）
const OAUTH_PROVIDERS: Record<string, { auth: string; token: string; userinfo: string; scope: string }> = {
    google: {
        auth: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        userinfo: 'https://www.googleapis.com/oauth2/v2/userinfo',
        scope: 'openid email profile',
    },
    github: {
        auth: 'https://github.com/login/oauth/authorize',
        token: 'https://github.com/login/oauth/access_token',
        userinfo: 'https://api.github.com/user',
        scope: 'read:user user:email',
    },
    microsoft: {
        auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        userinfo: 'https://graph.microsoft.com/oidc/userinfo',
        scope: 'openid email profile',
    },
    facebook: {
        auth: 'https://www.facebook.com/v19.0/dialog/oauth',
        token: 'https://graph.facebook.com/v19.0/oauth/access_token',
        userinfo: 'https://graph.facebook.com/me?fields=id,name,email',
        scope: 'email',
    },
};

// 百度网盘 OAuth 端点（挂载点表单「获取刷新令牌」使用）
// 与第三方登录 OAuth 体系独立：client_id/client_secret 由前端表单临时提供，不入库
const BAIDU_AUTH_URL = 'https://openapi.baidu.com/oauth/2.0/authorize';
const BAIDU_TOKEN_URL = 'https://openapi.baidu.com/oauth/2.0/token';
const BAIDU_CALLBACK_PATH = '/baidu-oauth-callback';

export function authRoutes(app: Hono<any>) {

    // ------------------------------------------------------------------
    // POST /api/auth/login — 明文密码登录
    // Body: { username: string, password: string, otp_code?: string }
    // ------------------------------------------------------------------
    app.post('/api/auth/login', async (c: Context): Promise<any> => {
        let body: any = {};
        try { body = await c.req.json(); } catch { return errorResp(c, '请求体格式错误', 400); }

        const { username, password } = body;
        if (!username || !password) return errorResp(c, '用户名和密码不能为空', 400);

        const users = new UsersManage(c);
        const result = await users.log_in({ users_name: username, users_pass: password });

        if (!result.flag) {
            const status = result.code === 429 ? 429 : 401;
            return errorResp(c, result.text || '用户名或密码错误', status);
        }
        return successResp(c, { token: result.token });
    });

    // ------------------------------------------------------------------
    // POST /api/auth/register — 用户注册（公开接口）
    // Body: { username: string, password: string, email?: string }
    // 安全修复 SEC-11: 注册前检查系统 allow_registration 开关
    // ------------------------------------------------------------------
    app.post('/api/auth/register', async (c: Context): Promise<any> => {
        let body: any = {};
        try { body = await c.req.json(); } catch { return errorResp(c, '请求体格式错误', 400); }

        // 检查系统注册开关
        try {
            const { AdminManage } = await import('../admin/AdminManage');
            const adminManage = new AdminManage(c);
            const setting = await adminManage.select('allow_registration');
            const allowed = setting.data?.[0]?.admin_data;
            // 默认允许注册；明确设置为 'false' 时禁止
            if (allowed === 'false' || allowed === '0') {
                return errorResp(c, '系统已关闭注册功能，请联系管理员', 403);
            }
        } catch { /* 读取设置失败时允许注册（降级处理） */ }

        const { username, password, email } = body;
        if (!username || !password) return errorResp(c, '用户名和密码不能为空', 400);

        const users = new UsersManage(c);
        const result = await users.create({
            users_name: username,
            users_pass: password,
            users_mail: email || '',
        });

        if (!result.flag) return errorResp(c, result.text || '注册失败', 400);
        return successResp(c);
    });

    // ------------------------------------------------------------------
    // POST /api/auth/sso — 获取 OAuth 授权 URL（公开，无需认证）
    // Body: { provider: string, redirect_uri?: string }
    // ------------------------------------------------------------------
    app.post('/api/auth/sso', async (c: Context): Promise<any> => {
        let body: any = {};
        try { body = await c.req.json(); } catch { return errorResp(c, '请求体格式错误', 400); }

        const provider = body.provider;
        const redirectUri = body.redirect_uri || `${new URL(c.req.url).origin}/oauth/callback`;
        if (!provider) return errorResp(c, 'provider 不能为空', 400);

        const { OauthManage } = await import('../oauth/OauthManage');
        const oauthManage = new OauthManage(c);
        const configResult = await oauthManage.select(provider);
        if (!configResult.flag || !configResult.data || configResult.data.length === 0) {
            return errorResp(c, 'OAuth 配置不存在', 404);
        }
        const config = configResult.data[0];
        if (config.is_enabled !== 1) return errorResp(c, 'OAuth 配置已禁用', 403);

        let oauthData: any = {};
        try { oauthData = JSON.parse(config.oauth_data || '{}'); } catch { /* ignore */ }
        const clientId = oauthData.client_id || '';
        if (!clientId) return errorResp(c, 'OAuth client_id 未配置', 400);

        const type = (config.oauth_type || '').toLowerCase();
        const providerCfg = OAUTH_PROVIDERS[type];
        if (!providerCfg) return errorResp(c, `暂不支持 ${config.oauth_type} 类型`, 400);

        const state = `st_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
        const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            state,
        });
        if (providerCfg.scope) params.set('scope', providerCfg.scope);
        const authUrl = `${providerCfg.auth}?${params.toString()}`;

        return successResp(c, { auth_url: authUrl, state });
    });

    // ------------------------------------------------------------------
    // GET /api/auth/sso_callback?code=&state=&provider=&mode=login|bind
    // OAuth 授权回调：登录或绑定（公开，绑定模式需已登录）
    // ------------------------------------------------------------------
    app.get('/api/auth/sso_callback', async (c: Context): Promise<any> => {
        const code = c.req.query('code') || '';
        const state = c.req.query('state') || '';
        const provider = c.req.query('provider') || '';
        const mode = c.req.query('mode') || 'login';
        if (!code || !state || !provider) return errorResp(c, '缺少必要参数', 400);

        const { OauthManage } = await import('../oauth/OauthManage');
        const oauthManage = new OauthManage(c);
        const configResult = await oauthManage.select(provider);
        if (!configResult.flag || !configResult.data || configResult.data.length === 0) {
            return errorResp(c, 'OAuth 配置不存在', 404);
        }
        const config = configResult.data[0];
        if (config.is_enabled !== 1) return errorResp(c, 'OAuth 配置已禁用', 403);

        let oauthData: any = {};
        try { oauthData = JSON.parse(config.oauth_data || '{}'); } catch { /* ignore */ }
        const clientId = oauthData.client_id || '';
        const clientSecret = oauthData.client_secret || '';
        if (!clientId || !clientSecret) return errorResp(c, 'OAuth client_id/client_secret 未配置', 400);

        const type = (config.oauth_type || '').toLowerCase();
        const providerCfg = OAUTH_PROVIDERS[type];
        if (!providerCfg) return errorResp(c, `暂不支持 ${config.oauth_type} 类型`, 400);

        const origin = new URL(c.req.url).origin;
        const redirectUri = `${origin}/oauth/callback`;

        // 1. 用 code 交换 access_token
        let tokenData: any = {};
        try {
            const tokenResp = await fetch(providerCfg.token, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
                body: new URLSearchParams({
                    code,
                    client_id: clientId,
                    client_secret: clientSecret,
                    redirect_uri: redirectUri,
                    grant_type: 'authorization_code',
                }).toString(),
            });
            tokenData = await tokenResp.json();
        } catch {
            return errorResp(c, '交换 token 失败', 502);
        }
        const accessToken = tokenData.access_token;
        if (!accessToken) return errorResp(c, '获取 access_token 失败', 401);

        // 2. 获取用户信息
        let userInfo: any = {};
        try {
            const infoResp = await fetch(providerCfg.userinfo, {
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
            });
            userInfo = await infoResp.json();
        } catch { /* 用户信息获取失败 */ }

        const oauthUserId = String(userInfo.id || userInfo.sub || userInfo.openid || userInfo.user_id || userInfo.login || '');
        const email = userInfo.email || '';
        const name = userInfo.name || userInfo.login || userInfo.nickname || '';
        if (!oauthUserId) return errorResp(c, '获取用户信息失败', 401);

        const users = new UsersManage(c);
        const oauthUserInfo = {
            oauth_name: provider,
            oauth_user_id: oauthUserId,
            email,
            name,
            avatar: userInfo.avatar_url || userInfo.picture || '',
            raw_data: JSON.stringify(userInfo),
        };

        // 绑定模式：需要已登录用户
        if (mode === 'bind') {
            const currentUser = c.get('user');
            if (!currentUser) return errorResp(c, '未登录', 401);
            const bindResult = await users.bindOAuth(currentUser.users_name, oauthUserInfo);
            if (!bindResult.flag) return errorResp(c, bindResult.text || '绑定失败', 400);
            return successResp(c, { flag: true, text: bindResult.text || '绑定成功' });
        }

        // 登录模式
        const loginResult = await users.oauthLogin(oauthUserInfo);
        if (!loginResult.flag) return errorResp(c, loginResult.text || '登录失败', 401);
        const user = (loginResult.data && loginResult.data[0]) || {};
        return successResp(c, {
            flag: true,
            token: loginResult.token,
            data: user,
        });
    });

    // ------------------------------------------------------------------
    // POST /api/oauth/baidu/authurl — 生成百度网盘授权 URL
    // Body: { client_id, redirect_uri? }
    // 供挂载点表单「获取刷新令牌」按钮使用，client_id 由表单填写
    // ------------------------------------------------------------------
    app.post('/api/oauth/baidu/authurl', async (c: Context): Promise<any> => {
        let body: any = {};
        try { body = await c.req.json(); } catch { return errorResp(c, '请求体格式错误', 400); }

        const clientId = String(body.client_id || '').trim();
        if (!clientId) return errorResp(c, 'client_id 不能为空', 400);

        const origin = new URL(c.req.url).origin;
        const redirectUri = body.redirect_uri || `${origin}${BAIDU_CALLBACK_PATH}`;

        const state = `baidu_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: redirectUri,
            scope: 'basic,netdisk',
            display: 'popup',
            state,
        });

        return successResp(c, {
            auth_url: `${BAIDU_AUTH_URL}?${params.toString()}`,
            state,
            redirect_uri: redirectUri,
        });
    });

    // ------------------------------------------------------------------
    // POST /api/oauth/baidu/exchange — 用授权码兑换 refresh_token
    // Body: { code, client_id, client_secret, redirect_uri }
    // 授权回调页把 code 回传前端后，由前端携带表单中的凭据调用本接口
    // ------------------------------------------------------------------
    app.post('/api/oauth/baidu/exchange', async (c: Context): Promise<any> => {
        let body: any = {};
        try { body = await c.req.json(); } catch { return errorResp(c, '请求体格式错误', 400); }

        const { code, client_id, client_secret, redirect_uri } = body;
        if (!code || !client_id || !client_secret) return errorResp(c, 'code/client_id/client_secret 不能为空', 400);

        try {
            const tokenResp = await fetch(BAIDU_TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    client_id,
                    client_secret,
                    redirect_uri: redirect_uri || '',
                }).toString(),
            });
            const data: any = await tokenResp.json();

            if (data.error) return errorResp(c, data.error_description || data.error, 400);
            if (!data.refresh_token) return errorResp(c, '百度未返回 refresh_token', 400);

            return successResp(c, {
                access_token: data.access_token || '',
                refresh_token: data.refresh_token,
                expires_in: data.expires_in || 0,
            });
        } catch (error) {
            return errorResp(c, '交换 token 失败: ' + (error as Error).message, 502);
        }
    });

    // ------------------------------------------------------------------
    // POST /api/auth/login/hash — 已哈希密码登录
    // Body: { username: string, password: string, otp_code?: string }
    // ------------------------------------------------------------------
    app.post('/api/auth/login/hash', async (c: Context): Promise<any> => {
        let body: any = {};
        try { body = await c.req.json(); } catch { return errorResp(c, '请求体格式错误', 400); }

        const { username, password } = body;
        if (!username || !password) return errorResp(c, '用户名和密码不能为空', 400);

        const users = new UsersManage(c);
        const result = await users.log_in_hash(username, password);

        if (!result.flag) {
            const status = result.code === 429 ? 429 : 401;
            return errorResp(c, result.text || '用户名或密码错误', status);
        }
        return successResp(c, { token: result.token });
    });

    // ------------------------------------------------------------------
    // GET /api/auth/logout — 登出
    // ------------------------------------------------------------------
    app.get('/api/auth/logout', async (c: Context): Promise<any> => {
        const authHeader = c.req.header('Authorization');
        const token = authHeader?.replace('Bearer ', '').trim();
        const users = new UsersManage(c);
        await users.logout(token);
        return successResp(c);
    });

    // ------------------------------------------------------------------
    // POST /api/auth/2fa/generate — 生成 TOTP 二维码
    // 需要登录
    // ------------------------------------------------------------------
    app.post('/api/auth/2fa/generate', async (c: Context): Promise<any> => {
        const user = c.get('user');
        if (!user) return errorResp(c, '未登录', 401);

        // 生成 TOTP 密钥（32 字节 base32）
        const secretBytes = new Uint8Array(20);
        crypto.getRandomValues(secretBytes);
        const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let secret = '';
        for (let i = 0; i < secretBytes.length; i++) {
            secret += base32Chars[secretBytes[i] % 32];
        }

        // 生成 otpauth URI
        const issuer = 'OpenList';
        const account = encodeURIComponent(user.users_name);
        const otpauthUri = `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

        // 生成二维码 URL（使用 Google Charts API）
        const qrUrl = `https://chart.googleapis.com/chart?chs=200x200&chld=M|0&cht=qr&chl=${encodeURIComponent(otpauthUri)}`;

        return successResp(c, { qr: qrUrl, secret });
    });

    // ------------------------------------------------------------------
    // POST /api/auth/2fa/verify — 验证并绑定 2FA
    // Body: { code: string, secret: string }
    // ------------------------------------------------------------------
    app.post('/api/auth/2fa/verify', async (c: Context): Promise<any> => {
        const user = c.get('user');
        if (!user) return errorResp(c, '未登录', 401);

        let body: any = {};
        try { body = await c.req.json(); } catch { return errorResp(c, '请求体格式错误', 400); }

        const { code, secret } = body;
        if (!code || !secret) return errorResp(c, 'code 和 secret 不能为空', 400);

        // 验证 TOTP 代码
        const isValid = await verifyTOTP(code, secret);
        if (!isValid) return errorResp(c, '验证码错误', 400);

        // 将 secret 保存到用户记录
        const users = new UsersManage(c);
        const updateResult = await users.config({
            users_name: user.users_name,
            otp_secret: secret,
        } as any);

        if (!updateResult.flag) return errorResp(c, updateResult.text || '保存失败', 500);
        return successResp(c);
    });

    // ------------------------------------------------------------------
    // GET /api/me — 获取当前用户信息
    // ------------------------------------------------------------------
    app.get('/api/me', async (c: Context): Promise<any> => {
        const user = c.get('user');
        if (!user) return errorResp(c, '未登录', 401);

        // 不返回密码字段
        const { users_pass, ...safeUser } = user as any;

        // 聚合该用户的 OAuth 绑定到 oauth_data（OAuthBinding 页面从 oauth_data 读取绑定列表）
        try {
            const { BindsManage } = await import('../binds/BindsManage');
            const bindsManage = new BindsManage(c);
            const bindResult = await bindsManage.select(undefined, user.users_name);
            if (bindResult.flag && bindResult.data && bindResult.data.length > 0) {
                const oauthList = (bindResult.data as any[]).map((b: any) => {
                    let info: any = {};
                    try { info = JSON.parse(b.binds_data || '{}'); } catch { /* ignore */ }
                    return {
                        oauth_name: b.oauth_name,
                        oauth_user_id: info.oauth_user_id || '',
                        email: info.email || '',
                        name: info.name || '',
                        avatar: info.avatar || '',
                    };
                });
                safeUser.oauth_data = JSON.stringify(oauthList);
            }
        } catch { /* 聚合失败不影响主流程 */ }

        return successResp(c, safeUser);
    });

    // ------------------------------------------------------------------
    // POST /api/me/update — 更新当前用户信息
    // Body: { email?: string, password?: string }
    // 注意：不允许修改用户名（防止权限提升攻击，SEC-02）
    // ------------------------------------------------------------------
    app.post('/api/me/update', async (c: Context): Promise<any> => {
        const user = c.get('user');
        if (!user) return errorResp(c, '未登录', 401);

        let body: any = {};
        try { body = await c.req.json(); } catch { return errorResp(c, '请求体格式错误', 400); }

        // 安全限制：不允许修改用户名
        if (body.username && body.username !== user.users_name) {
            return errorResp(c, '用户名不可修改', 403);
        }

        const updateData: any = { users_name: user.users_name };
        // 兼容 Go 字段（email/password）与前端 TSWorker 字段（users_mail/users_pass）
        if (body.email !== undefined || body.users_mail !== undefined) updateData.users_mail = body.email ?? body.users_mail;
        if (body.password || body.users_pass) updateData.users_pass = body.password || body.users_pass;

        const users = new UsersManage(c);

        // OAuth 解绑：调用 UsersManage.unbindOAuth（操作 binds 表）
        // Body: { oauth_unbind: { oauth_name, oauth_user_id } }
        if (body.oauth_unbind && body.oauth_unbind.oauth_name) {
            const { oauth_name, oauth_user_id } = body.oauth_unbind;
            const unbindResult = await users.unbindOAuth(user.users_name, oauth_name, oauth_user_id || '');
            if (!unbindResult.flag) return errorResp(c, unbindResult.text || '解绑失败', 400);
            return successResp(c);
        }

        const result = await users.config({ ...user, ...updateData });
        if (!result.flag) return errorResp(c, result.text || '更新失败', 500);
        return successResp(c);
    });
}

// ============================================================
// TOTP 验证（RFC 6238）
// ============================================================
async function verifyTOTP(code: string, secret: string): Promise<boolean> {
    try {
        const now = Math.floor(Date.now() / 1000);
        // 检查当前时间窗口及前后各一个窗口（容忍时钟偏差）
        for (const offset of [-1, 0, 1]) {
            const counter = Math.floor(now / 30) + offset;
            const expected = await generateTOTP(secret, counter);
            if (expected === code) return true;
        }
        return false;
    } catch {
        return false;
    }
}

async function generateTOTP(secret: string, counter: number): Promise<string> {
    // Base32 解码
    const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleanSecret = secret.toUpperCase().replace(/=+$/, '');
    let bits = 0, value = 0;
    const bytes: number[] = [];
    for (const char of cleanSecret) {
        const idx = base32Chars.indexOf(char);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }

    // counter → 8字节大端序
    const counterBytes = new Uint8Array(8);
    let c = counter;
    for (let i = 7; i >= 0; i--) {
        counterBytes[i] = c & 0xff;
        c = Math.floor(c / 256);
    }

    // HMAC-SHA1
    const key = await crypto.subtle.importKey(
        'raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, counterBytes);
    const hash = new Uint8Array(sig);

    // 动态截断
    const offset = hash[hash.length - 1] & 0x0f;
    const code = ((hash[offset] & 0x7f) << 24)
        | ((hash[offset + 1] & 0xff) << 16)
        | ((hash[offset + 2] & 0xff) << 8)
        | (hash[offset + 3] & 0xff);
    return String(code % 1_000_000).padStart(6, '0');
}
