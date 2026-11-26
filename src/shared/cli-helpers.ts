import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { nonEmpty } from "./schema.js";

export function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} 必须是正整数`);
  }
  return value;
}

export function requirePositiveInt(raw: string, label: string): number {
  return parsePositiveInt(raw, label)!;
}

export function parseNonNegativeInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负整数`);
  }
  return value;
}

export function parseIntOpt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} 必须是整数`);
  }
  return value;
}

export function parseFloatOpt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    throw new Error(`${label} 必须是数字`);
  }
  return value;
}

export function parseUnitFloat(raw: string, label: string): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${label} 必须是 (0, 1] 之间的小数`);
  }
  return value;
}

export function parseIdList(raw: string | undefined, label: string): number[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`${label} 必须是以逗号分隔的正整数列表`);
  }
  const ids = parts.map((p) => Number(p));
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error(`${label} 必须是以逗号分隔的正整数列表`);
  }
  return [...new Set(ids)];
}

export function splitCsvOpt(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

export async function readSystemPromptOption(options: {
  system?: string;
  systemFile?: string;
}): Promise<string | undefined> {
  if (options.system !== undefined && options.systemFile !== undefined) {
    throw new Error("--system 与 --system-file 不能同时指定");
  }
  if (options.system !== undefined) {
    return nonEmpty(options.system, "--system");
  }
  if (options.systemFile !== undefined) {
    return nonEmpty(await readFile(resolve(options.systemFile), "utf8"), "--system-file");
  }
  return undefined;
}

export function formatLocalTimestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function appendTimestampToPath(filePath: string, timestamp: string): string {
  const parsed = parse(filePath);
  return join(parsed.dir, `${parsed.name}-${timestamp}${parsed.ext}`);
}

export async function writeOutputFile(filePath: string, content: string): Promise<string> {
  const resolved = resolve(filePath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, "utf8");
  return resolved;
}
