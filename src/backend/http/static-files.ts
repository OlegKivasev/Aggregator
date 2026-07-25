import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { securityHeaders, serveJson } from "./responses.ts";

const contentTypes = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

export async function serveStatic(pathname: string, response: ServerResponse, publicDir: string): Promise<void> {
  const filePath = pathname === "/" ? resolve(publicDir, "index.html") : resolve(publicDir, `.${pathname}`);
  if (!filePath.startsWith(`${publicDir}${sep}`)) {
    serveJson(response, 404, { message: "Not found" });
    return;
  }

  try {
    const content = await readFile(filePath);
    const contentType = contentTypes.get(extname(filePath)) ?? "application/octet-stream";
    response.writeHead(200, { ...securityHeaders, "Content-Type": contentType });
    response.end(content);
  } catch {
    serveJson(response, 404, { message: "Not found" });
  }
}
