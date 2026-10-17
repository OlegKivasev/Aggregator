import { createBoundedAbortSignal } from "../abort.ts";
import { validPeerId, type VkChat } from "./encrypted-vk-settings.ts";
import { setTimeout as delay } from "node:timers/promises";

export class VkError extends Error {
  readonly permanent: boolean;
  constructor(message = "ВКонтакте временно недоступен. Повторим отправку позже.", permanent = false) { super(message); this.permanent = permanent; }
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VkError("ВКонтакте вернул некорректный ответ.");
  return value as Record<string, unknown>;
};

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
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body) {
        await response.body?.cancel(); throw new VkError();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
          if (size > 2_097_152) { await reader.cancel(); throw new VkError("Ответ ВКонтакте превышает допустимый размер."); } chunks.push(part.value); }
      } finally { reader.releaseLock(); }
      const payload = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (payload.error !== undefined) {
        const code = object(payload.error).error_code;
        if (code === 5 || code === 27 || code === 28) throw new VkError("ВКонтакте отклонил ключ сообщества. Проверьте подключение.", true);
        if ([7, 15, 901, 902, 917, 925, 945, 946].includes(Number(code))) throw new VkError("У сообщества нет права отправлять сообщения в выбранную беседу.", true);
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
