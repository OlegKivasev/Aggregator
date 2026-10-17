import { createBoundedAbortSignal } from "../abort.ts";
import { validPeerId, type VkChat } from "./encrypted-vk-settings.ts";
import { setTimeout as delay } from "node:timers/promises";

export class VkError extends Error {
  readonly permanent: boolean;
  readonly code: number | null;
  constructor(message = "ВКонтакте временно недоступен. Повторим отправку позже.", permanent = false, code: number | null = null) {
    super(message); this.permanent = permanent; this.code = code;
  }
}
export interface VkLongPollSession { server: string; key: string; ts: string }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VkError("ВКонтакте вернул некорректный ответ.");
  return value as Record<string, unknown>;
};
const validTimestamp = (value: unknown): value is string => typeof value === "string" && /^\d{1,32}$/.test(value);
function longPollSession(value: unknown): VkLongPollSession {
  const data = object(value);
  if (typeof data.server !== "string" || data.server.length > 2_000 || typeof data.key !== "string"
    || data.key.length < 1 || data.key.length > 512 || /[\u0000-\u001f\u007f]/.test(data.key) || !validTimestamp(data.ts)) throw new VkError("Не удалось проверить сервер Long Poll ВК.");
  let url: URL;
  try { url = new URL(data.server); } catch { throw new VkError("Не удалось проверить сервер Long Poll ВК."); }
  if (url.protocol !== "https:" || url.hostname !== "lp.vk.com" || url.port || url.username || url.password || url.search || url.hash
    || !/^\/[A-Za-z0-9/_-]{1,256}$/.test(url.pathname)) throw new VkError("ВК вернул недопустимый адрес Long Poll.");
  return { server: url.href, key: data.key, ts: data.ts };
}
async function readResponse(response: Response, longPoll = false): Promise<Record<string, unknown>> {
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!response.ok || !(type === "application/json" || longPoll && (type === "text/javascript" || type === "application/javascript")) || !response.body) {
    await response.body?.cancel(); throw new VkError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break; size += part.value.length;
      if (size > 2_097_152) { await reader.cancel(); throw new VkError("Ответ ВКонтакте превышает допустимый размер."); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export class VkClient {
  private readonly request: typeof fetch;
  constructor(request: typeof fetch = fetch) { this.request = request; }
  private async call(method: string, token: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    const bounded = createBoundedAbortSignal(signal, 12_000, "VK request timed out");
    try {
      bounded.signal.throwIfAborted();
      const response = await this.request(`https://api.vk.com/method/${method}`, { method: "POST", redirect: "error", signal: bounded.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ ...params, access_token: token, v: "5.199" }) });
      const payload = await readResponse(response);
      if (payload.error !== undefined) {
        const code = object(payload.error).error_code;
        if (code === 5 || code === 27 || code === 28) throw new VkError("ВКонтакте отклонил ключ сообщества. Проверьте подключение.", true, code);
        if ([7, 15, 901, 902, 917, 925, 945, 946].includes(Number(code))) throw new VkError("У сообщества нет права отправлять сообщения в выбранную беседу.", true, Number(code));
        if (method.startsWith("groups.getLongPoll") && code === 100) throw new VkError("В сообществе ВК откройте «Работа с API → Long Poll API», включите Long Poll и входящие сообщения в типах событий.", true, 100);
        throw new VkError();
      }
      if (!("response" in payload)) throw new VkError("ВКонтакте вернул некорректный ответ.");
      return payload.response;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (bounded.signal.aborted) throw new VkError("ВКонтакте не ответил вовремя. Повторим отправку позже.");
      if (error instanceof VkError) throw error;
      throw new VkError();
    } finally { bounded.dispose(); }
  }

  async prepareChatPairing(token: string, groupId: number, signal: AbortSignal): Promise<VkLongPollSession> {
    let settings: Record<string, unknown>;
    try { settings = object(await this.call("groups.getLongPollSettings", token, { group_id: String(groupId) }, signal)); }
    catch (error) {
      if (error instanceof VkError && error.code === 7) throw new VkError("Нет доступа к настройкам Long Poll ВК. Проверьте право ключа на сообщения и раздел сообщества «Работа с API → Long Poll API».", true);
      throw error;
    }
    if (typeof settings.is_enabled !== "boolean") throw new VkError("Не удалось проверить настройки Long Poll ВК.");
    const events = object(settings.events);
    if (!settings.is_enabled || events.message_new !== 1 && events.message_new !== true) {
      throw new VkError("В сообществе ВК откройте «Работа с API → Long Poll API», включите Long Poll и входящие сообщения в типах событий.", true);
    }
    if (settings.api_version !== "5.199") throw new VkError("В настройках Long Poll API сообщества выберите версию 5.199 и сохраните изменения.", true);
    return this.longPollServer(token, groupId, signal);
  }
  private async longPollServer(token: string, groupId: number, signal: AbortSignal): Promise<VkLongPollSession> {
    return longPollSession(await this.call("groups.getLongPollServer", token, { group_id: String(groupId) }, signal));
  }
  async waitForChat(token: string, groupId: number, command: string, initial: VkLongPollSession, signal: AbortSignal): Promise<VkChat> {
    let session = longPollSession(initial); let refreshes = 0;
    for (let attempt = 0; attempt < 120; attempt++) {
      signal.throwIfAborted();
      const url = new URL(session.server);
      url.search = new URLSearchParams({ act: "a_check", key: session.key, ts: session.ts, wait: "25" }).toString();
      const bounded = createBoundedAbortSignal(signal, 30_000, "VK Long Poll timed out");
      let page: Record<string, unknown>;
      try {
        page = await readResponse(await this.request(url.href, { method: "GET", redirect: "error", signal: bounded.signal, headers: { Accept: "application/json" } }), true);
        bounded.signal.throwIfAborted();
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw error instanceof VkError ? error : new VkError("Не удалось получить сообщение из ВК. Начните подключение беседы заново.");
      } finally { bounded.dispose(); }
      if (page.failed !== undefined) {
        if (page.failed === 1 && validTimestamp(page.ts)) session = { ...session, ts: page.ts };
        else if ((page.failed === 2 || page.failed === 3) && refreshes++ < 2) session = await this.longPollServer(token, groupId, signal);
        else throw new VkError("Сеанс Long Poll ВК прерван. Начните подключение беседы заново.");
      } else {
        if (!validTimestamp(page.ts) || !Array.isArray(page.updates) || page.updates.length > 10_000) throw new VkError("ВК вернул некорректные события Long Poll.");
        session = { ...session, ts: page.ts };
        for (const value of page.updates) {
          const event = object(value);
          if (event.type !== "message_new" || event.group_id !== groupId) continue;
          const message = object(object(event.object).message);
          if (!validPeerId(message.peer_id) || !Number.isSafeInteger(message.from_id) || Number(message.from_id) <= 0 || message.out !== 0
            || typeof message.text !== "string" || message.text.length > 2_000) continue;
          const text = message.text.trim().replace(new RegExp(`^\\[club${groupId}\\|[^\\]\\r\\n]{1,200}\\]\\s*`), "");
          if (text === command) return this.pairedChat(token, groupId, message.peer_id, signal);
        }
      }
      await delay(400, undefined, { signal });
    }
    throw new VkError("Не удалось дождаться команды. Начните подключение беседы заново.");
  }
  private async pairedChat(token: string, groupId: number, peerId: number, signal: AbortSignal): Promise<VkChat> {
    try {
      const data = object(await this.call("messages.getConversationsById", token, { peer_ids: String(peerId), group_id: String(groupId) }, signal));
      if (!Array.isArray(data.items) || data.items.length !== 1) throw new VkError("ВК не подтвердил беседу.");
      const conversation = object(data.items[0]); const peer = object(conversation.peer);
      if (peer.id !== peerId || peer.type !== "chat") throw new VkError("ВК не подтвердил беседу.");
      if (conversation.chat_settings !== undefined) {
        const settings = object(conversation.chat_settings);
        if (settings.state !== "in" || typeof settings.title !== "string" || settings.title.length > 200) throw new VkError("Не удалось проверить участие бота в беседе.");
        return { id: peerId, title: settings.title };
      }
    } catch (error) {
      // The authenticated incoming event identifies the chat. Reading its title can require extra chat permissions.
      if (!(error instanceof VkError) || error.code !== 917 && error.code !== 7) throw error;
    }
    return { id: peerId, title: `ID ${peerId}` };
  }

  async connect(token: string, signal: AbortSignal): Promise<{ groupId: number; groupName: string; chats: VkChat[]; complete: boolean }> {
    // This method accepts community tokens only; a personal account token is rejected.
    await this.call("groups.getTokenPermissions", token, {}, signal);
    const response = await this.call("groups.getById", token, {}, signal);
    const groups = Array.isArray(response) ? response : object(response).groups;
    if (!Array.isArray(groups) || groups.length !== 1) throw new VkError("Не удалось определить сообщество по ключу.", true);
    const group = object(groups[0]);
    if (!Number.isSafeInteger(group.id) || Number(group.id) <= 0 || typeof group.name !== "string" || group.name.length > 200) throw new VkError("Не удалось определить сообщество по ключу.", true);
    const chats: VkChat[] = [];
    for (let offset = 0; offset < 1_000; offset += 50) {
      const page = object(await this.call("messages.getConversations", token, { count: "50", offset: String(offset), filter: "all", group_id: String(group.id) }, signal));
      if (!Array.isArray(page.items) || !Number.isSafeInteger(page.count) || Number(page.count) < 0 || page.items.length > 50) throw new VkError("Не удалось получить список бесед.");
      for (const item of page.items) {
        const conversation = object(object(item).conversation); const peer = object(conversation.peer);
        if (peer.type !== "chat") continue;
        const settings = object(conversation.chat_settings);
        if (settings.state !== "in" || object(conversation.can_write).allowed !== true) continue;
        if (!validPeerId(peer.id) || typeof settings.title !== "string" || settings.title.length > 200) throw new VkError("Не удалось проверить беседу.");
        if (!chats.some((chat) => chat.id === peer.id)) chats.push({ id: peer.id, title: settings.title });
      }
      if (offset + page.items.length >= Number(page.count)) return { groupId: Number(group.id), groupName: group.name, chats, complete: true };
      if (page.items.length !== 50) throw new VkError("ВКонтакте вернул неполный список бесед.");
      await delay(100, undefined, { signal });
    }
    return { groupId: Number(group.id), groupName: group.name, chats, complete: false };
  }

  async send(token: string, groupId: number, peerId: number, text: string, randomId: number, signal: AbortSignal): Promise<void> {
    const result = await this.call("messages.send", token, { peer_ids: String(peerId), group_id: String(groupId), message: text,
      random_id: String(randomId), dont_parse_links: "1", disable_mentions: "1" }, signal);
    if (!Array.isArray(result) || result.length !== 1) throw new VkError("ВКонтакте не подтвердил отправку сообщения.");
    const receipt = object(result[0]);
    if (receipt.peer_id !== peerId) throw new VkError("ВКонтакте не подтвердил получателя сообщения.");
    if (receipt.error !== undefined) {
      const code = Number(object(receipt.error).code);
      throw new VkError("ВКонтакте не разрешил отправку в выбранную беседу.", [7, 15, 901, 902, 917, 925, 945, 946].includes(code));
    }
    // Community messages may have message_id=0; conversation IDs are separate.
    if (!Number.isSafeInteger(receipt.message_id) || Number(receipt.message_id) < 0
      || !Number.isSafeInteger(receipt.conversation_message_id) || Number(receipt.conversation_message_id) < 0) throw new VkError("ВКонтакте не подтвердил отправку сообщения.");
  }
}
