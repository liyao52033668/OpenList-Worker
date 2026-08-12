/**
 * uuid 模块类型声明（项目使用 uuid v4）
 * 解决 TS7016: Could not find a declaration file for module 'uuid'
 */
declare module 'uuid' {
  export function v4(): string;
  export function v1(): string;
  export function v7(): string;
  export function v3(name: string, namespace: string): string;
  export function v5(name: string, namespace: string): string;
  export const NIL: string;
  export function parse(uuid: string): Uint8Array;
  export function stringify(arr: Uint8Array): string;
}
