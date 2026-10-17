import { setTimeout as delay } from "node:timers/promises";
import type { OrderHistory } from "../purchasing/order-history-contract.ts";
import type { OrderHistorySupplier } from "../purchasing/order-cancellation-contract.ts";
import { createBoundedAbortSignal } from "../abort.ts";
import { EncryptedVkSettings, validPeerId, validVkToken } from "./encrypted-vk-settings.ts";
import { SqliteNotificationRepository } from "./sqlite-notification-repository.ts";
import { VkClient, VkError } from "./vk-client.ts";
import { notificationSuppliers, supplierNames, monitoredOrders } from "./order-events.ts";
import { SupplierAuthError, SupplierTimeoutError } from "../errors.ts";

export const orderCheckIntervalMs = 10 * 60_000;
export class NotificationSettingsError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export interface NotificationHistorySource {
  available(supplier: OrderHistorySupplier): boolean;
  load(supplier: OrderHistorySupplier, signal: AbortSignal, now: number): Promise<OrderHistory[]>;
  observe(supplier: OrderHistorySupplier, history: OrderHistory): void;
}
interface SupplierCheck { supplier: OrderHistorySupplier; lastSuccessAt: string | null; limited: boolean; error: string | null }

export class OrderNotificationService {
  private readonly settings: EncryptedVkSettings;
  private readonly repository: SqliteNotificationRepository;
  private readonly vk: VkClient;
  private readonly source: NotificationHistorySource;
  private readonly now: () => number;
  private readonly checks: SupplierCheck[] = notificationSuppliers.map((supplier) => ({ supplier, lastSuccessAt: null, limited: false, error: null }));
  private timer: ReturnType<typeof setInterval> | null = null;
  private controller = new AbortController();
  private mutationController = new AbortController();
  private work: Promise<void> | null = null;
  private mutating = false;
  private stopped = false;
  private deliveryBlocked = false;
  private error: string | null = null;
  private lastCheckAt: string | null = null;
  private nextCheckAt: string | null = null;
  private foregroundOperations = 0;
  private deferred = false;
  private readonly nextSupplierCheck = new Map<OrderHistorySupplier, number>();

