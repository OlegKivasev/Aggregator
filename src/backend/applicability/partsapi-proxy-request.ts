import { Agent, request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { SupplierIntegrationError } from "../errors.ts";
import type { PartsApiProxyConfig } from "./partsapi-proxy-config.ts";

export function requestPartsApiViaProxy(
  url: URL,
  proxy: PartsApiProxyConfig,
  signal: AbortSignal,
  request: typeof httpsRequest = httpsRequest,
): Promise<Response> {
  signal.throwIfAborted();
  if (url.origin !== "https://api.partsapi.ru" || url.username || url.password) throw new SupplierIntegrationError("Unapproved PartsAPI request origin");
  const proxyUrl = new URL(`${proxy.protocol}://${proxy.host}:${proxy.port}`);
  proxyUrl.username = encodeURIComponent(proxy.login);
  proxyUrl.password = encodeURIComponent(proxy.password);
  // Per-request agent: proxy credentials and routing never affect other suppliers.
  const agent = new Agent({ keepAlive: false, maxSockets: 1, proxyEnv: { HTTPS_PROXY: proxyUrl.href } });
  const sockets = new Set<Duplex>();
  const createConnection = agent.createConnection.bind(agent);
  // Node does not yet attach a pending CONNECT socket to the request's agent pool.
  // Track it through the public hook so abort also closes an unfinished tunnel.
  agent.createConnection = (options, callback) => {
    const socket = createConnection(options, callback);
    if (socket) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      if (signal.aborted) socket.destroy();
    }
    return socket;
  };
  return new Promise((resolve, reject) => {
    const close = () => { for (const socket of sockets) socket.destroy(); agent.destroy(); };
    const abort = () => { close(); reject(signal.reason); };
    const cleanup = () => { signal.removeEventListener("abort", abort); close(); };
    signal.addEventListener("abort", abort, { once: true });
    const fail = (error: unknown) => {
      cleanup();
      reject(signal.aborted ? signal.reason : new SupplierIntegrationError("PartsAPI proxy request failed", {
        cause: error, publicMessage: "Не удалось подключиться через прокси PartsAPI. Проверьте адрес, порт и данные доступа.",
      }));
    };
    try {
      const pending = request(url, { agent, signal, headers: { Accept: "application/json" } }, (incoming) => {
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
