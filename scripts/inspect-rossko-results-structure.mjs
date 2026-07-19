import { chromium } from "playwright";

const article = process.argv[2] || "90915YZZJ1";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.ROSSKO_BROWSER_PATH,
});

try {
  const page = await browser.newPage();
  await page.goto(`https://samara.rossko.ru/search?q=${encodeURIComponent(article)}&text=${encodeURIComponent(article)}&type=all`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(5000);

  const items = await page.locator('a[href*="/product?"]').evaluateAll((links) =>
    links.slice(0, 12).map((link) => {
      const parent = link.parentElement;
      const container = parent?.parentElement?.parentElement ?? parent ?? link;

      return {
        href: link.href,
        linkText: (link.textContent || "").replace(/\s+/g, " ").trim(),
        linkClass: link.getAttribute("class"),
        parentClass: parent?.getAttribute("class"),
        containerClass: container?.getAttribute("class"),
        containerText: (container?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 1000),
        html: container?.outerHTML?.slice(0, 2000),
      };
    }),
  );

  console.log(JSON.stringify(items, null, 2));
} finally {
  await browser.close();
}
