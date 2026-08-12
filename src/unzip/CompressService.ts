/**
 * 压缩服务 — 类型声明占位
 * PathRuleService 中引用的压缩配置类型
 */
export type CompressMethod = 'zip' | 'tar' | 'tar.gz' | '7z';

export interface CompressConfig {
    method?: CompressMethod;
    level?: number;
    [key: string]: any;
}

export class CompressService {
    // 占位实现，供后续实现压缩/解压功能
    static readonly methods: CompressMethod[] = ['zip', 'tar', 'tar.gz', '7z'];
}
