// Real decoded pixels reach the scanner through a camera stream, without a photo input.
export async function installCamera(page, svg, torch = "unsupported") {
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
            await new Promise((resolve) => { window.finishTorchSetup = resolve; });
          }
        };
      }
      window.testCameraStreams.push(stream);
      return stream;
    };
  }, { source: svg, torch });
}

export async function scanSvg(page, svg, expected) {
  // Center the fixture inside the visible frame of a portrait phone camera.
  const scene = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
    await image.decode();
    const scale = Math.min(1, 580 / image.naturalWidth, 275 / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="100%" height="100%" fill="white"/><g transform="translate(${(720 - width) / 2} ${(1280 - height) / 2}) scale(${scale})">${source}</g></svg>`;
  }, svg);
  await installCamera(page, scene);
  await page.locator("#nomenclature-scan").click();
  await page.waitForFunction((value) => document.querySelector("#nomenclature-code").value === value, expected);
  await page.locator("#nomenclature-preview").waitFor({ state: "hidden" });
}
