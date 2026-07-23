export interface ArmtekApiConfig {
  login: string;
  password: string;
  vkorg?: string;
  kunnrRg?: string;
  kunnrZa?: string;
  incoterms?: string;
  vbeln?: string;
  program?: string;
  queryType: string;
}

export interface StpartsApiConfig {
  url: URL;
  login: string;
  password: string;
}

export function getStateFilePath(fileName: string): string {
  const configuredStateDir = process.env.STATE_DIR?.trim();
  const stateDir = configuredStateDir ? resolve(configuredStateDir) : resolve(process.cwd(), ".state");
  return resolve(stateDir, fileName);
}

export function getArmtekApiConfig(): ArmtekApiConfig | null {
  const login = process.env.ARMTEK_LOGIN?.trim();
  const password = process.env.ARMTEK_PASSWORD?.trim();

  if (!login || !password) {
    return null;
  }

  return {
    login,
    password,
    vkorg: process.env.ARMTEK_VKORG?.trim(),
    kunnrRg: process.env.ARMTEK_KUNNR_RG?.trim(),
    kunnrZa: process.env.ARMTEK_KUNNR_ZA?.trim(),
    incoterms: process.env.ARMTEK_INCOTERMS?.trim(),
    vbeln: process.env.ARMTEK_VBELN?.trim(),
    program: process.env.ARMTEK_PROGRAM?.trim(),
    queryType: process.env.ARMTEK_QUERY_TYPE?.trim() || "1",
  };
}

export function getStpartsApiConfig(credentials?: { login: string; password: string }): StpartsApiConfig | null {
  const login = credentials?.login.trim() || process.env.STPARTS_API_LOGIN?.trim();
  const password = credentials?.password || process.env.STPARTS_API_PASSWORD;
  const configuredUrl = process.env.STPARTS_API_URL?.trim() || "https://stpartsru.public.api.abcp.ru/";

  if (!login || !password) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "stpartsru.public.api.abcp.ru") {
    return null;
  }

  return { url, login, password };
}
import { resolve } from "node:path";
