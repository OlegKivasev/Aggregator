import { SupplierIntegrationError } from "./errors.ts";

export interface XmlElement {
  name: string;
  text: string;
  children: XmlElement[];
  nil?: true;
}

const schemaInstanceNamespace = "http://www.w3.org/2001/XMLSchema-instance";

function decodeXmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    switch (entity.toLowerCase()) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      case "&apos;": return "'";
      default: {
        const hexadecimal = entity[2]?.toLowerCase() === "x";
        const digits = entity.slice(hexadecimal ? 3 : 2, -1);
        const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : "";
      }
    }
  });
}

export function parseSupplierXml(xml: string): XmlElement {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new SupplierIntegrationError("Supplier SOAP API returned unsupported XML declarations");
  }

  const root: XmlElement = { name: "#document", text: "", children: [] };
  const stack = [root];
  const namespaces = new WeakMap<XmlElement, Map<string, string>>();
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g) || [];
  if (tokens.join("") !== xml) {
    throw new SupplierIntegrationError("Supplier SOAP API returned malformed XML");
  }

  for (const token of tokens) {
    const current = stack.at(-1);
    if (!current) {
      throw new SupplierIntegrationError("Supplier SOAP API returned malformed XML");
    }
    if (token.startsWith("<?") || token.startsWith("<!--")) {
      continue;
    }
    if (token.startsWith("<![CDATA[")) {
      current.text += token.slice(9, -3);
      continue;
    }
    if (!token.startsWith("<")) {
      current.text += decodeXmlText(token);
      continue;
    }
    if (token.startsWith("</")) {
      const match = token.match(/^<\/\s*([A-Za-z_][\w:.-]*)\s*>$/);
      const open = stack.at(-1);
      if (!match || !open || open === root || open.name !== match[1]) {
        throw new SupplierIntegrationError("Supplier SOAP API returned malformed XML");
      }
      stack.pop();
      continue;
    }

    const match = token.match(/^<\s*([A-Za-z_][\w:.-]*)(?:\s([^<>]*?))?\s*(\/?)>$/);
    if (!match) {
      throw new SupplierIntegrationError("Supplier SOAP API returned malformed XML");
    }
    const element: XmlElement = { name: match[1], text: "", children: [] };
    const attributes = match[2];
    if (attributes?.includes("xmlns:") || attributes?.includes(":nil")) {
      const declared = new Map<string, string>();
      let nilPrefix: string | undefined;
      for (const [, name, doubleQuoted, singleQuoted] of attributes.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const value = doubleQuoted ?? singleQuoted;
        if (name.startsWith("xmlns:")) declared.set(name.slice(6), decodeXmlText(value));
        else if (name.endsWith(":nil") && (value === "true" || value === "1")) nilPrefix = name.slice(0, -4);
      }
      if (declared.size) namespaces.set(element, declared);
      if (nilPrefix) {
        let namespace = declared.get(nilPrefix);
        for (let index = stack.length - 1; index >= 0 && namespace === undefined; index--) {
          namespace = namespaces.get(stack[index])?.get(nilPrefix);
        }
        if (namespace === schemaInstanceNamespace) element.nil = true;
      }
    }
    current.children.push(element);
    if (!match[3]) {
      stack.push(element);
    }
  }

  if (stack.length !== 1 || root.children.length !== 1) {
    throw new SupplierIntegrationError("Supplier SOAP API returned malformed XML");
  }
  return root.children[0];
}
