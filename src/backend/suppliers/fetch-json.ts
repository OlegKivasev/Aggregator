import { SupplierIntegrationError } from "./errors.ts";

export function isJsonContentType(value: string | null | undefined): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.startsWith("application/") && mediaType.endsWith("+json"));
}

export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
  integrationName: string,
): Promise<unknown> {
  if (!isJsonContentType(response.headers.get("content-type"))) {
    await response.body?.cancel().catch(() => undefined);
    throw new SupplierIntegrationError(`${integrationName} returned an unexpected content type`);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SupplierIntegrationError(`${integrationName} response is too large`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new SupplierIntegrationError(`${integrationName} returned an empty response`);
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new SupplierIntegrationError(`${integrationName} response is too large`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new SupplierIntegrationError(`${integrationName} returned invalid JSON`, { cause: error });
  }
}
