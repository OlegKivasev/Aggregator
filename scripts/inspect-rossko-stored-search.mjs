import { readFileSync, existsSync } from "node:fs";
import { chromium } from "playwright";

const article = process.argv[2] || "5050LR";
const storageStatePath = new URL("../.state/rossko-storage-state.json", import.meta.url);

if (!existsSync(storageStatePath)) {
  throw new Error(`Storage state not found: ${storageStatePath.pathname}`);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.ROSSKO_BROWSER_PATH,
});

try {
  const context = await browser.newContext({
    storageState: JSON.parse(readFileSync(storageStatePath, "utf8")),
  });
  const page = await context.newPage();
  const url = `https://samara.rossko.ru/search?q=${encodeURIComponent(article)}&text=${encodeURIComponent(article)}&type=all`;

  await page.goto(url, {
    waitUntil: "commit",
    timeout: 60000,
  });

  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    await page.waitForTimeout(7000);
  }

  const snapshot = {
    url: page.url(),
    title: await page.title(),
    bodyText: (await page.locator("body").innerText()).slice(0, 4000),
    productLinks: await page.locator('a[href*="/product?"]').count(),
    allLinks: await page.locator("a").evaluateAll((links) =>
      links.slice(0, 50).map((link) => ({
        text: (link.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
        href: (link instanceof HTMLAnchorElement ? link.href : ""),
      })),
    ),
    html: (await page.content()).slice(0, 12000),
  };

  console.log(JSON.stringify(snapshot, null, 2));
} finally {
  await browser.close();
}
