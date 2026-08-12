/**
 * 管理员 API 路由 — /api/admin/*、/api/public/*
 * 与 GO 后端 server/router.go admin() 函数对齐
 *
 * 端点：
 *   /api/admin/user/*     — 用户管理
 *   /api/admin/storage/*  — 存储管理
 *   /api/admin/driver/*   — 驱动信息
 *   /api/admin/setting/*  — 系统设置
 *   /api/admin/meta/*     — 路径元数据
 *   /api/public/settings  — 公开设置（无需认证）
 */
import type { Hono, Context } from 'hono';
import { UsersManage } from '../users/UsersManage';
import { MountManage } from '../mount/MountManage';
import { AdminManage } from '../admin/AdminManage';
import { MatesManage } from '../mates/MatesManage';
import { CryptManage } from '../crypt/CryptManage';
import { TokenManage } from '../token/TokenManage';
import { MediaManage } from '../media/MediaManage';
import { GroupManage } from '../group/GroupManage';
import { OauthManage } from '../oauth/OauthManage';
import { SavesManage } from '../saves/SavesManage';
import { successResp, errorResp } from '../types/HttpResponse';

// 备份/恢复涉及的数据表及主键字段
const BACKUP_TABLES: Record<string, string> = {
    admin: 'admin_keys',
    mount: 'mount_path',
    users: 'users_name',
    oauth: 'oauth_name',
    binds: 'oauth_uuid',
    crypt: 'crypt_name',
    mates: 'mates_name',
    share: 'share_uuid',
    token: 'token_uuid',
    tasks: 'tasks_uuid',
    fetch: 'fetch_uuid',
    group: 'group_name',
    cache: 'cache_path',
};

// ============================================================
// 工具函数
// ============================================================

async function parseBody(c: Context): Promise<Record<string, any>> {
    const ct = c.req.header('Content-Type') || '';
    try {
        if (ct.includes('application/json')) return await c.req.json();
        if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
            const form = await c.req.formData();
            const obj: Record<string, any> = {};
            form.forEach((v, k) => { obj[k] = v; });
            return obj;
        }
        return await c.req.json();
    } catch {
        return {};
    }
}

function requireAdmin(c: Context): boolean {
    const user = c.get('user');
    return user ? UsersManage.isAdmin(user) : false;
}

