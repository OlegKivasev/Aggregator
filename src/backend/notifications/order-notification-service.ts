import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import type { OrderHistory } from "../purchasing/order-history-contract.ts";
import type { OrderHistorySupplier } from "../purchasing/order-cancellation-contract.ts";
import { createBoundedAbortSignal } from "../abort.ts";
import { EncryptedVkSettings, validPeerId, validVkToken, type VkSettings } from "./encrypted-vk-settings.ts";
import { SqliteNotificationRepository } from "./sqlite-notification-repository.ts";
import { VkClient, VkError } from "./vk-client.ts";
import { notificationSuppliers, supplierNames, monitoredOrders } from "./order-events.ts";
import { SupplierAuthError, SupplierTimeoutError } from "../errors.ts";
import { defaultOrderQuietHours, nextOrderCheckTime, validOrderQuietHours, type OrderQuietHours } from "./order-check-schedule.ts";

export const orderCheckIntervalMs = 10 * 60_000;
const welcomeMessage = (hours: OrderQuietHours): string => "Агрегатор автозапчастей подключён к этой беседе.\n\n"
  + "Здесь будут появляться уведомления о новых заказах у поставщиков, отменах и получении товаров. Товары будут перечислены отдельными строками.\n\n"
  + "Автоматическая проверка заказов — каждые 10 минут при включённых уведомлениях. "
  + (hours.enabled ? `Пауза с ${hours.from} до ${hours.to} по самарскому времени (UTC+4). ` : "Ночная пауза отключена. ")
  + "Расписание можно изменить в настройках агрегатора. Кнопка «Проверить сейчас» работает в любое время и не сдвигает автоматические проверки.\n\n"
  + "Это тестовое сообщение: отправка в беседу работает.";
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
interface ChatPairing { command: string; expiresAt: string; error: string | null }

