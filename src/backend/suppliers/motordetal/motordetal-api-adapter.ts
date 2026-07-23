import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type { NormalizedSearchResult, SearchQuery, SupplierSearchContext, SupplierSessionState } from "../../types.ts";
import { SupplierAuthError } from "../errors.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";
import {
  hasMotorDetalTokenState,
  motorDetalApiRequest,
  motorDetalBaseUrl,
} from "./motordetal-auth.ts";

interface MotorDetalUser {
  customerGroup?: { id?: string | number; zone?: string | number } | null;
  customerGroupId?: string | number | null;
  warehouseId?: string | number | null;
  zone?: string | number | null;
}

interface MotorDetalInitData {
  user?: MotorDetalUser;
  settings?: Record<string, unknown>;
}

interface MotorDetalPrice {
  price?: number | string;
  quantity?: number;
  warehouseGroupId?: string | number;
  warehouseGroupHeader?: string;
  warehouseGroupShortHeader?: string;
  warehouseGroupAddress?: string;
  deliveryDate?: string | null;
}

interface MotorDetalProduct {
  syncUid?: string;
  header?: string;
  fullHeader?: string;
  articul?: string;
  manufacturerHeader?: string;
  supplyTerm?: number | string;
  url?: string;
  prices?: MotorDetalPrice[];
  commercePrice?: { price?: number | string };
}

interface MotorDetalPage {
  content?: MotorDetalProduct[];
}

interface MotorDetalDeliveryDate {
  productUid?: string;
  warehouseGroupId?: string | number;
  deliveryDate?: string | null;
}

function normalizeArticle(value: string): string {
  return value.replace(/[^A-Z0-9А-Я]/gi, "").toUpperCase();
}

function parsePrice(value: string | number | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  if (!value) {
    return null;
  }

  const parsed = Number(value.replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function dateFromSupplyTerm(value: string | number | undefined): string | null {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) {
    return null;
  }

  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + Math.ceil(days)).toISOString();
}

function getSetting(settings: Record<string, unknown> | undefined, names: string[]): string | undefined {
  for (const name of names) {
    const value = settings?.[name];
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
  }

  return undefined;
}

async function getDeliveryDates(products: MotorDetalProduct[], signal: AbortSignal): Promise<Map<string, string>> {
  const productUids = products.map((product) => product.syncUid).filter((value): value is string => Boolean(value));
  const warehouseGroups = [...new Set(products.flatMap((product) => product.prices || []).map((price) => price.warehouseGroupId).filter((value) => value !== undefined))];

  if (!productUids.length || !warehouseGroups.length) {
    return new Map();
  }

  const params = new URLSearchParams({
    products: JSON.stringify(productUids),
    warehouseGroups: JSON.stringify(warehouseGroups),
  });

  const rows = await motorDetalApiRequest<MotorDetalDeliveryDate[]>("delivery-date/", params, signal);
  return new Map(
    rows
      .filter((row) => row.productUid && row.warehouseGroupId !== undefined && row.deliveryDate)
      .map((row) => [`${row.productUid}|${row.warehouseGroupId}`, row.deliveryDate as string]),
  );
}

export class MotorDetalApiAdapter implements SupplierAdapter {
  readonly id = "motordetal";
  readonly displayName = "MotorDetal";
  readonly timeoutMs = Number(process.env.MOTORDETAL_SEARCH_TIMEOUT_MS ?? "15000");

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    if (hasMotorDetalTokenState()) {
      return sessionManager.markChecked(this.id, "MotorDetal stored session is available");
    }

    if (!sessionManager.getMotorDetalCredentials()) {
      return sessionManager.markUnauthorized(this.id, "MotorDetal login and password are not configured");
    }

    return sessionManager.markChecked(this.id, "MotorDetal credentials are available");
  }

  async search(
    query: SearchQuery,
    context: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    _sessionManager: SupplierSessionManager,
  ): Promise<void> {
    try {
      const init = await motorDetalApiRequest<MotorDetalInitData>("init", undefined, context.signal);
      const params = new URLSearchParams({
        keyword: query.article.trim(),
        catalog_id: "0",
        limit: "100",
      });
      const region = init.user?.customerGroup?.id ?? init.user?.customerGroupId ?? getSetting(init.settings, ["region", "regionId"]);
      const zone = init.user?.customerGroup?.zone ?? init.user?.zone ?? getSetting(init.settings, ["zone", "zoneId"]);

      if (region !== undefined && region !== null) {
        params.set("region", String(region));
      }
      if (zone !== undefined && zone !== null) {
        params.set("zone", String(zone));
      }
      if (init.user?.warehouseId !== undefined && init.user.warehouseId !== null) {
        params.set("warehouse", String(init.user.warehouseId));
      }

      const page = await motorDetalApiRequest<MotorDetalPage>("product/filter", params, context.signal);
      const target = normalizeArticle(query.article);
      const products = (page.content || []).filter((product) => normalizeArticle(product.articul || "") === target);
      const deliveryDates = await getDeliveryDates(products, context.signal);
      for (const product of products) {
        const brand = product.manufacturerHeader?.trim();
        const article = product.articul?.trim();
        const title = product.fullHeader?.trim() || product.header?.trim();
        if (!brand || !article || !title) {
          continue;
        }
        const link = product.url
          ? new URL(`/product/${product.url}`, motorDetalBaseUrl).toString()
          : new URL(`/catalog?keyword=${encodeURIComponent(query.article)}&page=1`, motorDetalBaseUrl).toString();
        const prices = product.prices?.length ? product.prices : [{ price: product.commercePrice?.price }];

        for (const offer of prices) {
          const price = parsePrice(offer.price);
          if (price === null || offer.quantity === 0) {
            continue;
          }

          const deliveryDate = offer.deliveryDate || deliveryDates.get(`${product.syncUid}|${offer.warehouseGroupId}`) || dateFromSupplyTerm(product.supplyTerm);
          onResult({
            supplier: this.id,
            brand,
            article,
            title,
            price,
            warehouse: offer.warehouseGroupShortHeader || offer.warehouseGroupHeader || null,
            warehouseFull: offer.warehouseGroupAddress || offer.warehouseGroupHeader || null,
            deliveryDate,
            deliveryDateApproximate: !offer.deliveryDate && !deliveryDates.has(`${product.syncUid}|${offer.warehouseGroupId}`),
            link,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/authoriz|session|token|HTTP 40[13]|доступ|авторизац/i.test(message)) {
        throw new SupplierAuthError(message);
      }
      throw error;
    }
  }
}
