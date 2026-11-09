import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium, webkit } from "playwright";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";

const barcode = "2000043626425";

// EAN-13 with a leading 2: left-side parity is LLGGLG. Render real bars so
// these tests exercise the shipped decoder rather than a mocked scan result.
function barcodeSvg() {
  const left = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
  const even = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
  const right = left.map((pattern) => [...pattern].map((bit) => bit === "1" ? "0" : "1").join(""));
  const bits = "101" + [...barcode.slice(1, 7)].map((digit, index) =>
    ("LLGGLG"[index] === "L" ? left : even)[Number(digit)]).join("") + "01010"
    + [...barcode.slice(7)].map((digit) => right[Number(digit)]).join("") + "101";
  const bars = [...bits].map((bit, index) => bit === "1" ? `<rect x="${50 + index * 4}" y="70" width="4" height="150"/>` : "").join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="white"/><g fill="black">${bars}</g></svg>`;
}

function cameraScene(width, height, position = "inside") {
  const code = barcodeSvg();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>
    <g transform="translate(${(width - 480) / 2} ${position === "inside" ? (height - 300) / 2 : 20})">${code}</g></svg>`;
}

async function withPage(check) {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-nomenclature-"));
  const previousPath = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(directory, "garage.sqlite");
  const server = createAggregatorServer({ application: { streamSearch: async () => {} }, publicDir: resolve("src/frontend") });
  let browser;
  try {
    await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const useWebkit = process.env.NOMENCLATURE_BROWSER === "webkit";
    browser = await (useWebkit ? webkit : chromium).launch({ headless: true, executablePath: useWebkit ? undefined : process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(useWebkit ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    const errors = [];
    const apiRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" && process.env.REPAIRS_BOOTSTRAP_CSS_PATH) {
        return route.fulfill({ contentType: "text/css", body: await readFile(process.env.REPAIRS_BOOTSTRAP_CSS_PATH) });
      }
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      apiRequests.push(url.pathname);
      const responses = {
        "/api/auth/session": { enabled: false, user: null },
        "/api/repairs": { repairs: [] },
        "/api/suppliers/sessions": { sessions: [] },
        "/api/applicability/api-key": { configured: false, persistent: false, maskedKey: null },
        "/api/applicability/proxies": { persistent: false, activeRouteId: null, proxies: [], usage: { requestCount: 0 }, directUsage: {} },
        "/api/garage/vehicles": { vehicles: [] },
        "/api/nomenclature/sources": { defaultSource: "production", sources: [
          { id: "production", configured: false, online: false }, { id: "test", configured: false, online: false },
        ] },
      };
      if (url.pathname === "/api/nomenclature/lookups") return route.fulfill({ status: 503, json: { message: "Подключение выбранной базы 1С ещё не настроено." } });
      return route.fulfill({ json: responses[url.pathname] ?? { articles: [], brandCounts: [], hasMore: false } });
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.aggregatorAuthState?.ready);
    await page.waitForLoadState("networkidle");
    await page.locator("#nomenclature-function-tab").click();
    assert.equal(await page.locator("#nomenclature-function").isVisible(), true);
    await check({ page, context, apiRequests });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    if (previousPath === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

async function uploadSvg(page, svg, expected) {
  await page.locator("#nomenclature-file").setInputFiles({ name: "code.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
  await page.waitForFunction(() => !document.querySelector("#nomenclature-file").disabled);
  assert.equal(await page.locator("#nomenclature-code").inputValue(), expected);
  assert.equal(await page.locator("#nomenclature-result").isVisible(), true);
  assert.equal(await page.locator("#nomenclature-scan").isEnabled(), true);
}

async function installCamera(page, svg, torch = "unsupported") {
  await page.evaluate(async ({ source, torch }) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const drawing = canvas.getContext("2d");
    const paint = () => drawing.drawImage(image, 0, 0);
    paint();
    clearInterval(window.cameraPaint);
    window.cameraPaint = setInterval(paint, 50);
    window.updateCameraScene = async (nextSource) => {
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(nextSource)}`;
      await image.decode();
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      paint();
    };
    window.testCameraStreams = [];
    window.torchRequests = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      window.cameraConstraints = constraints;
      const stream = canvas.captureStream(20);
      if (torch !== "unsupported") {
        const index = window.testCameraStreams.length;
        const track = stream.getVideoTracks()[0];
        track.getCapabilities = () => ({ torch: true });
        track.applyConstraints = async (settings) => {
          const enabled = settings.advanced?.[0]?.torch;
          window.torchRequests.push({ index, enabled });
          if (enabled && torch === "rejected") throw new DOMException("Torch unavailable", "NotSupportedError");
          if (enabled && torch === "delayed" && index === 0) {
            await new Promise((resolvePromise) => { window.finishTorchSetup = resolvePromise; });
          }
        };
      }
      window.testCameraStreams.push(stream);
      return stream;
    };
  }, { source: svg, torch });
}

test("scanner works when the host serves only physical frontend files", async () => {
  await withPage(async ({ page }) => {
    await page.route("**/vendor/**", async (route) => {
      const { pathname } = new URL(route.request().url());
      try {
        return route.fulfill({ contentType: "application/javascript", body: await readFile(resolve("src/frontend", `.${pathname}`)) });
      } catch {
        return route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
      }
    });
    await uploadSvg(page, barcodeSvg(), barcode);
  });
});

test("nomenclature reads real EAN-13 and QR images safely, copies, restores and fits a phone", async () => {
  await withPage(async ({ page, context, apiRequests }) => {
    await uploadSvg(page, barcodeSvg(), barcode);
    const offCenter = barcodeSvg().replaceAll('height="300"', 'height="1000"');
    await uploadSvg(page, offCenter, barcode);
    const useWebkit = process.env.NOMENCLATURE_BROWSER === "webkit";
    if (useWebkit) await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: async () => { throw new Error("Clipboard unavailable"); } },
    }));
    else await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.locator("#nomenclature-copy").click();
    if (useWebkit) {
      await page.getByText(/Код выделен/).waitFor();
      assert.equal(await page.locator("#nomenclature-code").evaluate((element) => element.selectionEnd - element.selectionStart), barcode.length);
    } else {
      await page.getByText("Код скопирован.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), barcode);
    }
    const qrText = '0000123\n<img src=x onerror="window.scanXss=1">';
    const qrSvg = await page.evaluate((text) => {
      const svg = new window.ZXingBrowser.BrowserQRCodeSvgWriter().write(text, 400, 400);
      const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      background.setAttribute("width", "100%");
      background.setAttribute("height", "100%");
      background.setAttribute("fill", "white");
      svg.prepend(background);
      return new XMLSerializer().serializeToString(svg);
    }, qrText);
    await uploadSvg(page, qrSvg, qrText);
    assert.equal(await page.evaluate(() => window.scanXss), undefined);
    assert.equal(await page.locator("#nomenclature-result img").count(), 0);
    assert.equal(await page.locator("#nomenclature-function").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await uploadSvg(page, barcodeSvg(), barcode);
    if (process.env.NOMENCLATURE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, "nomenclature-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (process.env.NOMENCLATURE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, "nomenclature-desktop.png"), fullPage: true });
    await page.locator("#nomenclature-file").setInputFiles({ name: "blank.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="white"/></svg>') });
    await page.getByText(/Код на фото не распознан/).waitFor();
    assert.equal(await page.locator("#nomenclature-result").isVisible(), false);
    assert.equal(await page.locator("#nomenclature-scan").isEnabled(), true);
    assert.equal(apiRequests.some((path) => /integration/.test(path)), false);
    await page.reload();
    await page.waitForFunction(() => window.aggregatorAuthState?.ready);
    assert.equal(await page.locator("#nomenclature-function").isVisible(), true);
  });
});

test("camera decodes actual frames and releases tracks on result, stop, section change and page hiding", async () => {
  await withPage(async ({ page }) => {
    await installCamera(page, cameraScene(720, 1280));
    await page.locator("#nomenclature-scan").click();
    await page.waitForFunction((value) => document.querySelector("#nomenclature-code").value === value, barcode);
    assert.equal(await page.evaluate(() => window.testCameraStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended"))), true);
    assert.equal(await page.evaluate(() => window.cameraConstraints.audio), false);
    assert.equal(await page.evaluate(() => window.cameraConstraints.video.facingMode.ideal), "environment");
    assert.equal(await page.locator("#nomenclature-preview").isVisible(), false);
    const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="white"/></svg>';
    await installCamera(page, blank);
    for (const action of ["stop", "section", "hidden"]) {
      await page.locator("#nomenclature-scan").click();
      await page.waitForFunction(() => document.querySelector("#nomenclature-video").readyState >= 2);
      if (action === "stop") await page.locator("#nomenclature-stop").click();
      if (action === "section") await page.locator("#markup-function-tab").evaluate((button) => button.click());
      if (action === "hidden") await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      assert.equal(await page.evaluate(() => window.testCameraStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended"))), true);
      assert.equal(await page.locator("#nomenclature-video").evaluate((video) => video.srcObject), null);
      if (action === "section") await page.locator("#nomenclature-function-tab").click();
    }
  });
});

test("camera automatically enables the torch and switches it off on result, stop, section change and page hiding", async () => {
  await withPage(async ({ page }) => {
    const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="100%" height="100%" fill="white"/></svg>';
    await installCamera(page, blank, "supported");
    for (const [index, action] of ["result", "stop", "section", "hidden"].entries()) {
      await page.locator("#nomenclature-scan").click();
      await page.waitForFunction((index) => window.torchRequests.some((request) => request.index === index && request.enabled), index);
      if (action === "result") {
        await page.evaluate((scene) => window.updateCameraScene(scene), cameraScene(720, 1280));
        await page.waitForFunction((value) => document.querySelector("#nomenclature-code").value === value, barcode);
        await page.evaluate((scene) => window.updateCameraScene(scene), blank);
      }
      if (action === "stop") await page.locator("#nomenclature-stop").click();
      if (action === "section") await page.locator("#markup-function-tab").evaluate((button) => button.click());
      if (action === "hidden") await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForFunction((index) => window.torchRequests.some((request) => request.index === index && request.enabled === false), index);
      assert.equal(await page.evaluate(() => window.testCameraStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended"))), true);
      assert.equal(await page.locator("#nomenclature-preview").isVisible(), false);
      if (action === "section") await page.locator("#nomenclature-function-tab").click();
    }
  });
});

test("a rejected torch setting still allows a real barcode to be scanned", async () => {
  await withPage(async ({ page }) => {
    const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="100%" height="100%" fill="white"/></svg>';
    await installCamera(page, blank, "rejected");
    await page.locator("#nomenclature-scan").click();
    await page.getByText("Наведите камеру на код и держите телефон неподвижно до распознавания.", { exact: true }).last().waitFor();
    assert.equal(await page.evaluate(() => window.torchRequests.some((request) => request.enabled)), true);
    await page.evaluate((scene) => window.updateCameraScene(scene), cameraScene(720, 1280));
    await page.waitForFunction((value) => document.querySelector("#nomenclature-code").value === value, barcode);
    assert.equal(await page.evaluate(() => window.testCameraStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended"))), true);
  });
});

test("late torch activation after cancellation cannot stop a newer camera stream", async () => {
  await withPage(async ({ page }) => {
    const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="100%" height="100%" fill="white"/></svg>';
    await installCamera(page, blank, "delayed");
    await page.locator("#nomenclature-scan").click();
    await page.waitForFunction(() => typeof window.finishTorchSetup === "function");
    await page.locator("#nomenclature-stop").click();
    await page.locator("#nomenclature-scan").click();
    await page.waitForFunction(() => window.torchRequests.some((request) => request.index === 1 && request.enabled));
    const oldStops = await page.evaluate(() => window.torchRequests.filter((request) => request.index === 0 && request.enabled === false).length);
    await page.evaluate(() => window.finishTorchSetup());
    await page.waitForFunction((count) => window.torchRequests.filter((request) => request.index === 0 && request.enabled === false).length > count, oldStops);
    assert.equal(await page.locator("#nomenclature-video").evaluate((video) => video.srcObject === window.testCameraStreams[1]), true);
    assert.equal(await page.evaluate(() => window.testCameraStreams[1].getVideoTracks()[0].readyState), "live");
    assert.equal(await page.locator("#nomenclature-preview").isVisible(), true);
    await page.locator("#nomenclature-stop").click();
    assert.equal(await page.evaluate(() => window.testCameraStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended"))), true);
  });
});

test("camera ignores a real barcode outside the frame and reads it only after moving inside across rotations", async () => {
  await withPage(async ({ page }) => {
    await uploadSvg(page, barcodeSvg(), barcode);
    await page.evaluate(() => {
      const reader = window.ZXingBrowser.BrowserMultiFormatReader.prototype;
      const decode = reader.decodeFromCanvas;
      window.regionScanAttempts = 0;
      reader.decodeFromCanvas = function (canvas) {
        window.regionScanAttempts += 1;
        return decode.call(this, canvas);
      };
    });
    await installCamera(page, cameraScene(720, 1280, "outside"));
    await page.locator("#nomenclature-scan").click();
    await page.waitForFunction(() => window.regionScanAttempts >= 1);
    assert.equal(await page.locator("#nomenclature-code").inputValue(), "");
    for (const { viewport, width, height } of [
      { viewport: { width: 390, height: 844 }, width: 720, height: 1280 },
      { viewport: { width: 844, height: 390 }, width: 1280, height: 720 },
      { viewport: { width: 1440, height: 900 }, width: 1280, height: 720 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate((scene) => window.updateCameraScene(scene), cameraScene(width, height, "outside"));
      await page.waitForFunction(({ width, height }) => {
        const video = document.querySelector("#nomenclature-video");
        return video.videoWidth === width && video.videoHeight === height;
      }, { width, height });
      const attempts = await page.evaluate(() => window.regionScanAttempts);
      await page.waitForFunction((previous) => window.regionScanAttempts >= previous + 3, attempts);
      assert.equal(await page.locator("#nomenclature-code").inputValue(), "");
      assert.equal(await page.locator("#nomenclature-preview").isVisible(), true);
    }
    await page.locator(".nomenclature-viewfinder").evaluate((element) => { element.style.display = "none"; });
    await page.evaluate((scene) => window.updateCameraScene(scene), cameraScene(1280, 720));
    const attempts = await page.evaluate(() => window.regionScanAttempts);
    await page.waitForFunction((previous) => window.regionScanAttempts >= previous + 3, attempts);
    assert.equal(await page.locator("#nomenclature-code").inputValue(), "");
    await page.locator(".nomenclature-viewfinder").evaluate((element) => { element.style.removeProperty("display"); });
    await page.waitForFunction((value) => document.querySelector("#nomenclature-code").value === value, barcode);
    assert.equal(await page.locator("#nomenclature-preview").isVisible(), false);
    assert.equal(await page.evaluate(() => window.testCameraStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended"))), true);
  });
});

test("camera ignores a neighboring QR outside the frame and returns the QR inside it", async () => {
  await withPage(async ({ page }) => {
    await uploadSvg(page, barcodeSvg(), barcode);
    const [outside, inside] = await page.evaluate(() => ["OUTSIDE-QR", "INSIDE-TARGET-QR"].map((text) =>
      new XMLSerializer().serializeToString(new window.ZXingBrowser.BrowserQRCodeSvgWriter().write(text, 160, 160))));
    const scene = (includeInside) => `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280">
      <rect width="100%" height="100%" fill="white"/><g transform="translate(280 80)">${outside}</g>
      ${includeInside ? `<g transform="translate(280 560)">${inside}</g>` : ""}</svg>`;
    await page.evaluate(() => {
      const reader = window.ZXingBrowser.BrowserMultiFormatReader.prototype;
      const decode = reader.decodeFromCanvas;
      window.regionScanAttempts = 0;
      reader.decodeFromCanvas = function (canvas) {
        window.regionScanAttempts += 1;
        return decode.call(this, canvas);
      };
    });
    await installCamera(page, scene(false));
    await page.locator("#nomenclature-scan").click();
    await page.waitForFunction(() => window.regionScanAttempts >= 3);
    assert.equal(await page.locator("#nomenclature-code").inputValue(), "");
    await page.evaluate((next) => window.updateCameraScene(next), scene(true));
    await page.waitForFunction(() => document.querySelector("#nomenclature-code").value === "INSIDE-TARGET-QR");
    assert.equal(await page.locator("#nomenclature-preview").isVisible(), false);
    assert.equal(await page.evaluate(() => window.testCameraStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended"))), true);
  });
});

test("camera handles denial and a permission response arriving after cancellation", async () => {
  await withPage(async ({ page }) => {
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("Denied", "NotAllowedError"); };
    });
    await page.locator("#nomenclature-scan").click();
    await page.getByText(/Нет доступа к камере/).waitFor();
    assert.equal(await page.locator("#nomenclature-scan").isEnabled(), true);
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => new Promise((resolvePromise) => { window.allowCamera = resolvePromise; });
    });
    await page.locator("#nomenclature-scan").click();
    await page.waitForFunction(() => typeof window.allowCamera === "function");
    await page.locator("#nomenclature-stop").click();
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 100;
      window.lateStream = canvas.captureStream();
      window.allowCamera(window.lateStream);
    });
    await page.waitForFunction(() => window.lateStream.getTracks().every((track) => track.readyState === "ended"));
    assert.equal(await page.locator("#nomenclature-result").isVisible(), false);
    assert.equal(await page.locator("#nomenclature-preview").isVisible(), false);
    assert.equal(await page.locator("#nomenclature-scan").isEnabled(), true);
    const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="white"/></svg>';
    await uploadSvg(page, barcodeSvg(), barcode);
    await installCamera(page, blank);
    await page.evaluate(() => {
      const reader = window.ZXingBrowser.BrowserMultiFormatReader.prototype;
      const decode = reader.decodeFromStream;
      let first = true;
      reader.decodeFromStream = async function (stream, video, callback) {
        if (!first) return decode.call(this, stream, video, callback);
        first = false;
        video.srcObject = stream;
        await video.play();
        return new Promise((resolvePromise) => {
          window.finishOldCameraSetup = () => resolvePromise({ stop() { video.srcObject = null; } });
        });
      };
    });
    await page.locator("#nomenclature-scan").click();
    await page.waitForFunction(() => typeof window.finishOldCameraSetup === "function");
    await page.locator("#nomenclature-stop").click();
    await page.locator("#nomenclature-scan").click();
    await page.waitForFunction(() => document.querySelector("#nomenclature-video").readyState >= 2);
    await page.evaluate(async () => {
      window.finishOldCameraSetup();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    assert.equal(await page.locator("#nomenclature-video").evaluate((video) => !!video.srcObject), true);
    await page.locator("#nomenclature-stop").click();
    assert.equal(await page.evaluate(() => window.testCameraStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended"))), true);
    await page.evaluate(() => Object.defineProperty(window, "isSecureContext", { configurable: true, value: false }));
    await page.locator("#nomenclature-scan").click();
    await page.getByText(/откройте агрегатор по HTTPS/).waitFor();
    await uploadSvg(page, barcodeSvg(), barcode);
  });
});

test("camera requests permission immediately while the decoder is unavailable", async () => {
  await withPage(async ({ page }) => {
    const decoderRequests = [];
    await page.route("**/vendor/**", (route) => {
      decoderRequests.push(route.request().url());
      return route.fulfill({ status: 404, body: "Not found" });
    });
    await page.evaluate(() => {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
        getUserMedia() { window.cameraPermissionRequested = true; return new Promise(() => {}); },
      } });
    });
    await page.locator("#nomenclature-scan").click();
    assert.equal(await page.evaluate(() => window.cameraPermissionRequested), true);
    assert.equal(await page.locator("#nomenclature-preview").isVisible(), true);
    assert.equal(await page.locator("#nomenclature-video").evaluate((video) => video.muted && video.defaultMuted && video.playsInline), true);
    assert.deepEqual(decoderRequests, []);
    await page.locator("#nomenclature-stop").click();
    assert.equal(await page.locator("#nomenclature-preview").isVisible(), false);
  });
});

test("decoder loading failure is distinguished from an unreadable code and can be retried", async () => {
  await withPage(async ({ page }) => {
    let unavailable = true;
    await page.route("**/vendor/**", (route) => unavailable
      ? route.fulfill({ status: 404, body: "Not found" }) : route.fallback());
    await page.locator("#nomenclature-file").setInputFiles({ name: "code.svg", mimeType: "image/svg+xml", buffer: Buffer.from(barcodeSvg()) });
    await page.getByText(/Не удалось загрузить сканер/).waitFor();
    assert.equal(await page.locator("#nomenclature-scan").isEnabled(), true);
    unavailable = false;
    await uploadSvg(page, barcodeSvg(), barcode);
  });
});

test("fullscreen scanner covers the viewport, keeps the frame centered and exits by arrow or Escape", async () => {
  await withPage(async ({ page }) => {
    await page.evaluate(() => Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia() { return new Promise(() => {}); },
    } }));
    const preview = page.locator("#nomenclature-preview");
    const scanButton = page.locator("#nomenclature-scan");
    await scanButton.click();
    assert.equal(await preview.evaluate((element) => element.matches(":modal")), true);
    for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 667 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      const bounds = await preview.boundingBox();
      const video = await page.locator("#nomenclature-video").boundingBox();
      const frame = await page.locator(".nomenclature-viewfinder").boundingBox();
      const back = await page.locator("#nomenclature-stop").boundingBox();
      assert.ok(Math.abs(bounds.x) < 1 && Math.abs(bounds.y) < 1);
      assert.ok(Math.abs(bounds.width - viewport.width) < 1 && Math.abs(bounds.height - viewport.height) < 1);
      assert.deepEqual(video, bounds);
      assert.ok(Math.abs(frame.x + frame.width / 2 - viewport.width / 2) < 1);
      assert.ok(Math.abs(frame.y + frame.height / 2 - viewport.height / 2) < 1);
      assert.ok(back.x >= 8 && back.y >= 8 && back.width >= 44 && back.height >= 44);
      const footer = await page.locator(".nomenclature-camera-footer").boundingBox();
      assert.ok(frame.y >= back.y + back.height && frame.y + frame.height < footer.y);
      assert.equal(await page.locator("#nomenclature-video").evaluate((element) => getComputedStyle(element).objectFit), "cover");
      assert.equal(await page.locator("body").evaluate((element) => getComputedStyle(element).overflow), "hidden");
      if (process.env.NOMENCLATURE_SCREENSHOT_DIR && viewport.width !== 375) {
        await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, `scanner-${viewport.width}x${viewport.height}.png`) });
      }
    }
    await page.getByRole("button", { name: "Выйти из сканирования" }).click();
    assert.equal(await preview.isVisible(), false);
    assert.equal(await scanButton.isEnabled(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "nomenclature-scan");
    assert.notEqual(await page.locator("body").evaluate((element) => getComputedStyle(element).overflow), "hidden");
    await scanButton.click();
    await page.keyboard.press("Escape");
    assert.equal(await preview.isVisible(), false);
    assert.equal(await scanButton.isEnabled(), true);
    await scanButton.click();
    await preview.evaluate((element) => element.close());
    await page.waitForFunction(() => !document.querySelector("#nomenclature-scan").disabled);
    assert.equal(await preview.isVisible(), false);
  });
});