  constructor(settings: EncryptedVkSettings, repository: SqliteNotificationRepository, vk: VkClient, source: NotificationHistorySource, now: () => number = Date.now) {
    this.settings = settings; this.repository = repository; this.vk = vk; this.source = source; this.now = now;
  }
  state() {
    const current = this.settings.get();
    return { configured: !!current, persistent: this.settings.persistent(), enabled: current?.enabled ?? false,
      groupName: current?.groupName ?? null, chats: current?.chats ?? [], peerId: current?.peerId ?? null,
      intervalMinutes: 10, checking: this.work !== null, lastCheckAt: this.lastCheckAt, nextCheckAt: this.nextCheckAt,
      error: this.error, suppliers: structuredClone(this.checks),
      ...(current?.peerId ? this.repository.counts(`${current.groupId}:${current.peerId}`) : { pending: 0, failed: 0 }) };
  }
  beginForegroundOperation(): () => void {
    this.foregroundOperations++;
    let released = false;
    return () => {
      if (released) return;
      released = true; this.foregroundOperations--;
      if (this.foregroundOperations === 0 && this.deferred && this.timer) {
        this.deferred = false;
        if (this.work) void this.work.then(() => this.runOnce()); else void this.runOnce();
      }
    };
  }
  async connect(token: unknown, signal: AbortSignal): Promise<ReturnType<OrderNotificationService["state"]>> {
    if (!validVkToken(token)) throw new NotificationSettingsError("Укажите корректный ключ доступа сообщества ВК.");
    if (!this.settings.persistent()) throw new NotificationSettingsError("Для сохранения ключа ВК настройте серверное шифрование.", 503);
    if (this.mutating) throw new NotificationSettingsError("Подключение ВК уже обновляется.", 409);
    this.mutating = true; this.controller.abort();
    const bounded = createBoundedAbortSignal(AbortSignal.any([signal, this.mutationController.signal]), 90_000, "VK connection timed out");
    try {
      const { complete, ...connection } = await this.vk.connect(token, bounded.signal);
      bounded.signal.throwIfAborted();
      if (this.stopped) throw new NotificationSettingsError("Сервер завершает работу.", 503);
      const previous = this.settings.get();
      const peerId = previous?.groupId === connection.groupId && connection.chats.some((chat) => chat.id === previous.peerId)
        ? previous.peerId : complete && connection.chats.length === 1 ? connection.chats[0].id : null;
      this.settings.set({ token, ...connection, peerId, enabled: false });
      this.nextSupplierCheck.clear();
      this.error = null; this.nextCheckAt = null; this.deliveryBlocked = false;
      return this.state();
    } finally { bounded.dispose(); this.mutating = false; }
  }
  configure(payload: unknown) {
    if (this.mutating) throw new NotificationSettingsError("Дождитесь завершения подключения ВК.", 409);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new NotificationSettingsError("Неверные настройки уведомлений.");
    const { enabled, peerId } = payload as { enabled?: unknown; peerId?: unknown };
    const current = this.settings.get();
    if (!current) throw new NotificationSettingsError("Сначала сохраните ключ сообщества ВК.");
    const selected = peerId === undefined ? current.peerId : peerId;
    if (typeof enabled !== "boolean" || !validPeerId(selected) || !current.chats.some((chat) => chat.id === selected)) throw new NotificationSettingsError("Выберите доступную беседу сообщества.");
    this.controller.abort(); this.settings.set({ ...current, peerId: selected, enabled });
    if (enabled) this.repository.retryFailed(`${current.groupId}:${selected}`);
    if (enabled) this.nextSupplierCheck.clear();
    this.error = null; this.deliveryBlocked = false;
    this.nextCheckAt = enabled ? new Date(this.now()).toISOString() : null;
    if (enabled && this.timer) { if (this.work) void this.work.then(() => this.runOnce()); else void this.runOnce(); }
    return this.state();
  }
  disconnect() {
    this.controller.abort(); this.mutationController.abort(); this.mutationController = new AbortController();
    this.settings.delete(); this.error = null; this.nextCheckAt = null; this.deliveryBlocked = false;
    this.nextSupplierCheck.clear();
    return this.state();
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.armTimer();
    void this.runOnce();
  }
  private armTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { void this.runOnce(); }, orderCheckIntervalMs); this.timer.unref();
  }
  runOnce(): Promise<void> {
    if (this.work) return this.work;
    const config = this.settings.get();
    if (this.stopped || this.mutating || !config?.enabled || config.peerId === null) return Promise.resolve();
    if (this.timer) this.armTimer();
    this.deferred = false;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.nextCheckAt = new Date(this.now() + orderCheckIntervalMs).toISOString();
    this.work = this.cycle(config.token, config.groupId, config.peerId, signal).catch(() => {
      if (!signal.aborted) this.error = "Не удалось завершить проверку уведомлений. Повторим через 10 минут.";
    }).finally(() => { this.work = null; });
    return this.work;
  }
  private async cycle(token: string, groupId: number, peerId: number, signal: AbortSignal): Promise<void> {
    const target = `${groupId}:${peerId}`;
    const observations: Array<{ supplier: OrderHistorySupplier; histories: OrderHistory[] }> = [];
    this.error = null;
    for (const check of this.checks) {
      signal.throwIfAborted();
      if (!this.source.available(check.supplier)) { check.error = "Поставщик не подключён."; continue; }
      if ((this.nextSupplierCheck.get(check.supplier) ?? 0) > this.now()) continue;
      if (this.foregroundOperations > 0) { this.deferred = true; check.error = "Проверка отложена: поставщик занят."; continue; }
      this.nextSupplierCheck.set(check.supplier, this.now() + orderCheckIntervalMs);
      const bounded = createBoundedAbortSignal(signal, 75_000, "Order monitoring timed out");
      try {
        const histories = await this.source.load(check.supplier, bounded.signal, this.now());
        bounded.signal.throwIfAborted();
        if (!this.source.available(check.supplier)) { check.error = "Поставщик отключён во время проверки."; continue; }
        if (!histories.length) throw new Error("Missing history feeds");
        for (const history of histories) monitoredOrders(history);
        for (const history of histories) this.source.observe(check.supplier, history);
        observations.push({ supplier: check.supplier, histories });
        check.lastSuccessAt = new Date(this.now()).toISOString(); check.limited = histories.some((history) => history.limited); check.error = null;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const name = supplierNames[check.supplier];
        check.error = error instanceof SupplierAuthError ? `Проверьте авторизацию ${name} в настройках поставщиков.`
          : error instanceof SupplierTimeoutError || bounded.signal.aborted ? `${name} не ответил вовремя. Повторим через 10 минут.`
            : `Не удалось проверить заказы ${name}. Повторим через 10 минут.`;
      } finally { bounded.dispose(); }
    }
    signal.throwIfAborted();
    if (observations.length) this.repository.observe(target, observations, this.now());
    this.lastCheckAt = new Date(this.now()).toISOString();
    if (this.deliveryBlocked) { this.error = "Отправка приостановлена. Проверьте ключ и права бота, затем обновите подключение."; return; }
    for (let sent = 0; sent < 20; sent++) {
      signal.throwIfAborted();
      const pending = this.repository.pending(target, this.now());
      if (!pending) break;
      try {
        // Persisted ID is reused on every retry, including after process restart.
        await this.vk.send(token, groupId, peerId, pending.text, pending.randomId, signal);
        signal.throwIfAborted(); this.repository.sent(pending.id);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const permanent = error instanceof VkError && error.permanent;
        this.repository.retry(pending.id, pending.attempts, this.now(), permanent);
        this.deliveryBlocked = permanent;
        this.error = error instanceof VkError ? error.message : "Не удалось отправить уведомление ВК. Повторим позже.";
        break;
      }
      await delay(400, undefined, { signal });
    }
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; this.controller.abort(); this.mutationController.abort(); }
  async close(): Promise<void> { this.stop(); await this.work; this.repository.close(); }
}
