import { getRosskoApiConfig, type RosskoApiConfig } from "../../config.ts";
import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type {
  NormalizedSearchResult,
  SearchQuery,
  SupplierSearchContext,
  SupplierSessionState,
} from "../../types.ts";
import { SupplierAuthError } from "../errors.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";

const endpoint = "https://api.rossko.ru/service/v2.1/GetSearch";

interface RosskoStock {
  price: number;
  warehouse: string | null;
  deliveryDays: number | null;
  deliveryDate: string | null;
}

interface RosskoPart {
  article: string;
  title: string;
  stocks: RosskoStock[];
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function extractTagValue(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<[^:>]+:${tag}>([\\s\\S]*?)<\\/[^:>]+:${tag}>`, "i"));
  return match?.[1]?.trim() ?? null;
}

function extractBlocks(block: string, tag: string): string[] {
  return [...block.matchAll(new RegExp(`<[^:>]+:${tag}>([\\s\\S]*?)<\\/[^:>]+:${tag}>`, "gi"))].map(
    (match) => match[1],
  );
}

function parseRosskoResponse(xml: string): RosskoPart[] {
  const success = extractTagValue(xml, "Success");
  const message = extractTagValue(xml, "message");

  if (success?.toLowerCase() !== "true") {
    throw new Error(message ?? "Rossko API returned unsuccessful response");
  }

  return extractBlocks(xml, "Part")
    .map((partBlock) => {
      const article = extractTagValue(partBlock, "partnumber");
      const title = extractTagValue(partBlock, "name");

      if (!article || !title) {
        return null;
      }

      const stocks = extractBlocks(partBlock, "stock")
        .map((stockBlock) => {
          const price = Number(extractTagValue(stockBlock, "price"));
          const deliveryValue = extractTagValue(stockBlock, "delivery");
          const deliveryStart = extractTagValue(stockBlock, "deliveryStart");
          const deliveryEnd = extractTagValue(stockBlock, "deliveryEnd");
          const warehouse =
            extractTagValue(stockBlock, "warehouse") ||
            extractTagValue(stockBlock, "warehouseName") ||
            extractTagValue(stockBlock, "name");

          if (!Number.isFinite(price)) {
            return null;
          }

          return {
            price,
            warehouse,
            deliveryDays:
              deliveryValue !== null && deliveryValue !== "" && Number.isFinite(Number(deliveryValue))
                ? Number(deliveryValue)
                : null,
            deliveryDate: deliveryStart || deliveryEnd || null,
          };
        })
        .filter((stock): stock is RosskoStock => stock !== null);

      return {
        article,
        title,
        stocks,
      };
    })
    .filter((part): part is RosskoPart => part !== null);
}

function buildEnvelope(config: RosskoApiConfig, article: string): string {
  const addressIdBlock = config.addressId
    ? `<api:address_id>${escapeXml(config.addressId)}</api:address_id>`
    : "";

  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:api="http://api.rossko.ru/">
  <soapenv:Body>
    <api:GetSearch>
      <api:KEY1>${escapeXml(config.key1)}</api:KEY1>
      <api:KEY2>${escapeXml(config.key2)}</api:KEY2>
      <api:text>${escapeXml(article)}</api:text>
      <api:delivery_id>${escapeXml(config.deliveryId)}</api:delivery_id>
      ${addressIdBlock}
    </api:GetSearch>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildRosskoPortalLink(article: string): string {
  return `https://portal.rossko.ru/search?text=${encodeURIComponent(article)}`;
}

function deriveDeliveryDate(deliveryDate: string | null, deliveryDays: number | null): string | null {
  if (deliveryDate) {
    return deliveryDate;
  }

  if (deliveryDays === null) {
    return null;
  }

  return new Date(Date.now() + deliveryDays * 24 * 60 * 60 * 1000).toISOString();
}

export class RosskoApiAdapter implements SupplierAdapter {
  readonly id = "rossko";
  readonly displayName = "Rossko";
  readonly timeoutMs = 15000;

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    if (!this.resolveConfig()) {
      return sessionManager.markUnauthorized(
        this.id,
        "ROSSKO_KEY1, ROSSKO_KEY2 и ROSSKO_DELIVERY_ID должны быть заданы для API-режима",
      );
    }

    return sessionManager.markAuthorized(this.id, "Rossko API credentials are configured");
  }

  async search(
    query: SearchQuery,
    context: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    _sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const config = this.resolveConfig();

    if (!config) {
      throw new SupplierAuthError("Rossko API credentials are missing");
    }

    const response = await fetch(endpoint, {
      method: "POST",
      signal: context.signal,
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: "http://api.rossko.ru/GetSearch",
      },
      body: buildEnvelope(config, query.article),
    });

    if (!response.ok) {
      throw new Error(`Rossko API returned HTTP ${response.status}`);
    }

    const xml = await response.text();
    const parts = parseRosskoResponse(xml);
    const exactArticle = query.article.trim().toUpperCase();

    for (const part of parts) {
      if (part.article.trim().toUpperCase() !== exactArticle) {
        continue;
      }

      for (const stock of part.stocks) {
        onResult({
          supplier: this.id,
          brand: "Rossko",
          article: part.article,
          title: part.title,
          price: stock.price,
          warehouse: stock.warehouse,
          deliveryDate: deriveDeliveryDate(stock.deliveryDate, stock.deliveryDays),
          deliveryDateApproximate: false,
          link: buildRosskoPortalLink(part.article),
        });
      }
    }
  }

  private resolveConfig(): RosskoApiConfig | null {
    return getRosskoApiConfig();
  }
}