export class OrderNotificationService {
  private readonly settings: EncryptedVkSettings;
  private readonly repository: SqliteNotificationRepository;
  private readonly vk: VkClient;
  private readonly source: NotificationHistorySource;
  private readonly now: () => number;
  private readonly checks: SupplierCheck[] = notificationSuppliers.map((supplier) => ({ supplier, lastSuccessAt: null, limited: false, error: null }));
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller = new AbortController();
  private mutationController = new AbortController();
  private work: Promise<void> | null = null;
  private pairingWork: Promise<void> | null = null;
  private pairingController = new AbortController();
  private pairing: ChatPairing | null = null;
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
      quietHours: { ...(current?.quietHours ?? defaultOrderQuietHours) },
      intervalMinutes: 10, checking: this.work !== null, lastCheckAt: this.lastCheckAt, nextCheckAt: this.nextCheckAt,
      error: this.error, suppliers: structuredClone(this.checks),
      pairing: this.pairing ? { ...this.pairing } : null,
      testMessage: current?.peerId ? this.repository.welcomeState(`${current.groupId}:${current.peerId}`) : null,
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
    this.mutating = true; this.controller.abort(); this.cancelChatPairing();
    const bounded = createBoundedAbortSignal(AbortSignal.any([signal, this.mutationController.signal]), 90_000, "VK connection timed out");
    try {
      await this.work;
      bounded.signal.throwIfAborted();
      const { complete, ...connection } = await this.vk.connect(token, bounded.signal);
      bounded.signal.throwIfAborted();
      if (this.stopped) throw new NotificationSettingsError("Сервер завершает работу.", 503);
      const previous = this.settings.get();
      // VK's recent-dialog list is not authoritative for a chat already bound to this community.
      const retained = previous?.groupId === connection.groupId ? previous.chats.find((chat) => chat.id === previous.peerId) : undefined;
      if (retained && !connection.chats.some((chat) => chat.id === retained.id)) connection.chats = [...connection.chats.slice(0, 999), retained];
      const peerId = previous?.groupId === connection.groupId && connection.chats.some((chat) => chat.id === previous.peerId)
        ? previous.peerId : complete && connection.chats.length === 1 ? connection.chats[0].id : null;
      this.settings.set({ token, ...connection, peerId, enabled: false, quietHours: previous?.quietHours ?? { ...defaultOrderQuietHours } });
      this.nextSupplierCheck.clear();
      this.error = null; this.nextCheckAt = null; this.deliveryBlocked = false;
      await this.welcome(bounded.signal);
      return this.state();
    } finally { bounded.dispose(); this.mutating = false; }
  }
  async beginChatPairing(signal: AbortSignal) {
    if (this.stopped) throw new NotificationSettingsError("Сервер завершает работу.", 503);
    if (this.mutating || this.pairingWork) throw new NotificationSettingsError("Дождитесь завершения подключения беседы.", 409);
    const config = this.settings.get();
    if (!config) throw new NotificationSettingsError("Сначала сохраните ключ сообщества ВК.");
    if (config.peerId !== null) throw new NotificationSettingsError("Беседа уже выбрана. Для нового подключения сначала отключите ВК.", 409);
    this.mutating = true;
    this.pairingController = new AbortController();
    const controller = this.pairingController;
    const setup = createBoundedAbortSignal(AbortSignal.any([signal, this.mutationController.signal, controller.signal]), 30_000, "VK chat pairing setup timed out");
    try {
      const session = await this.vk.prepareChatPairing(config.token, config.groupId, setup.signal);
      setup.signal.throwIfAborted();
      if (this.stopped) throw new NotificationSettingsError("Сервер завершает работу.", 503);
      const command = `/aggregator ${randomBytes(16).toString("hex")}`;
      this.pairing = { command, expiresAt: new Date(this.now() + 5 * 60_000).toISOString(), error: null };
      const bounded = createBoundedAbortSignal(controller.signal, 5 * 60_000, "VK chat pairing expired");
      this.pairingWork = this.vk.waitForChat(config.token, config.groupId, command, session, bounded.signal).then(async (chat) => {
        bounded.signal.throwIfAborted();
        const current = this.settings.get();
        if (!current || current.token !== config.token || current.groupId !== config.groupId || current.peerId !== null) return;
        const chats = [...current.chats.filter((item) => item.id !== chat.id).slice(0, 999), chat];
        this.settings.set({ ...current, chats, peerId: chat.id, enabled: false });
        this.error = null; this.deliveryBlocked = false; this.nextCheckAt = null; this.nextSupplierCheck.clear();
        await this.welcome(bounded.signal);
        this.pairing = null;
      }).catch((error: unknown) => {
        if (!controller.signal.aborted && this.pairing) this.pairing.error = bounded.signal.aborted
          ? "Время подключения истекло. Проверьте, что в сообществе включён Long Poll API версии 5.199 и входящие сообщения. Начните заново и отправьте новую команду в течение 5 минут."
          : error instanceof VkError ? error.message : "Не удалось подключить беседу ВК. Начните подключение заново.";
      }).finally(() => { bounded.dispose(); this.pairingWork = null; });
      return this.state();
    } finally { setup.dispose(); this.mutating = false; }
  }
  cancelChatPairing() {
    this.pairingController.abort(); this.pairing = null;
    return this.state();
  }
  async configure(payload: unknown, signal: AbortSignal = new AbortController().signal) {
    if (this.mutating) throw new NotificationSettingsError("Дождитесь завершения подключения ВК.", 409);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new NotificationSettingsError("Неверные настройки уведомлений.");
    const { enabled, peerId } = payload as { enabled?: unknown; peerId?: unknown };
    const current = this.settings.get();
    if (!current) throw new NotificationSettingsError("Сначала сохраните ключ сообщества ВК.");
    const selected = peerId === undefined ? current.peerId : peerId;
    if (typeof enabled !== "boolean" || !validPeerId(selected) || !current.chats.some((chat) => chat.id === selected)) throw new NotificationSettingsError("Выберите доступную беседу сообщества.");
    this.mutating = true; this.controller.abort(); this.cancelChatPairing();
    const bounded = createBoundedAbortSignal(AbortSignal.any([signal, this.mutationController.signal]), 15_000, "VK settings timed out");
    try {
      await this.work;
      bounded.signal.throwIfAborted();
      if (this.stopped) throw new NotificationSettingsError("Сервер завершает работу.", 503);
      this.settings.set({ ...current, peerId: selected, enabled });
      if (enabled) this.repository.retryFailed(`${current.groupId}:${selected}`);
      if (enabled) this.nextSupplierCheck.clear();
      this.error = null; this.deliveryBlocked = false;
      this.nextCheckAt = enabled ? new Date(nextOrderCheckTime(this.now(), current.quietHours)).toISOString() : null;
      // Connection tests are allowed while regular order notifications are paused.
      await this.welcome(bounded.signal);
    } finally { bounded.dispose(); this.mutating = false; }
    if (enabled && this.timer) { this.armTimer(); void this.runOnce(); }
    return this.state();
  }
  async configureSchedule(payload: unknown, signal: AbortSignal = new AbortController().signal) {
    if (!validOrderQuietHours(payload)) throw new NotificationSettingsError("Укажите время паузы в формате ЧЧ:ММ. Начало и окончание должны различаться.");
    if (this.stopped) throw new NotificationSettingsError("Сервер завершает работу.", 503);
    if (this.mutating) throw new NotificationSettingsError("Дождитесь завершения обновления настроек ВК.", 409);
    if (!this.settings.get()) throw new NotificationSettingsError("Сначала сохраните ключ сообщества ВК.");
    this.mutating = true; this.controller.abort();
    const bounded = createBoundedAbortSignal(AbortSignal.any([signal, this.mutationController.signal]), 15_000, "VK schedule update timed out");
    try {
      await this.work; bounded.signal.throwIfAborted();
      const current = this.settings.get();
      if (!current || this.stopped) throw new NotificationSettingsError("Подключение ВК изменено. Повторите настройку расписания.", 409);
      const now = this.now();
      const wasPaused = nextOrderCheckTime(now, current.quietHours) > now;
      this.settings.set({ ...current, quietHours: { ...payload } });
      const allowed = nextOrderCheckTime(now, payload);
      const candidate = allowed > now ? allowed : wasPaused ? now : Math.max(now, this.nextCheckAt ? Date.parse(this.nextCheckAt) : now + orderCheckIntervalMs);
      const next = nextOrderCheckTime(candidate, payload);
      this.nextCheckAt = current.enabled ? new Date(next).toISOString() : null;
      if (this.timer) this.armTimer(next);
      return this.state();
    } finally { bounded.dispose(); this.mutating = false; }
  }
  async checkNow(signal: AbortSignal = new AbortController().signal) {
    if (this.stopped) throw new NotificationSettingsError("Сервер завершает работу.", 503);
    if (this.work || this.mutating) throw new NotificationSettingsError("Проверка или обновление настроек уже выполняется. Дождитесь завершения.", 409);
    const config = this.settings.get();
    if (!config || config.peerId === null) throw new NotificationSettingsError("Сначала подключите беседу ВК.");
    if (this.foregroundOperations > 0) throw new NotificationSettingsError("Поставщики заняты запросом пользователя. Повторите проверку после его завершения.", 409);
    if (this.deliveryBlocked) throw new NotificationSettingsError("Отправка приостановлена. Проверьте ключ и права бота, затем обновите подключение.", 409);
    this.controller = new AbortController(); const controller = this.controller;
    const bounded = createBoundedAbortSignal(AbortSignal.any([signal, controller.signal]), 10 * 60_000, "Manual order monitoring timed out");
    // Manual work shares the same snapshots/outbox, but never changes automatic deadlines or supplier due times.
    this.work = this.cycle(config, config.peerId, bounded.signal, true).catch(() => {
      if (!signal.aborted && !controller.signal.aborted) this.error = "Не удалось завершить ручную проверку заказов. Повторите попытку.";
    }).finally(() => { bounded.dispose(); this.work = null; });
    await this.work; signal.throwIfAborted();
    if (controller.signal.aborted) throw new NotificationSettingsError("Ручная проверка прервана изменением настроек или остановкой сервера.", 409);
    if (bounded.signal.aborted) throw new NotificationSettingsError("Время ручной проверки истекло. Повторите попытку.", 504);
    return this.state();
  }
  private async welcome(signal: AbortSignal): Promise<void> {
    const current = this.settings.get();
    if (!current || current.peerId === null) return;
    const target = `${current.groupId}:${current.peerId}`;
    this.repository.ensureWelcome(target, welcomeMessage(current.quietHours));
    this.repository.retryWelcome(target);
    await this.sendPending(current, current.peerId, signal, true);
  }
  disconnect() {
    this.cancelChatPairing();
    this.controller.abort(); this.mutationController.abort(); this.mutationController = new AbortController();
    const current = this.settings.get();
    if (current?.peerId) this.repository.forgetWelcome(`${current.groupId}:${current.peerId}`);
    this.settings.delete(); this.error = null; this.nextCheckAt = null; this.deliveryBlocked = false;
    this.nextSupplierCheck.clear();
    return this.state();
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.armTimer();
    void this.runOnce();
  }
  private armTimer(at = this.now() + orderCheckIntervalMs): void {
    if (this.timer) clearTimeout(this.timer);
    const now = this.now();
    const config = this.settings.get(); const hours = config?.quietHours ?? defaultOrderQuietHours;
    const allowed = nextOrderCheckTime(now, hours);
    const next = allowed > now ? allowed : nextOrderCheckTime(at, hours);
    this.nextCheckAt = config?.enabled ? new Date(next).toISOString() : null;
    this.timer = setTimeout(() => { this.armTimer(); void this.runOnce(); }, Math.max(1, next - now)); this.timer.unref();
  }
  runOnce(): Promise<void> {
    if (this.work) return this.work;
    const config = this.settings.get();
    if (this.stopped || this.mutating || !config || config.peerId === null) return Promise.resolve();
    if (!config.enabled && !this.repository.pending(`${config.groupId}:${config.peerId}`, this.now(), true)) return Promise.resolve();
    const now = this.now();
    const allowed = nextOrderCheckTime(now, config.quietHours);
    if (allowed > now) {
      this.nextCheckAt = config.enabled ? new Date(allowed).toISOString() : null;
      if (this.timer) this.armTimer(allowed);
      return Promise.resolve();
    }
    this.deferred = false;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    if (!this.timer) this.nextCheckAt = config.enabled ? new Date(nextOrderCheckTime(now + orderCheckIntervalMs, config.quietHours)).toISOString() : null;
    const operation = config.enabled ? this.cycle(config, config.peerId, signal) : this.sendPending(config, config.peerId, signal, true);
    this.work = operation.catch(() => {
      if (!signal.aborted) this.error = "Не удалось завершить проверку уведомлений. Повторим через 10 минут.";
    }).finally(() => { this.work = null; });
    return this.work;
  }
  private async cycle(config: VkSettings, peerId: number, signal: AbortSignal, manual = false): Promise<void> {
    const target = `${config.groupId}:${peerId}`;
    const observations: Array<{ supplier: OrderHistorySupplier; histories: OrderHistory[] }> = [];
    this.error = null;
    for (const check of this.checks) {
      signal.throwIfAborted();
      const now = this.now();
      if (!manual && nextOrderCheckTime(now, config.quietHours) > now) break;
      if (!this.source.available(check.supplier)) { check.error = "Поставщик не подключён."; continue; }
      if (!manual && (this.nextSupplierCheck.get(check.supplier) ?? 0) > this.now()) continue;
      if (this.foregroundOperations > 0) { if (!manual) this.deferred = true; check.error = "Проверка отложена: поставщик занят."; continue; }
      if (!manual) this.nextSupplierCheck.set(check.supplier, this.now() + orderCheckIntervalMs);
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
    await this.sendPending(config, peerId, signal, false, manual);
  }
  private async sendPending(config: VkSettings, peerId: number, signal: AbortSignal, welcomeOnly = false, manual = false): Promise<void> {
    const target = `${config.groupId}:${peerId}`;
    if (this.deliveryBlocked) { this.error = "Отправка приостановлена. Проверьте ключ и права бота, затем обновите подключение."; return; }
    for (let sent = 0; sent < (welcomeOnly ? 1 : 20); sent++) {
      signal.throwIfAborted();
      const now = this.now();
      if (!welcomeOnly && !manual && nextOrderCheckTime(now, config.quietHours) > now) break;
      const pending = this.repository.pending(target, this.now(), welcomeOnly, manual);
      if (!pending) break;
      try {
        // Persisted ID is reused on every retry, including after process restart.
        await this.vk.send(config.token, config.groupId, peerId, pending.text, pending.randomId, signal);
        signal.throwIfAborted(); this.repository.sent(pending.id); this.error = null;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const permanent = error instanceof VkError && error.permanent;
        this.repository.retry(pending.id, pending.attempts, this.now(), permanent);
        this.deliveryBlocked = permanent;
        const message = error instanceof VkError ? error.message : "Не удалось отправить уведомление ВК. Повторим позже.";
        this.error = welcomeOnly ? `Тестовое сообщение не отправлено. ${message}` : message;
        break;
      }
      if (!welcomeOnly) await delay(400, undefined, { signal });
    }
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; this.controller.abort(); this.mutationController.abort(); this.pairingController.abort(); }
  async close(): Promise<void> { this.stop(); await Promise.all([this.work, this.pairingWork]); this.repository.close(); }
}
