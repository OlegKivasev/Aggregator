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

  const snapshot = await page.locator("tr").evaluateAll((rows) =>
    rows
      .map((row, index) => {
        const cells = Array.from(row.querySelectorAll("td, th")).map((cell) =>
          (cell.textContent || "").replace(/\s+/g, " ").trim(),
        );

        return {
          index,
          className: row.className,
          cells,
          text: (row.textContent || "").replace(/\s+/g, " ").trim(),
          html: row.outerHTML.slice(0, 2500),
        };
      })
      .filter((row) => row.text),
  );

  console.log(JSON.stringify({ url: page.url(), rows: snapshot.slice(0, 40) }, null, 2));
} finally {
  await browser.close();
}
