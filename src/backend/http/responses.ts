import type { ServerResponse } from "node:http";
import type { SearchStreamEvent } from "../types.ts";

export const securityHeaders = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export function writeSseEvent(response: ServerResponse, event: SearchStreamEvent): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function serveJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
