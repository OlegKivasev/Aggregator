import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";

const statePath = new URL("../.state/rossko-storage-state.json", import.meta.url);
if (!existsSync(statePath)) throw new Error("Rossko storage state not found");

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.ROSSKO_BROWSER_PATH,
});

try {
  const context = await browser.newContext({ storageState: JSON.parse(readFileSync(statePath, "utf8")) });
  const page = await context.newPage();
  const responses = [];
  page.on("response", async (response) => {
    if (!response.url().includes("/api/Search")) return;
    responses.push({ url: response.url(), status: response.status(), body: await response.text() });
  });
  await page.goto("https://samara.rossko.ru/search?q=1072&text=1072&type=all", { waitUntil: "networkidle", timeout: 60000 });
  console.log(JSON.stringify(responses, null, 2));
} finally {
  await browser.close();
}