// ============================================================
// 路由注册
// ============================================================
export function adminApiRoutes(app: Hono<any>) {

    // ============================================================
    // 管理员权限中间件（必须在所有 /api/admin/* 路由之前注册）
    // ============================================================
    app.use('/api/admin/*', async (c, next) => {
        const user = c.get('user');
        if (!user) return errorResp(c, '未登录', 401);
        if (!UsersManage.isAdmin(user)) return errorResp(c, '需要管理员权限', 403);
        await next();
    });

    // ============================================================
    // 公开设置（无需认证）
    // ============================================================

    // GET /api/public/settings — 公开系统设置
    app.get('/api/public/settings', async (c: Context): Promise<any> => {
        const adminManage = new AdminManage(c);
        const result = await adminManage.select();

        // 过滤出公开设置项
        const publicKeys = new Set([
            'site_name', 'site_logo', 'site_favicon', 'site_description',
            'allow_registration', 'default_page_size', 'version',
            'announcement', 'theme', 'custom_css', 'custom_js',
            'ocr_api', 'video_autoplay', 'audio_autoplay',
        ]);

        const settings: Record<string, any> = {};
        if (result.flag && result.data) {
            for (const item of result.data as any[]) {
                if (publicKeys.has(item.admin_keys)) {
                    settings[item.admin_keys] = item.admin_data;
                }
            }
        }

        // 默认值
        return successResp(c, {
            site_name: settings.site_name || 'OpenList',
            site_logo: settings.site_logo || '',
            site_favicon: settings.site_favicon || '',
            site_description: settings.site_description || '',
            allow_registration: settings.allow_registration !== 'false',
            version: settings.version || '1.0.0',
            announcement: settings.announcement || '',
            ...settings,
        });
    });

    // GET /ping — 健康检查
    app.get('/ping', (c: Context) => c.text('pong'));

    // ============================================================
    // 用户管理 /api/admin/user/*
    // 字段映射（Go后端 → TSWorker内部）：
    //   id(number)       → users_name(string) 作为唯一标识
    //   username         → users_name
    //   password         → users_pass
    //   role(0/1/2)      → users_mask('general'/'guest'/'admin')
    //   disabled(bool)   → is_enabled(!disabled)
    //   permission(int32)→ users_mask 位掩码扩展字段
    //   base_path        → mount_data
    // ============================================================

    /** 将 TSWorker 内部用户对象转换为 Go 后端风格响应 */
    function toGoUser(u: any, idx: number): any {
        const roleMap: Record<string, number> = { 'admin': 2, 'guest': 1 };
        const role = roleMap[u.users_mask] ?? 0;
        const isEnabled = u.is_enabled !== false;
        return {
            id: u.users_id ?? (idx + 1),
            username: u.users_name,
            base_path: u.mount_data || '/',
            role,
            disabled: !isEnabled,
            permission: u.users_perm ?? 0,
            sso_id: u.sso_id || '',
            otp: !!(u.otp_secret),
            // 补充 TSWorker 字段，兼容前端 UserManagement 页面（按旧字段渲染）
            users_name: u.users_name,
            users_mail: u.users_mail || '',
            users_mask: u.users_mask || 'user',
            is_enabled: isEnabled,
            total_size: u.total_size || 0,
            total_used: u.total_used || 0,
            oauth_data: u.oauth_data || '',
            mount_data: u.mount_data || '',
        };
    }

    // GET /api/admin/user/list
    // 支持 ?username=xxx 按用户名搜索；支持 ?oauth=1 返回 OAuth 配置列表（OAuthManagement 页面使用）
    app.get('/api/admin/user/list', async (c: Context): Promise<any> => {
        // OAuth 配置列表分支
        if (c.req.query('oauth')) {
            const oauthManage = new OauthManage(c);
            const oauthResult = await oauthManage.select();
            if (!oauthResult.flag) return errorResp(c, oauthResult.text || '查询失败', 500);
            return successResp(c, oauthResult.data || []);
        }

        const page = parseInt(c.req.query('page') || '1');
        const perPage = parseInt(c.req.query('per_page') || '30');
        const username = c.req.query('username') || '';

        const usersManage = new UsersManage(c);
        const result = await usersManage.select();
        if (!result.flag) return errorResp(c, result.text || '查询失败', 500);

        let all = (result.data || []) as any[];
        if (username) {
            all = all.filter((u: any) => (u.users_name || '').toLowerCase().includes(username.toLowerCase()));
        }
        const total = all.length;
        const start = (page - 1) * perPage;
        const content = all.slice(start, start + perPage).map((u: any, i: number) => toGoUser(u, start + i));

        return successResp(c, { content, total });
    });

    // GET /api/admin/user/get?id=xxx
    app.get('/api/admin/user/get', async (c: Context): Promise<any> => {
        // Go后端用 id(number) 查询，TSWorker 用 username 兼容两种方式
        const idOrName = c.req.query('id') || c.req.query('username') || '';
        if (!idOrName) return errorResp(c, 'id 不能为空', 400);

        const usersManage = new UsersManage(c);
        // 先尝试按用户名查询
        const result = await usersManage.select(idOrName);
        if (!result.flag || !result.data || result.data.length === 0) {
            return errorResp(c, '用户不存在', 404);
        }

        return successResp(c, toGoUser(result.data[0], 0));
    });

    // POST /api/admin/user/create
    // Body: { username, password, base_path?, role?, disabled?, permission? }
    app.post('/api/admin/user/create', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        // OAuth 配置创建分支（OAuthManagement 页面发送 oauth_name/oauth_type/oauth_data）
        if (body.oauth_name && !body.username && !body.users_name) {
            const oauthManage = new OauthManage(c);
            const oauthResult = await oauthManage.create({
                oauth_name: body.oauth_name,
                oauth_type: body.oauth_type || '',
                oauth_data: body.oauth_data || '{}',
                is_enabled: body.is_enabled ?? 1,
            });
            if (!oauthResult.flag) return errorResp(c, oauthResult.text || '创建失败', 400);
            return successResp(c);
        }
        const roleToMask: Record<number, string> = { 2: 'admin', 1: 'guest', 0: '' };
        const usersManage = new UsersManage(c);
        const result = await usersManage.create({
            // 兼容 Go 风格字段（username/password/email/role/disabled/base_path）
            // 与前端 UserManagement 表单的 TSWorker 字段（users_name/users_pass/users_mask/is_enabled）
            users_name: body.username ?? body.users_name,
            users_pass: body.password ?? body.users_pass,
            users_mail: body.email || body.users_mail || '',
            users_mask: body.role !== undefined ? (roleToMask[body.role] ?? '') : (body.users_mask ?? ''),
            is_enabled: body.disabled !== undefined ? !body.disabled : (body.is_enabled ?? true),
            mount_data: body.base_path || body.mount_data || '',
            total_size: body.total_size ?? 1024 * 1024 * 1024,
        });
        if (!result.flag) return errorResp(c, result.text || '创建失败', 500);
        return successResp(c);
    });

    // POST /api/admin/user/update
    // Body: { id, username, password?, base_path?, disabled?, permission? }
    app.post('/api/admin/user/update', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        // OAuth 配置更新分支（OAuthManagement 页面发送 oauth_name + is_enabled/oauth_type/oauth_data）
        if (body.oauth_name && !body.username && !body.users_name) {
            const oauthManage = new OauthManage(c);
            if (body.is_enabled !== undefined) {
                const r = await oauthManage.toggleStatus(body.oauth_name, body.is_enabled === 1 ? 1 : 0);
                if (!r.flag) return errorResp(c, r.text || '更新失败', 400);
            }
            if (body.oauth_type) {
                const r = await oauthManage.updateType(body.oauth_name, body.oauth_type);
                if (!r.flag) return errorResp(c, r.text || '更新失败', 400);
            }
            if (body.oauth_data) {
                const r = await oauthManage.updateData(body.oauth_name, body.oauth_data);
                if (!r.flag) return errorResp(c, r.text || '更新失败', 400);
            }
            return successResp(c);
        }
        const username = body.username ?? body.users_name;
        if (!username) return errorResp(c, 'username 不能为空', 400);

        const usersManage = new UsersManage(c);
        // 先查询确认用户存在
        const findResult = await usersManage.select(username);
        if (!findResult.flag || !findResult.data || findResult.data.length === 0) {
            return errorResp(c, '用户不存在', 404);
        }
        const existing = findResult.data[0] as any;

        const updateData: any = { users_name: username };
        // 兼容 Go 风格字段（password/base_path/disabled）与前端 TSWorker 字段（users_pass/users_mask/is_enabled）
        const password = body.password ?? body.users_pass;
        if (password) updateData.users_pass = password;
        if (body.base_path !== undefined || body.mount_data !== undefined) updateData.mount_data = body.base_path ?? body.mount_data;
        if (body.disabled !== undefined) updateData.is_enabled = !body.disabled;
        else if (body.is_enabled !== undefined) updateData.is_enabled = body.is_enabled;
        if (body.users_mask !== undefined) updateData.users_mask = body.users_mask;
        if (body.email !== undefined || body.users_mail !== undefined) updateData.users_mail = body.email ?? body.users_mail;

        const result = await usersManage.config({ ...existing, ...updateData });
        if (!result.flag) return errorResp(c, result.text || '更新失败', 500);
        return successResp(c);
    });

    // POST /api/admin/user/delete?id=xxx
    app.post('/api/admin/user/delete', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        // OAuth 配置删除分支（OAuthManagement 页面发送 oauth_name）
        if (body.oauth_name && !body.username && !body.users_name) {
            const oauthManage = new OauthManage(c);
            const oauthResult = await oauthManage.remove(body.oauth_name);
            if (!oauthResult.flag) return errorResp(c, oauthResult.text || '删除失败', 400);
            return successResp(c);
        }
        const username = body.username || body.users_name || c.req.query('username') || c.req.query('id') || '';
        if (!username) return errorResp(c, 'id 不能为空', 400);

        const usersManage = new UsersManage(c);
        const result = await usersManage.remove(username);
        if (!result.flag) return errorResp(c, result.text || '删除失败', 500);
        return successResp(c);
    });

    // POST /api/admin/user/cancel_2fa?id=xxx
    app.post('/api/admin/user/cancel_2fa', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const username = body.username || c.req.query('username') || c.req.query('id') || '';
        if (!username) return errorResp(c, 'id 不能为空', 400);

        const usersManage = new UsersManage(c);
        const findResult = await usersManage.select(username);
        if (!findResult.flag || !findResult.data || findResult.data.length === 0) {
            return errorResp(c, '用户不存在', 404);
        }
        const existing = findResult.data[0] as any;
        const result = await usersManage.config({ ...existing, otp_secret: '' });
        if (!result.flag) return errorResp(c, result.text || '操作失败', 500);
        return successResp(c);
    });

    // POST /api/admin/user/del_cache?username=xxx
    app.post('/api/admin/user/del_cache', async (c: Context): Promise<any> => {
        // TSWorker 无内存缓存，直接返回成功
        return successResp(c);
    });

    // ============================================================
    // 用户分组管理 /api/admin/group/*
    // ============================================================

    // GET /api/admin/group/list
    app.get('/api/admin/group/list', async (c: Context): Promise<any> => {
        const groupManage = new GroupManage(c);
        const result = await groupManage.select();
        if (!result.flag) return errorResp(c, result.text || '查询失败', 500);
        return successResp(c, result.data || []);
    });

    // POST /api/admin/group/create
    app.post('/api/admin/group/create', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        if (!body.group_name) return errorResp(c, 'group_name 不能为空', 400);

        const groupManage = new GroupManage(c);
        const result = await groupManage.create({
            group_name: body.group_name,
            group_mask: body.group_mask || '',
            is_enabled: body.is_enabled ?? 1,
        });
        if (!result.flag) return errorResp(c, result.text || '创建失败', 400);
        return successResp(c);
    });

    // POST /api/admin/group/update — 更新分组权限掩码或启用状态
    app.post('/api/admin/group/update', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        if (!body.group_name) return errorResp(c, 'group_name 不能为空', 400);

        const groupManage = new GroupManage(c);
        if (body.group_mask !== undefined && body.group_mask !== '') {
            const r = await groupManage.updateMask(body.group_name, body.group_mask);
            if (!r.flag) return errorResp(c, r.text || '更新失败', 400);
        }
        if (body.is_enabled !== undefined) {
            const r = await groupManage.toggleStatus(body.group_name, body.is_enabled === 1 ? 1 : 0);
            if (!r.flag) return errorResp(c, r.text || '更新失败', 400);
        }
        return successResp(c);
    });

    // POST /api/admin/group/delete
    app.post('/api/admin/group/delete', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        if (!body.group_name) return errorResp(c, 'group_name 不能为空', 400);

        const groupManage = new GroupManage(c);
        const result = await groupManage.remove(body.group_name);
        if (!result.flag) return errorResp(c, result.text || '删除失败', 400);
        return successResp(c);
    });

    // ============================================================
    // OAuth 配置管理 /api/admin/oauth/*
    // ============================================================

    // GET /api/admin/oauth/list — OAuth 提供商配置列表（管理员查看全部配置）
    app.get('/api/admin/oauth/list', async (c: Context): Promise<any> => {
        const oauthManage = new OauthManage(c);
        const result = await oauthManage.select();
        if (!result.flag) return errorResp(c, result.text || '查询失败', 500);
        return successResp(c, result.data || []);
    });

    // GET /api/public/oauth/providers — 公开 OAuth 提供商列表（登录页/绑定页，无需认证，不含敏感配置）
    app.get('/api/public/oauth/providers', async (c: Context): Promise<any> => {
        const oauthManage = new OauthManage(c);
        const result = await oauthManage.getEnabledOauth();
        if (!result.flag) return errorResp(c, result.text || '查询失败', 500);
        const providers = (result.data || []).map((p: any) => ({
            oauth_name: p.oauth_name,
            oauth_type: p.oauth_type,
            is_enabled: p.is_enabled ?? 1,
        }));
        return successResp(c, providers);
    });

    // ============================================================
    // 存储管理 /api/admin/storage/*
    // 字段映射（Go后端 → TSWorker内部）：
    //   id(number)           → 按列表顺序生成（mount_path 作为唯一标识）
    //   mount_path           → mount_path
    //   driver               → mount_type
    //   addition(string)     → drive_conf
    //   cache_expiration     → cache_time
    //   disabled(bool)       → is_enabled(!disabled)
    //   order                → order（暂无，默认0）
    //   remark               → remark（暂无，默认''）
    //   status               → is_enabled ? 'work' : 'disabled'
    // ============================================================

    /** 将 TSWorker 内部存储对象转换为 Go 后端风格响应 */
    function toGoStorage(m: any, id: number): any {
        return {
            id,
            mount_path: m.mount_path,
            driver: m.mount_type || '',
            order: m.index_list ?? m.order ?? 0,
            remark: m.drive_tips ?? (m.remark || ''),
            cache_expiration: m.cache_time ?? 30,
            status: m.is_enabled ? 'work' : 'disabled',
            addition: m.drive_conf || '{}',
            disabled: !m.is_enabled,
            web_proxy: m.proxy_mode === 1,
            webdav_policy: m.proxy_data || 'native_proxy',
            down_proxy_url: '',
            enable_sign: false,
            disable_index: false,
            // 补充 TSWorker 字段（兼容前端 MountManagement）
            is_enabled: m.is_enabled ? 1 : 0,
            cache_time: m.cache_time ?? 30,
            proxy_mode: m.proxy_mode ?? 0,
            proxy_data: m.proxy_data || '',
            drive_logs: m.drive_logs || '',
            index_list: m.index_list ?? m.order ?? 0,
            drive_tips: m.drive_tips ?? (m.remark || ''),
        };
    }

    /** 根据 id 或 mount_path 查找存储，返回 [存储对象, id] */
    async function findStorageByIdOrPath(mountManage: MountManage, idOrPath: string): Promise<[any, number] | null> {
        const all = await mountManage.select();
        if (!all.flag || !all.data) return null;
        const idNum = parseInt(idOrPath);
        if (!isNaN(idNum) && idNum > 0) {
            const item = all.data[idNum - 1] as any;
            return item ? [item, idNum] : null;
        }
        // 按 mount_path 查找
        const idx = (all.data as any[]).findIndex((m: any) => m.mount_path === idOrPath);
        return idx >= 0 ? [all.data[idx], idx + 1] : null;
    }

    // GET /api/admin/storage/list
    app.get('/api/admin/storage/list', async (c: Context): Promise<any> => {
        const page = parseInt(c.req.query('page') || '1');
        const perPage = parseInt(c.req.query('per_page') || '30');

        const mountManage = new MountManage(c);
        const result = await mountManage.select();
        if (!result.flag) return errorResp(c, result.text || '查询失败', 500);

        const all = result.data || [];
        const total = all.length;
        const start = (page - 1) * perPage;
        const content = all.slice(start, start + perPage).map((m: any, idx: number) =>
            toGoStorage(m, start + idx + 1)
        );

        return successResp(c, { content, total });
    });

    // GET /api/admin/storage/get?id=xxx
    app.get('/api/admin/storage/get', async (c: Context): Promise<any> => {
        const idOrPath = c.req.query('id') || c.req.query('mount_path') || '';
        if (!idOrPath) return errorResp(c, 'id 不能为空', 400);

        const mountManage = new MountManage(c);
        const found = await findStorageByIdOrPath(mountManage, idOrPath);
        if (!found) return errorResp(c, '存储不存在', 404);

        return successResp(c, toGoStorage(found[0], found[1]));
    });

    // POST /api/admin/storage/create
    // Body: { mount_path, driver, addition?, cache_expiration?, disabled?, web_proxy?, order?, remark? }
    app.post('/api/admin/storage/create', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        if (!body.mount_path || !body.driver) return errorResp(c, 'mount_path 和 driver 不能为空', 400);

        const mountManage = new MountManage(c);
        const result = await mountManage.create({
            mount_path: body.mount_path,
            mount_type: body.driver,
            is_enabled: body.disabled ? 0 : 1,
            drive_conf: typeof body.addition === 'string' ? body.addition : JSON.stringify(body.addition || {}),
            drive_save: '{}',
            drive_logs: '',
            cache_time: body.cache_expiration ?? 30,
            proxy_mode: body.web_proxy ? 1 : 0,
            proxy_data: body.webdav_policy || '',
            // Go 风格契约字段映射到真实表列：order → index_list、remark → drive_tips
            index_list: body.order ?? 0,
            drive_tips: body.remark || '',
        });

        if (!result.flag) return errorResp(c, result.text || '创建失败', 500);
        // 返回新存储的 id（列表末尾）
        const all = await mountManage.select();
        const newId = (all.data || []).length;
        return successResp(c, { id: newId });
    });

    // POST /api/admin/storage/update
    // Body: { id, mount_path, driver?, addition?, cache_expiration?, disabled?, web_proxy? }
    app.post('/api/admin/storage/update', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const idOrPath = body.id !== undefined ? String(body.id) : (body.mount_path || '');
        if (!idOrPath) return errorResp(c, 'id 不能为空', 400);

        const mountManage = new MountManage(c);
        const found = await findStorageByIdOrPath(mountManage, idOrPath);
        if (!found) return errorResp(c, '存储不存在', 404);

        const existing = found[0] as any;
        const updateData: any = { mount_path: existing.mount_path };
        if (body.driver !== undefined) updateData.mount_type = body.driver;
        if (body.addition !== undefined) {
            updateData.drive_conf = typeof body.addition === 'string' ? body.addition : JSON.stringify(body.addition);
        }
        if (body.disabled !== undefined) updateData.is_enabled = !body.disabled;
        if (body.cache_expiration !== undefined) updateData.cache_time = body.cache_expiration;
        if (body.web_proxy !== undefined) updateData.proxy_mode = body.web_proxy ? 1 : 0;
        if (body.webdav_policy !== undefined) updateData.proxy_data = body.webdav_policy;
        // Go 风格契约字段映射到 TSWorker 真实表列（mount 表无 order/remark 列，直接写入会报 SQL 错误）：
        // order → index_list、remark → drive_tips
        if (body.order !== undefined) updateData.index_list = body.order;
        if (body.remark !== undefined) updateData.drive_tips = body.remark;

        const result = await mountManage.config({ ...existing, ...updateData });
        if (!result.flag) return errorResp(c, result.text || '更新失败', 500);
        return successResp(c);
    });

    // POST /api/admin/storage/delete?id=xxx
    app.post('/api/admin/storage/delete', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const idOrPath = body.id !== undefined ? String(body.id) : (body.mount_path || c.req.query('id') || '');
        if (!idOrPath) return errorResp(c, 'id 不能为空', 400);

        const mountManage = new MountManage(c);
        const found = await findStorageByIdOrPath(mountManage, idOrPath);
        if (!found) return errorResp(c, '存储不存在', 404);

        const result = await mountManage.remove(found[0].mount_path);
        if (!result.flag) return errorResp(c, result.text || '删除失败', 500);
        return successResp(c);
    });

    // POST /api/admin/storage/enable?id=xxx
    app.post('/api/admin/storage/enable', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const idOrPath = body.id !== undefined ? String(body.id) : (body.mount_path || c.req.query('id') || '');
        if (!idOrPath) return errorResp(c, 'id 不能为空', 400);

        const mountManage = new MountManage(c);
        const found = await findStorageByIdOrPath(mountManage, idOrPath);
        if (!found) return errorResp(c, '存储不存在', 404);

        const configResult = await mountManage.config({ ...found[0], is_enabled: true });
        if (!configResult.flag) return errorResp(c, configResult.text || '操作失败', 500);
        // 启用后重新初始化驱动
        await mountManage.reload(found[0].mount_path);
        return successResp(c);
    });

    // POST /api/admin/storage/disable?id=xxx
    app.post('/api/admin/storage/disable', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const idOrPath = body.id !== undefined ? String(body.id) : (body.mount_path || c.req.query('id') || '');
        if (!idOrPath) return errorResp(c, 'id 不能为空', 400);

        const mountManage = new MountManage(c);
        const found = await findStorageByIdOrPath(mountManage, idOrPath);
        if (!found) return errorResp(c, '存储不存在', 404);

        const result = await mountManage.config({ ...found[0], is_enabled: false });
        if (!result.flag) return errorResp(c, result.text || '操作失败', 500);
        return successResp(c);
    });

    // POST /api/admin/storage/load_all — 重新加载所有存储
    app.post('/api/admin/storage/load_all', async (c: Context): Promise<any> => {
        const mountManage = new MountManage(c);
        const result = await mountManage.select();
        if (!result.flag) return errorResp(c, result.text || '查询失败', 500);

        for (const mount of (result.data || []) as any[]) {
            if (mount.is_enabled) {
                try { await mountManage.reload(mount.mount_path); }
                catch (e) { console.error(`重新加载 ${mount.mount_path} 失败:`, e); }
            }
        }
        return successResp(c);
    });

    // ============================================================
    // 驱动信息 /api/admin/driver/*
    // ============================================================

    // GET /api/admin/driver/list
    app.get('/api/admin/driver/list', async (c: Context): Promise<any> => {
        const mountManage = new MountManage(c);
        const result = await mountManage.driver();
        if (!result.flag) return errorResp(c, result.text || '查询失败', 500);
        return successResp(c, result.data || []);
    });

    // GET /api/admin/driver/names
    app.get('/api/admin/driver/names', async (c: Context): Promise<any> => {
        const mountManage = new MountManage(c);
        const result = await mountManage.driver();
        if (!result.flag) return errorResp(c, result.text || '查询失败', 500);
        const names = (result.data || []).map((d: any) => d.name || d.mount_type || d);
        return successResp(c, names);
    });

    // GET /api/admin/driver/info?driver=xxx
    app.get('/api/admin/driver/info', async (c: Context): Promise<any> => {
        const driverName = c.req.query('driver') || '';
        if (!driverName) return errorResp(c, 'driver 不能为空', 400);

        const mountManage = new MountManage(c);
        const result = await mountManage.driver();
        if (!result.flag) return errorResp(c, result.text || '查询失败', 500);

        const driver = (result.data || []).find((d: any) => (d.name || d.mount_type || d) === driverName);
        if (!driver) return errorResp(c, '驱动不存在', 404);
        return successResp(c, driver);
    });

    // ============================================================
    // 系统设置 /api/admin/setting/*
    // ============================================================

    // GET /api/admin/setting/list
    app.get('/api/admin/setting/list', async (c: Context): Promise<any> => {
        const group = c.req.query('group');
        const adminManage = new AdminManage(c);
        const result = await adminManage.select();
        if (!result.flag) return errorResp(c, result.text || '查询失败', 500);

        let settings = (result.data || []) as any[];
        if (group) {
            settings = settings.filter((s: any) => s.admin_group === group || s.group === group);
        }

        return successResp(c, settings.map((s: any) => ({
            key: s.admin_keys,
            value: s.admin_data,
            type: s.admin_type || 'string',
            group: s.admin_group || 'general',
            flag: s.admin_flag || 0,
        })));
    });

    // GET /api/admin/setting/get?key=xxx
    app.get('/api/admin/setting/get', async (c: Context): Promise<any> => {
        const key = c.req.query('key') || '';
        if (!key) return errorResp(c, 'key 不能为空', 400);

        const adminManage = new AdminManage(c);
        const result = await adminManage.select();
        if (!result.flag) return errorResp(c, result.text || '查询失败', 500);

        const setting = (result.data || []).find((s: any) => s.admin_keys === key);
        if (!setting) return errorResp(c, '设置项不存在', 404);

        return successResp(c, {
            key: (setting as any).admin_keys,
            value: (setting as any).admin_data,
            type: (setting as any).admin_type || 'string',
        });
    });

    // POST /api/admin/setting/save — 批量保存设置
    app.post('/api/admin/setting/save', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        // 兼容多种请求体格式：
        //  1. 直接数组        [{ key, value }, ...]            —— Go 风格
        //  2. { settings }    { settings: [{ key, value }] }   —— Go 风格批量
        //  3. { items }       { items: [{ admin_keys, admin_data }] }
        //  4. 单条对象        { admin_keys, admin_data }       —— TSWorker 风格
        let settings: any = Array.isArray(body) ? body : (body.settings || body.items);
        if (!Array.isArray(settings) && (body.admin_keys || body.key)) {
            settings = [body];
        }
        if (!Array.isArray(settings) || settings.length === 0) return errorResp(c, '请求体应为设置数组', 400);

        const adminManage = new AdminManage(c);
        const items = settings.map((s: any) => ({
            admin_keys: s.key || s.admin_keys,
            admin_data: s.value !== undefined ? s.value : s.admin_data,
        }));

        const result = await adminManage.batchConfig(items);
        if (!result.flag) return errorResp(c, result.text || '保存失败', 500);
        return successResp(c);
    });

    // POST /api/admin/setting/delete?key=xxx
    app.post('/api/admin/setting/delete', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const key = body.key || c.req.query('key') || '';
        if (!key) return errorResp(c, 'key 不能为空', 400);

        const adminManage = new AdminManage(c);
        await adminManage.remove(key);
        return successResp(c);
    });

    // POST /api/admin/setting/default — 恢复默认设置（对齐Go后端）
    app.post('/api/admin/setting/default', async (c: Context): Promise<any> => {
        const adminManage = new AdminManage(c);
        const result = await adminManage.resetAll();
        if (!result.flag) return errorResp(c, result.text || '恢复默认失败', 500);
        return successResp(c);
    });

    // POST /api/admin/setting/reset_token — 重置 token
    // 安全修复 SEC-06: 不在响应中返回密钥值，防止密钥被日志/CDN记录
    app.post('/api/admin/setting/reset_token', async (c: Context): Promise<any> => {
        const newSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        const adminManage = new AdminManage(c);
        await adminManage.config('jwt_secret', newSecret);
        // 仅返回成功状态，不暴露密钥值
        return successResp(c, { message: 'Token重置成功，新密钥已保存，所有已登录用户需要重新登录' });
    });

    // GET /api/admin/setting/backup — 导出全部配置数据
    app.get('/api/admin/setting/backup', async (c: Context): Promise<any> => {
        const db = new SavesManage(c);
        const backup: Record<string, any[]> = {};
        for (const main of Object.keys(BACKUP_TABLES)) {
            try {
                const r = await db.find({ main, keys: {} });
                backup[main] = r.data || [];
            } catch {
                backup[main] = [];
            }
        }
        return successResp(c, backup);
    });

    // POST /api/admin/setting/restore — 从备份数据恢复（按主键 upsert，不删除多余记录）
    app.post('/api/admin/setting/restore', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const backup = body.backup_data || body;
        if (!backup || typeof backup !== 'object') return errorResp(c, '备份数据无效', 400);

        const db = new SavesManage(c);
        for (const main of Object.keys(BACKUP_TABLES)) {
            const records = backup[main];
            if (!Array.isArray(records)) continue;
            const keyField = BACKUP_TABLES[main];
            for (const rec of records) {
                if (!rec || typeof rec !== 'object') continue;
                const keyVal = rec[keyField];
                if (!keyVal) continue;
                try {
                    await db.save({ main, keys: { [keyField]: keyVal }, data: rec });
                } catch (e) {
                    console.error(`恢复 ${main}/${keyVal} 失败:`, e);
                }
            }
        }
        return successResp(c, { message: '数据恢复成功' });
    });

    // ============================================================
    // 路径元数据 /api/admin/meta/*
    // 字段映射（Go后端 → TSWorker内部）：
    //   id(number)     → 按列表顺序生成（mates_name/path 作为唯一标识）
    //   path           → mates_name
    //   password       → mates_pass
    //   write(bool)    → dir_shared(0/1)
    //   hide(string)   → dir_hidden(0/1)（Go后端hide为正则字符串，TSWorker简化为bool）
    //   p_sub          → p_sub
    //   w_sub          → w_sub
    //   h_sub          → h_sub
    //   readme         → readme
    //   r_sub          → readme_sub
    //   header         → header
    //   header_sub     → header_sub
    // ============================================================

    /** 将 TSWorker 内部 meta 对象转换为 Go 后端风格响应 */
    function toGoMeta(m: any, id: number): any {
        return {
            id,
            path: m.mates_name,
            password: m.mates_pass || '',
            p_sub: m.p_sub ?? false,
            write: !!(m.dir_shared),
            w_sub: m.w_sub ?? false,
            hide: m.dir_hidden ? m.hide_pattern || '' : '',
            h_sub: m.h_sub ?? false,
            readme: m.readme || '',
            r_sub: m.readme_sub ?? false,
            header: m.header || '',
            header_sub: m.header_sub ?? false,
            // 补充 TSWorker 字段（兼容前端 PathRules）
            mates_name: m.mates_name,
            mates_mask: m.mates_mask ?? 0,
            mates_user: m.mates_user ?? 0,
            is_enabled: m.is_enabled ?? 1,
            dir_hidden: m.dir_hidden ?? 0,
            dir_shared: m.dir_shared ?? 0,
            set_zipped: m.set_zipped || '',
            set_parted: m.set_parted || '',
            crypt_name: m.crypt_name || '',
            cache_time: m.cache_time ?? 0,
        };
    }

    /** 根据 id(number) 或 path(string) 查找 meta，返回 [meta对象, id] */
    async function findMetaByIdOrPath(matesManage: MatesManage, idOrPath: string): Promise<[any, number] | null> {
        const idNum = parseInt(idOrPath);
        if (!isNaN(idNum) && idNum > 0) {
            // 按顺序 id 查找
            const all = await matesManage.select();
            if (!all.flag || !all.data) return null;
            const item = all.data[idNum - 1] as any;
            return item ? [item, idNum] : null;
        }
        // 按 path 查找
        const result = await matesManage.select(idOrPath);
        if (!result.flag || !result.data || result.data.length === 0) return null;
        // 获取全列表以确定 id
        const all = await matesManage.select();
        const idx = (all.data as any[]).findIndex((m: any) => m.mates_name === idOrPath);
        return idx >= 0 ? [result.data[0], idx + 1] : [result.data[0], 1];
    }

    // GET /api/admin/meta/list
    app.get('/api/admin/meta/list', async (c: Context): Promise<any> => {
        const page = parseInt(c.req.query('page') || '1');
        const perPage = parseInt(c.req.query('per_page') || '30');

        const matesManage = new MatesManage(c);
        const result = await matesManage.select();
        if (!result.flag) return errorResp(c, result.text || '查询失败', 500);

        const all = result.data || [];
        const total = all.length;
        const start = (page - 1) * perPage;
        const content = all.slice(start, start + perPage).map((m: any, idx: number) =>
            toGoMeta(m, start + idx + 1)
        );

        return successResp(c, { content, total });
    });

    // GET /api/admin/meta/get?id=xxx
    app.get('/api/admin/meta/get', async (c: Context): Promise<any> => {
        const idOrPath = c.req.query('id') || c.req.query('path') || '';
        if (!idOrPath) return errorResp(c, 'id 不能为空', 400);

        const matesManage = new MatesManage(c);
        const found = await findMetaByIdOrPath(matesManage, idOrPath);
        if (!found) return errorResp(c, '元数据不存在', 404);

        return successResp(c, toGoMeta(found[0], found[1]));
    });

    // POST /api/admin/meta/create
    // Body (Go):   { path, password?, write?, w_sub?, p_sub?, hide?, h_sub?, readme?, r_sub?, header?, header_sub? }
    // Body (前端): { mates_name, mates_mask?, mates_user?, is_enabled?, dir_hidden?, dir_shared?, set_zipped?, set_parted?, crypt_name?, cache_time? }
    app.post('/api/admin/meta/create', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const path = body.path ?? body.mates_name;
        if (!path) return errorResp(c, 'path 不能为空', 400);

        const matesManage = new MatesManage(c);
        const result = await matesManage.create({
            mates_name: path,
            mates_mask: body.mates_mask ?? (body.write ? 1 : 0),
            mates_user: body.mates_user ?? 0,
            is_enabled: body.is_enabled ?? 1,
            dir_hidden: body.dir_hidden ?? (body.hide ? 1 : 0),
            dir_shared: body.dir_shared ?? (body.write ? 1 : 0),
            mates_pass: body.password || body.mates_pass || '',
            p_sub: body.p_sub ?? false,
            w_sub: body.w_sub ?? false,
            h_sub: body.h_sub ?? false,
            hide_pattern: typeof (body.hide ?? body.dir_hidden) === 'string' ? (body.hide ?? body.dir_hidden) : '',
            readme: body.readme || '',
            readme_sub: body.r_sub ?? false,
            header: body.header || '',
            header_sub: body.header_sub ?? false,
            set_zipped: body.set_zipped || '',
            set_parted: body.set_parted || '',
            crypt_name: body.crypt_name || '',
            cache_time: body.cache_time ?? 0,
        } as any);

        if (!result.flag) return errorResp(c, result.text || '创建失败', 500);
        return successResp(c);
    });

    // POST /api/admin/meta/update
    // Body (Go):   { id, path?, password?, write?, w_sub?, p_sub?, hide?, h_sub?, readme?, r_sub?, header?, header_sub? }
    // Body (前端): { mates_name, mates_mask?, is_enabled?, dir_hidden?, dir_shared?, set_zipped?, set_parted?, crypt_name?, cache_time? }
    app.post('/api/admin/meta/update', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const idOrPath = body.id !== undefined ? String(body.id) : (body.path || body.mates_name || '');
        if (!idOrPath) return errorResp(c, 'id 不能为空', 400);

        const matesManage = new MatesManage(c);
        const found = await findMetaByIdOrPath(matesManage, idOrPath);
        if (!found) return errorResp(c, '元数据不存在', 404);

        const existing = found[0] as any;
        const updateData: any = { mates_name: existing.mates_name };
        if (body.password !== undefined || body.mates_pass !== undefined) updateData.mates_pass = body.password ?? body.mates_pass;
        if (body.write !== undefined || body.dir_shared !== undefined) updateData.dir_shared = (body.write ?? body.dir_shared) ? 1 : 0;
        if (body.w_sub !== undefined) updateData.w_sub = body.w_sub;
        if (body.p_sub !== undefined) updateData.p_sub = body.p_sub;
        if (body.hide !== undefined || body.dir_hidden !== undefined) {
            const hideVal = body.hide ?? body.dir_hidden;
            updateData.dir_hidden = hideVal ? 1 : 0;
            if (typeof hideVal === 'string') updateData.hide_pattern = hideVal;
        }
        if (body.h_sub !== undefined) updateData.h_sub = body.h_sub;
        if (body.readme !== undefined) updateData.readme = body.readme;
        if (body.r_sub !== undefined) updateData.readme_sub = body.r_sub;
        if (body.header !== undefined) updateData.header = body.header;
        if (body.header_sub !== undefined) updateData.header_sub = body.header_sub;
        if (body.mates_mask !== undefined) updateData.mates_mask = body.mates_mask;
        if (body.mates_user !== undefined) updateData.mates_user = body.mates_user;
        if (body.is_enabled !== undefined) updateData.is_enabled = body.is_enabled;
        if (body.set_zipped !== undefined) updateData.set_zipped = body.set_zipped;
        if (body.set_parted !== undefined) updateData.set_parted = body.set_parted;
        if (body.crypt_name !== undefined) updateData.crypt_name = body.crypt_name;
        if (body.cache_time !== undefined) updateData.cache_time = body.cache_time;

        const result = await matesManage.config({ ...existing, ...updateData });
        if (!result.flag) return errorResp(c, result.text || '更新失败', 500);
        return successResp(c);
    });

    // POST /api/admin/meta/delete?id=xxx
    app.post('/api/admin/meta/delete', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const idOrPath = body.id !== undefined ? String(body.id) : (body.path || body.mates_name || c.req.query('id') || '');
        if (!idOrPath) return errorResp(c, 'id 不能为空', 400);

        const matesManage = new MatesManage(c);
        const found = await findMetaByIdOrPath(matesManage, idOrPath);
        if (!found) return errorResp(c, '元数据不存在', 404);

        const result = await matesManage.remove(found[0].mates_name);
        if (!result.flag) return errorResp(c, result.text || '删除失败', 500);
        return successResp(c);
    });

    // ============================================================
    // 加密配置管理 /api/admin/crypt/*
    // ============================================================

    // GET /api/admin/crypt/list — 查询所有加密配置
    app.get('/api/admin/crypt/list', async (c: Context): Promise<any> => {
        const cryptManage = new CryptManage(c);
        const result = await cryptManage.select();
        return successResp(c, result.data || []);
    });

    // POST /api/admin/crypt/create — 创建加密配置
    app.post('/api/admin/crypt/create', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const cryptManage = new CryptManage(c);
        const result = await cryptManage.create(body as any);
        if (!result.flag) return errorResp(c, result.text || '操作失败', 400);
        return successResp(c);
    });

    // POST /api/admin/crypt/update — 更新加密配置
    app.post('/api/admin/crypt/update', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const cryptManage = new CryptManage(c);
        const result = await cryptManage.config(body as any);
        if (!result.flag) return errorResp(c, result.text || '操作失败', 400);
        return successResp(c);
    });

    // POST /api/admin/crypt/delete — 删除加密配置
    app.post('/api/admin/crypt/delete', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const { crypt_name } = body;
        if (!crypt_name) return errorResp(c, 'crypt_name 不能为空', 400);
        const cryptManage = new CryptManage(c);
        const result = await cryptManage.remove(crypt_name);
        if (!result.flag) return errorResp(c, result.text || '操作失败', 400);
        return successResp(c);
    });

    // POST /api/admin/crypt/status — 切换加密配置状态
    app.post('/api/admin/crypt/status', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const { crypt_name, is_enabled } = body;
        if (!crypt_name) return errorResp(c, 'crypt_name 不能为空', 400);
        const cryptManage = new CryptManage(c);
        const result = await cryptManage.toggleStatus(crypt_name, is_enabled);
        if (!result.flag) return errorResp(c, result.text || '操作失败', 400);
        return successResp(c);
    });

    // ============================================================
    // 连接令牌管理 /api/admin/token/*
    // ============================================================

    // GET /api/admin/token/list — 查询所有令牌
    app.get('/api/admin/token/list', async (c: Context): Promise<any> => {
        const tokenManage = new TokenManage(c);
        const result = await tokenManage.select();
        return successResp(c, result.data || []);
    });

    // POST /api/admin/token/user — 按用户查询令牌
    app.post('/api/admin/token/user', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const { token_user } = body;
        if (!token_user) return errorResp(c, 'token_user 不能为空', 400);
        const tokenManage = new TokenManage(c);
        const result = await tokenManage.getByUser(token_user as string);
        if (!result.flag) return errorResp(c, result.text || '操作失败', 400);
        return successResp(c, result.data || []);
    });

    // POST /api/admin/token/create — 创建令牌
    app.post('/api/admin/token/create', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const tokenManage = new TokenManage(c);
        const result = await tokenManage.create(body as any);
        if (!result.flag) return errorResp(c, result.text || '操作失败', 400);
        return successResp(c);
    });

    // POST /api/admin/token/config — 更新令牌
    app.post('/api/admin/token/config', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const tokenManage = new TokenManage(c);
        const result = await tokenManage.config(body as any);
        if (!result.flag) return errorResp(c, result.text || '操作失败', 400);
        return successResp(c);
    });

    // POST /api/admin/token/remove — 删除令牌
    app.post('/api/admin/token/remove', async (c: Context): Promise<any> => {
        const body = await parseBody(c);
        const { token_uuid } = body;
        if (!token_uuid) return errorResp(c, 'token_uuid 不能为空', 400);
        const tokenManage = new TokenManage(c);
        const result = await tokenManage.remove(token_uuid as string);
        if (!result.flag) return errorResp(c, result.text || '操作失败', 400);
        return successResp(c);
    });

    // ============================================================
    // 媒体库 /api/admin/media/*
    // ============================================================

    // GET /api/admin/media/list/:type — 获取媒体文件列表
    app.get('/api/admin/media/list/:type', async (c: Context): Promise<any> => {
        const mediaType = c.req.param('type') as any;
        const page = parseInt(c.req.query('page') || '1');
        const pageSize = parseInt(c.req.query('pageSize') || '50');
        const keyword = c.req.query('keyword') || '';
        const mediaManage = new MediaManage(c);
        const result = await mediaManage.listScanPaths(mediaType);
        if (!result.flag) return errorResp(c, result.text || '操作失败', 400);
        return successResp(c, result.data);
    });

    // GET /api/admin/media/stats — 获取媒体库统计
    app.get('/api/admin/media/stats', async (c: Context): Promise<any> => {
        const mediaManage = new MediaManage(c);
        const progress = await mediaManage.getScanProgress();
        return successResp(c, progress);
    });
}
