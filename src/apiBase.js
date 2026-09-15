/**
 * 后端地址。默认同源（后端同时托管前端）；前后端分开部署时用 VITE_API_BASE 指定。
 * 单独成文件是为了让 api.js 与 errorReport 都能引用它，且便于测试替换。
 */
export const API_BASE = String(import.meta.env?.VITE_API_BASE || '').replace(/\/+$/, '');
