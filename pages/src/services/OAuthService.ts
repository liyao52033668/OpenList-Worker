import apiService from '../posts/api';

export interface OAuthAuthUrlRequest {
    oauth_name: string;
    redirect_uri?: string;
}

export interface OAuthAuthUrlResponse {
    flag: boolean;
    text: string;
    data?: {
        auth_url: string;
        state: string;
    };
}

export interface OAuthCallbackRequest {
    oauth_name: string;
    code: string;
    state: string;
}

export interface OAuthCallbackResponse {
    flag: boolean;
    text: string;
    token?: string;
    data?: {
        access_token: string;
        refresh_token?: string;
        user_info: {
            id: string;
            name: string;
            email: string;
            avatar?: string;
        };
    };
}

export interface OAuthTokenResponse {
    flag: boolean;
    text: string;
    data?: Array<{
        oauth_name: string;
        user_id: string;
        access_token: string;
        refresh_token?: string;
        expires_at: string;
        user_info: any;
    }>;
}

export class OAuthService {

    /**
     * 获取OAuth授权URL（新版 API: POST /api/auth/sso）
     */
    async getAuthUrl(provider: string, redirectUri: string): Promise<OAuthAuthUrlResponse> {
        const response: any = await apiService.post(`/api/auth/sso`, {
            provider,
            redirect_uri: redirectUri,
        });
        // 拦截器已剥出新版 {code,message,data} 的 data，response 即 { auth_url, state }
        return {
            flag: true,
            text: '',
            data: {
                auth_url: response.auth_url || response.data?.auth_url || response.access_token || '',
                state: response.state || response.data?.state || provider,
            },
        };
    }

    /**
     * 处理OAuth回调（新版 API: GET /api/auth/sso_callback）
     */
    async handleCallback(code: string, state: string, provider: string): Promise<OAuthCallbackResponse> {
        const response = await apiService.get(`/api/auth/sso_callback`, {
            params: { code, state, provider },
        });
        return response;
    }

    /**
     * 获取用户的OAuth令牌（新版 API: GET /api/me）
     */
    async getUserTokens(provider?: string): Promise<OAuthTokenResponse> {
        const response = await apiService.get('/api/me');
        return response;
    }

    /**
     * 刷新OAuth令牌（新版 API: POST /api/auth/login）
     */
    async refreshToken(provider: string, refreshToken: string): Promise<boolean> {
        // 后端 /api/auth/login 仅接受 {username, password}，不支持 OAuth token 刷新，此方法已废弃
        console.warn('[OAuthService] refreshToken 未实现：后端 /api/auth/login 不接受 OAuth 参数');
        return false;
    }

    /**
     * 验证OAuth令牌（通过 GET /api/me 验证当前 token 有效性）
     */
    async validateToken(provider: string, accessToken: string): Promise<boolean> {
        try {
            const response = await apiService.get('/api/me');
            return response.flag ?? (response.code === 200);
        } catch {
            return false;
        }
    }

    /**
     * 撤销OAuth令牌（新版 API: GET /api/auth/logout）
     */
    async revokeToken(provider: string, accessToken: string): Promise<boolean> {
        const response = await apiService.get('/api/auth/logout');
        return response.flag ?? (response.code === 200);
    }

    /**
     * 获取可用的OAuth提供商（公开接口，登录页/绑定页均可访问）
     */
    async getAvailableProviders(): Promise<{ flag: boolean; text: string; data?: any[] }> {
        const response: any = await apiService.get('/api/public/oauth/providers');
        // 拦截器已剥出 data，为提供商数组
        const list = Array.isArray(response) ? response : (response?.data || []);
        return { flag: true, text: '', data: list };
    }

    /**
     * 绑定OAuth账户（新版 API: POST /api/auth/sso_callback with bind mode）
     */
    async bindAccount(code: string, state: string, provider: string): Promise<OAuthCallbackResponse> {
        const response = await apiService.get(`/api/auth/sso_callback`, {
            params: { code, state, provider, mode: 'bind' },
        });
        return response;
    }

    /**
     * 百度网盘授权：生成授权 URL（挂载点表单「获取刷新令牌」按钮使用）
     * 独立接口：client_id 由表单临时提供，不走 /api/auth/sso
     */
    async getBaiduAuthUrl(clientId: string, redirectUri: string): Promise<{ auth_url: string; state: string; redirect_uri: string }> {
        const response: any = await apiService.post('/api/oauth/baidu/authurl', {
            client_id: clientId,
            redirect_uri: redirectUri,
        });
        return {
            auth_url: response.auth_url || response.data?.auth_url || '',
            state: response.state || response.data?.state || '',
            redirect_uri: response.redirect_uri || response.data?.redirect_uri || redirectUri,
        };
    }

    /**
     * 百度网盘授权：用授权码兑换 refresh_token
     * 返回 { access_token, refresh_token, expires_in }
     */
    async exchangeBaiduCode(code: string, clientId: string, clientSecret: string, redirectUri: string): Promise<any> {
        return apiService.post('/api/oauth/baidu/exchange', {
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
        });
    }
}

export const oauthService = new OAuthService();
export default oauthService;