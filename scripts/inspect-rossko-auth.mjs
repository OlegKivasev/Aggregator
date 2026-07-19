import { chromium } from "playwright";

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

  const loginTrigger = page.getByRole("link", { name: /вход/i }).first();
  if (await loginTrigger.count()) {
    await loginTrigger.click();
    await page.waitForTimeout(800);
  }

  const emailField = page.locator('input[name="auth[email]"]:visible').first();
  const passwordField = page.locator('input[name="auth[password]"]:visible').first();

  await emailField.fill("wrong@example.com");
  await passwordField.fill("wrongpassword");

  const form = page.locator("form").filter({ has: emailField }).first();
  const submit = form
    .locator('button[type="submit"], input[type="submit"], button')
    .filter({ hasText: /вход/i })
    .first();

  if (await submit.count()) {
    await submit.click();
  } else {
    await passwordField.press("Enter");
  }

  try {
    await page.waitForLoadState("networkidle", { timeout: 10000 });
  } catch {
    await page.waitForTimeout(4000);
  }

  const texts = await page.locator("body *").evaluateAll((nodes) =>
    nodes
      .map((node) => ({
        text: (node.textContent || "").trim(),
        cls: node.getAttribute("class"),
        id: node.id,
        tag: node.tagName,
      }))
      .filter((item) => item.text && /невер|неправ|ошиб|парол|логин|email|почт|вход/i.test(item.text))
      .slice(0, 80),
  );

  console.log(
    JSON.stringify(
      {
        url: page.url(),
        texts,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
