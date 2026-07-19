import { chromium } from "playwright";

const article = process.argv[2] || "90915YZZJ1";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.ROSSKO_BROWSER_PATH,
});

try {
  const page = await browser.newPage();
  await page.goto("https://samara.rossko.ru/", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(2500);

  const searchField = page
    .locator('input[placeholder*="запчасти"], input[placeholder*="VIN"], input[id="1"]')
    .first();
  await searchField.fill(article);
  await searchField.press("Enter");

  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    await page.waitForTimeout(5000);
  }

  const data = {
    url: page.url(),
    title: await page.title(),
    tables: await page.locator("table").evaluateAll((tables) =>
      tables.slice(0, 8).map((table, index) => ({
        index,
        text: (table.textContent || "").replace(/\s+/g, " ").trim().slice(0, 1200),
      })),
    ),
    rows: await page.locator("tr").evaluateAll((rows) =>
      rows.slice(0, 20).map((row, index) => ({
        index,
        text: (row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 600),
      })),
    ),
    links: await page.locator("a").evaluateAll((links) =>
      links
        .map((link) => ({
          text: (link.textContent || "").replace(/\s+/g, " ").trim(),
          href: link.href,
        }))
        .filter((item) => item.text || item.href)
        .slice(0, 50),
    ),
    html: (await page.content()).slice(0, 8000),
  };

  console.log(JSON.stringify(data, null, 2));
} finally {
  await browser.close();
}
