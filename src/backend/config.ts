export interface RosskoApiConfig {
  key1: string;
  key2: string;
  deliveryId: string;
  addressId?: string;
}

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

export function getStateFilePath(fileName: string): string {
  const configuredStateDir = process.env.STATE_DIR?.trim();
  const stateDir = configuredStateDir ? resolve(configuredStateDir) : resolve(process.cwd(), ".state");
  return resolve(stateDir, fileName);
}

export function getRosskoApiConfig(): RosskoApiConfig | null {
  const key1 = process.env.ROSSKO_KEY1?.trim();
  const key2 = process.env.ROSSKO_KEY2?.trim();
  const deliveryId = process.env.ROSSKO_DELIVERY_ID?.trim();
  const addressId = process.env.ROSSKO_ADDRESS_ID?.trim();

  if (!key1 || !key2 || !deliveryId) {
    return null;
  }

  return {
    key1,
    key2,
    deliveryId,
    addressId,
  };
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
import { resolve } from "node:path";
