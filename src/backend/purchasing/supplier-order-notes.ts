import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { NomenclatureError, objectFields, parseUuid } from "../nomenclature/contract.ts";

const itemKeyPattern = /^[\w-]{43}\.[1-9]\d{0,4}$/;
const maxNoteLength = 2000;

interface Note { text: string; revision: string }

export function parseSupplierOrderNote(itemKey: string, body: unknown) {
  if (!itemKeyPattern.test(itemKey)) throw new NomenclatureError(400, "invalid_item", "Некорректная позиция заказа.");
  const { text, revision } = objectFields(body, ["text", "revision"]);
  if (typeof text !== "string" || text.length > maxNoteLength
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(text)) {
    throw new NomenclatureError(400, "invalid_note", "Введите заметку длиной до 2000 символов.");
  }
  return { text: text.replace(/\r\n?/g, "\n").trim(), revision: revision === null ? null : parseUuid(revision) };
}

export class SupplierOrderNotes {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(`
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS supplier_order_notes (
          order_id TEXT NOT NULL,
          item_key TEXT NOT NULL,
          text TEXT NOT NULL,
          revision TEXT NOT NULL,
          PRIMARY KEY (order_id, item_key)
        ) STRICT, WITHOUT ROWID;
      `);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void { this.database.close(); }

  withNotes<T extends { name: string; article: string }>(orderId: string, products: T[]) {
    if (!products.length) return [];
    const rows = this.database.prepare("SELECT item_key, text, revision FROM supplier_order_notes WHERE order_id = ?")
      .all(orderId) as unknown as (Note & { item_key: string })[];
    const notes = new Map(rows.map(({ item_key, text, revision }) => [item_key, { text, revision }]));
    const identities = new Map<string, { hash: string; count: number }>();
    return products.map((product) => {
      // The 1C response has no persistent line ID. Ignore changing stock, prices and quantities.
      const identity = JSON.stringify([product.name, product.article]);
      let entry = identities.get(identity);
      if (!entry) {
        entry = { hash: createHash("sha256").update(identity).digest("base64url"), count: 0 };
        identities.set(identity, entry);
      }
      const noteKey = `${entry.hash}.${++entry.count}`;
      return { ...product, noteKey, note: notes.get(noteKey) ?? null };
    });
  }

  save(orderId: string, itemKey: string, text: string, revision: string | null): { saved: boolean; note: Note | null } {
    const next = text ? { text, revision: randomUUID() } : null;
    let changes = 0;
    if (!next) {
      if (revision) {
        changes = Number(this.database.prepare("DELETE FROM supplier_order_notes WHERE order_id = ? AND item_key = ? AND revision = ?")
          .run(orderId, itemKey, revision).changes);
      }
    } else if (revision) {
      changes = Number(this.database.prepare(`UPDATE supplier_order_notes SET text = ?, revision = ?
        WHERE order_id = ? AND item_key = ? AND revision = ?`).run(text, next.revision, orderId, itemKey, revision).changes);
    } else {
      changes = Number(this.database.prepare(`INSERT INTO supplier_order_notes (order_id, item_key, text, revision) VALUES (?, ?, ?, ?)
        ON CONFLICT (order_id, item_key) DO NOTHING`).run(orderId, itemKey, text, next.revision).changes);
    }
    if (changes) return { saved: true, note: next };
    const note = (this.database.prepare("SELECT text, revision FROM supplier_order_notes WHERE order_id = ? AND item_key = ?")
      .get(orderId, itemKey) as unknown as Note | undefined) ?? null;
    return { saved: (note?.text ?? "") === text, note };
  }
}
