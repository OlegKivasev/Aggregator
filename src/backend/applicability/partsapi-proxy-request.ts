import { lookup, type LookupOptions } from "node:dns";
import { request as httpRequest, type ClientRequest } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { isIPv4, type LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import { checkServerIdentity, connect as connectTls } from "node:tls";
import { SupplierIntegrationError } from "../errors.ts";
import { isPublicPartsApiProxyAddress, parsePartsApiProxyConfig, type PartsApiProxyConfig } from "./partsapi-proxy-config.ts";

export function lookupPartsApiProxyAddress(
  hostname: string,
  options: LookupOptions,
  callback: Parameters<LookupFunction>[2],
  resolve: typeof lookup = lookup,
): void {
  resolve(hostname, { family: 4, all: true }, (error, addresses) => {
    if (error) { callback(error, "", 4); return; }
    if (!addresses.length || addresses.some(({ address, family }) => family !== 4 || !isPublicPartsApiProxyAddress(address))) {
      callback(new SupplierIntegrationError("PartsAPI proxy resolved to a non-public address", {
        publicMessage: "Домен прокси должен указывать на публичный IPv4-адрес.",
      }), "", 4);
      return;
    }
    // Return the checked address to this connection: no second DNS lookup can change it.
    callback(null, options.all ? addresses : addresses[0].address, 4);
  });
}

export function requestPartsApiViaProxy(
  url: URL,
  proxy: PartsApiProxyConfig,
  signal: AbortSignal,
  request: typeof httpsRequest = httpsRequest,
  requestProxy: typeof httpsRequest = proxy.protocol === "https" ? httpsRequest : httpRequest,
): Promise<Response> {
  signal.throwIfAborted();
  if (url.origin !== "https://api.partsapi.ru" || url.username || url.password) throw new SupplierIntegrationError("Unapproved PartsAPI request origin");
  const parsed = parsePartsApiProxyConfig(proxy);
  const proxyUrl = new URL(`${parsed.protocol}://${parsed.host}:${parsed.port}`);
  // Per-request agent: proxy credentials and routing never affect other suppliers.
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  const sockets = new Set<Duplex>();
  return new Promise((resolve, reject) => {
    let pending: ClientRequest | undefined;
    let tunnelRequest: ClientRequest | undefined;
    const close = () => {
      tunnelRequest?.destroy();
      pending?.destroy();
      for (const socket of sockets) socket.destroy();
      agent.destroy();
    };
    const abort = () => { close(); reject(signal.reason); };
    const cleanup = () => { signal.removeEventListener("abort", abort); close(); };
    signal.addEventListener("abort", abort, { once: true });
    const fail = (error: unknown) => {
      cleanup();
      reject(signal.aborted ? signal.reason : new SupplierIntegrationError("PartsAPI proxy request failed", {
        cause: error, publicMessage: "Не удалось подключиться через прокси PartsAPI. Проверьте адрес, порт и данные доступа.",
      }));
    };
    const trackSocket = (socket: Duplex) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      if (signal.aborted) socket.destroy();
    };
    // A CONNECT request lets the proxy use the checked DNS result and its own TLS name.
    agent.createConnection = (options, callback) => {
      const authority = `${url.hostname}:443`;
      const headers: Record<string, string> = { Host: authority };
      if (parsed.login) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${parsed.login}:${parsed.password}`).toString("base64")}`;
      try {
        tunnelRequest = requestProxy(proxyUrl, {
          method: "CONNECT", path: authority, headers, agent: false, signal,
          lookup: lookupPartsApiProxyAddress, family: 4, maxHeaderSize: 16 * 1024,
          ...(parsed.protocol === "https" ? { rejectUnauthorized: true, ...(!isIPv4(parsed.host) ? { servername: parsed.host } : {}) } : {}),
        });
        tunnelRequest.once("socket", trackSocket);
        tunnelRequest.once("error", fail);
        tunnelRequest.once("response", (response) => {
          response.destroy();
          fail(new Error("PartsAPI proxy did not establish a tunnel"));
        });
        tunnelRequest.once("connect", (response, tunnel, head) => {
          trackSocket(tunnel);
          if (signal.aborted || response.statusCode !== 200) {
            tunnel.destroy();
            fail(new Error("PartsAPI proxy rejected the tunnel"));
            return;
          }
          try {
            if (head.length) tunnel.unshift(head);
            const secure = connectTls({ ...options, checkServerIdentity, rejectUnauthorized: true, path: undefined, host: url.hostname, port: 443, socket: tunnel, servername: url.hostname }, () => callback?.(null, secure));
            trackSocket(secure);
            secure.once("error", fail);
          } catch (error) { fail(error); }
        });
        tunnelRequest.end();
      } catch (error) { fail(error); }
      return undefined;
    };
    try {
      pending = request(url, { agent, signal, headers: { Accept: "application/json" } }, (incoming) => {
        incoming.once("close", cleanup);
        try {
          const headers = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
          const status = incoming.statusCode ?? 502;
          if ([204, 205, 304].includes(status)) {
            incoming.resume();
            resolve(new Response(null, { status, headers }));
          } else {
            const iterator = incoming[Symbol.asyncIterator]();
            const body = new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const chunk = await iterator.next();
                  if (chunk.done) controller.close();
                  else controller.enqueue(chunk.value);
                } catch (error) { controller.error(error); }
              },
              cancel() { incoming.destroy(); cleanup(); },
            });
            resolve(new Response(body, { status, headers }));
          }
        } catch (error) {
          incoming.destroy();
          fail(error);
        }
      });
      pending.once("error", fail);
      pending.end();
    } catch (error) {
      fail(error);
    }
  });
}
