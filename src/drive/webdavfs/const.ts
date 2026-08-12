/** =========== WebDAV 常量定义 ================
 * 本文件定义了WebDAV云存储服务的常量配置，包括：
 * - Vendor类型（SharePoint、其他WebDAV服务）
 * - 默认配置参数
 * =========================================================
 * @author "OpenList Team"
 * @version 25.11.21
 * =======================================================*/

//====== WebDAV Vendor 类型 ======
export enum WebDAVVendor {
	SHAREPOINT = "sharepoint",
	JIANGUOYUN = "jianguoyun",   // 坚果云：根路径为 /dav，使用应用专用密码 Basic 认证
	OTHER = "other",
}

//====== 默认配置 ======
export const DEFAULT_ROOT_PATH = "/";

//====== 请求超时时间（毫秒）======
export const REQUEST_TIMEOUT = 30000;
