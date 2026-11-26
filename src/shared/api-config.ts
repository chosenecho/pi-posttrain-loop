import { nonEmpty } from "./schema.js";

export interface ApiCredentialSource {
  baseUrl?: string;
  apiKey?: string;
}

/** Validate an API root without including untrusted URL contents in diagnostics. */
export function normalizeApiBaseUrl(raw: string | undefined, label: string): string {
  const trimmed = nonEmpty(raw, label);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} 必须是有效的 HTTP(S) API 根地址`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} 必须使用 HTTP(S) API 根地址，认证信息请通过 API Key 传入`);
  }
  const normalized = url.href.replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(url.pathname.replace(/\/+$/, ""))) {
    throw new Error(`${label} 请填 API 根地址，不要附带 /chat/completions`);
  }
  return normalized;
}

/** A fallback credential belongs to its API root, including the path, not just its origin. */
export function resolveApiEndpoint(options: {
  baseUrl: string | undefined;
  apiKey?: string;
  fallbacks?: readonly ApiCredentialSource[];
  baseUrlLabel: string;
  apiKeyLabel: string;
  allowEmptyKey?: boolean;
}): { baseUrl: string; apiKey: string } {
  const baseUrl = normalizeApiBaseUrl(options.baseUrl, options.baseUrlLabel);
  if (options.apiKey !== undefined) {
    const apiKey = options.apiKey.trim();
    if (!apiKey && !options.allowEmptyKey) {
      throw new Error(`${options.apiKeyLabel} 必须是非空字符串；无认证服务请显式填写 EMPTY`);
    }
    return { baseUrl, apiKey: apiKey || "EMPTY" };
  }

  let hasFallbackKey = false;
  for (const source of options.fallbacks ?? []) {
    if (!source.apiKey?.trim()) continue;
    hasFallbackKey = true;
    if (!source.baseUrl?.trim()) continue;
    // Invalid donor URLs are configuration errors; never echo their value.
    const donorBaseUrl = normalizeApiBaseUrl(source.baseUrl, "继承密钥的 API 地址");
    if (donorBaseUrl === baseUrl) return { baseUrl, apiKey: source.apiKey.trim() };
  }
  if (hasFallbackKey) {
    throw new Error(`${options.apiKeyLabel} 必须显式配置：API 根地址已变更，主接口密钥只适用于原地址；无认证服务请填写 EMPTY`);
  }
  if (options.allowEmptyKey) return { baseUrl, apiKey: "EMPTY" };
  throw new Error(`${options.apiKeyLabel} 必须是非空字符串；无认证服务请显式填写 EMPTY`);
}
