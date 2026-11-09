import { getVideoScanRegion } from "./nomenclature-scan-region.js";
import { bootstrapNomenclatureLookup, bootstrapNomenclatureSettings } from "./nomenclature-lookup-ui.js?v=search-progress-1";

let decoderModule;

class ScannerLoadError extends Error {
  constructor() {
    super("Scanner library could not be loaded");
    this.name = "ScannerLoadError";
  }
}

const createReader = async () => {
  decoderModule ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("./vendor/zxing-browser.min.js?v=0.2.1", import.meta.url).href;
    script.async = true;
    const finish = (failed) => {
      clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      const Reader = window.ZXingBrowser?.BrowserMultiFormatReader;
      if (failed || typeof Reader !== "function") {
        script.remove();
        reject(new ScannerLoadError());
      } else {
        resolve(Reader);
      }
    };
    const timeout = setTimeout(() => finish(true), 15_000);
    script.onload = () => finish(false);
    script.onerror = () => finish(true);
    document.head.append(script);
  }).catch((error) => {
    decoderModule = undefined;
    throw error;
  });
  const Reader = await decoderModule;
  // The standalone bundle omits DecodeHintType. TRY_HARDER is 3 in the pinned
  // @zxing/library 0.23.0; it also enables rotated and more densely sampled scans.
  return new Reader(new Map([[3, true]]), {
    delayBetweenScanAttempts: 200,
    delayBetweenScanSuccess: 500,
  });
};

const stopTracks = (stream) => stream?.getTracks().forEach((track) => track.stop());
const stopControls = (controls) => {
  // Some devices return an asynchronous stop while switching off the torch.
  try { void Promise.resolve(controls?.stop()).catch(() => {}); } catch { /* Tracks are also stopped directly. */ }
};

const restrictReaderToViewfinder = (reader, video, viewfinder) => {
  const canvas = document.createElement("canvas");
  const drawing = canvas.getContext("2d", { willReadFrequently: true });
  if (!drawing) throw new Error("Scanner canvas is unavailable");
  const decode = reader.decodeFromCanvas.bind(reader);
  reader.decodeFromCanvas = () => {
    const frame = viewfinder.getBoundingClientRect();
    const style = getComputedStyle(viewfinder);
    const left = parseFloat(style.borderLeftWidth) || 0;
    const top = parseFloat(style.borderTopWidth) || 0;
    const right = parseFloat(style.borderRightWidth) || 0;
    const bottom = parseFloat(style.borderBottomWidth) || 0;
    const region = getVideoScanRegion(video.videoWidth, video.videoHeight, video.getBoundingClientRect(), {
      left: frame.left + left, top: frame.top + top,
      width: frame.width - left - right, height: frame.height - top - bottom,
    });
    if (canvas.width !== (region?.width ?? 1)) canvas.width = region?.width ?? 1;
    if (canvas.height !== (region?.height ?? 1)) canvas.height = region?.height ?? 1;
    if (region) {
      // Read the live video's current dimensions, including after rotation;
      // ZXing's original full-frame capture canvas retains its initial size.
      drawing.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
    } else {
      // During layout changes an empty frame must never fall back to the full image.
      drawing.fillStyle = "white";
      drawing.fillRect(0, 0, canvas.width, canvas.height);
    }
    return decode(canvas);
  };
};

const cameraErrorMessage = (error) => {
  if (error?.name === "ScannerLoadError") {
    return "Не удалось загрузить сканер. Обновите страницу и повторите попытку.";
  }
  if (error?.name === "CameraPreviewError") {
    return "Камера подключена, но браузер не показал изображение. Повторите запуск.";
  }
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return "Нет доступа к камере. Разрешите его в настройках браузера.";
  }
  if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") {
    return "Камера не найдена. Попробуйте другое устройство.";
  }
  if (error?.name === "NotReadableError") {
    return "Камера недоступна. Закройте другие приложения, использующие камеру, и повторите попытку.";
  }
  return "Не удалось запустить сканирование. Повторите попытку.";
};

export function bootstrapNomenclature() {
  const lookup = bootstrapNomenclatureLookup();
  bootstrapNomenclatureSettings();
  const section = document.querySelector("#nomenclature-function");
  const scanButton = document.querySelector("#nomenclature-scan");
  const stopButton = document.querySelector("#nomenclature-stop");
  const torchButton = document.querySelector("#nomenclature-torch");
  const preview = document.querySelector("#nomenclature-preview");
  const viewfinder = preview.querySelector(".nomenclature-viewfinder");
  let video = document.querySelector("#nomenclature-video");
  const feedback = document.querySelector("#nomenclature-feedback");
  const cameraFeedback = document.querySelector("#nomenclature-camera-feedback");
  const resultPanel = document.querySelector("#nomenclature-result");
  const code = document.querySelector("#nomenclature-code");
  const copyButton = document.querySelector("#nomenclature-copy");
  let active = false;
  let busy = false;
  let generation = 0;
  let stream;
  let controls;
  let cameraMode = false;
  let torchEnabled = false;
  let torchChanging = false;

  const paintTorch = (available) => {
    torchButton.disabled = !available || torchChanging;
    torchButton.setAttribute("aria-pressed", String(torchEnabled));
    const label = available ? (torchEnabled ? "Выключить фонарик" : "Включить фонарик") : "Фонарик недоступен";
    torchButton.setAttribute("aria-label", label);
    torchButton.title = label;
  };

  const setFeedback = (message, tone = "notice") => {
    feedback.textContent = message;
    feedback.dataset.tone = tone;
    cameraFeedback.textContent = preview.open ? message : "";
  };

  const setBusy = (value) => {
    busy = value;
    scanButton.disabled = value;
    stopButton.hidden = !value;
  };

  const stop = () => {
    const returnFocus = cameraMode && active && !section.hidden && !document.hidden;
    generation += 1;
    stopControls(controls);
    controls = undefined;
    stopTracks(stream);
    stream = undefined;
    torchEnabled = false;
    torchChanging = false;
    paintTorch(false);
    video.pause();
    video.srcObject = null;
    setBusy(false);
    cameraMode = false;
    if (preview.open) preview.close();
    cameraFeedback.textContent = "";
    if (returnFocus) scanButton.focus({ preventScroll: true });
  };

  const current = (attempt) => attempt === generation && active && !document.hidden;
  const changeTorch = async (enabled, attempt = generation, scannerControls = controls) => {
    if (!current(attempt) || typeof scannerControls?.switchTorch !== "function") return;
    torchChanging = true;
    paintTorch(true);
    try {
      await scannerControls.switchTorch(enabled);
      if (current(attempt) && controls === scannerControls) torchEnabled = enabled;
    } catch {
      // Torch failure must not interrupt recognition or disable the camera.
      if (current(attempt) && controls === scannerControls) {
        setFeedback("Не удалось переключить фонарик. Сканирование продолжается.");
      }
    } finally {
      if (current(attempt) && controls === scannerControls) {
        torchChanging = false;
        paintTorch(true);
      } else stopControls(scannerControls);
    }
  };
  const begin = () => {
    stop();
    lookup.clear();
    code.value = "";
    resultPanel.hidden = true;
    setBusy(true);
    return generation;
  };

  const showResult = (result) => {
    code.value = result.getText();
    resultPanel.hidden = false;
    stop();
    setFeedback("");
    void lookup.start(code.value);
  };

  const startCamera = async () => {
    if (!active || busy) return;
    if (!window.isSecureContext) {
      setFeedback("Для доступа к камере откройте агрегатор по HTTPS.", "error");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setFeedback("Этот браузер не поддерживает доступ к камере. Откройте другой браузер.", "error");
      return;
    }
    const attempt = begin();
    // Late cleanup from a cancelled camera startup must not detach a newer stream.
    const cameraVideo = video.cloneNode();
    video.replaceWith(cameraVideo);
    video = cameraVideo;
    cameraVideo.muted = true;
    cameraVideo.defaultMuted = true;
    cameraVideo.playsInline = true;
    cameraVideo.autoplay = true;
    cameraMode = true;
    preview.showModal();
    stopButton.focus({ preventScroll: true });
    setFeedback("Запускаем камеру. Разрешите доступ, если браузер его запросит.");
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (!current(attempt)) {
        stopTracks(acquired);
        return;
      }
      stream = acquired;
      for (const track of acquired.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (!current(attempt)) return;
          stop();
          setFeedback("Камера отключилась. Запустите сканирование ещё раз.", "error");
        });
      }
      cameraVideo.srcObject = acquired;
      try {
        await cameraVideo.play();
      } catch {
        const error = new Error("Camera preview could not be played");
        error.name = "CameraPreviewError";
        throw error;
      }
      if (!current(attempt)) return;
      setFeedback("Камера включена. Подготавливаем сканирование…");
      const reader = await createReader();
      if (!current(attempt)) return;
      restrictReaderToViewfinder(reader, cameraVideo, viewfinder);
      const started = await reader.decodeFromStream(acquired, cameraVideo, (result, error, scannerControls) => {
        if (!current(attempt)) {
          stopControls(scannerControls);
          return;
        }
        if (result) {
          stopControls(scannerControls);
          showResult(result);
        } else if (error && !["NotFoundException", "ChecksumException", "FormatException"].includes(error.getKind?.())) {
          stopControls(scannerControls);
          stop();
          setFeedback("Не удалось прочитать кадр камеры. Повторите попытку.", "error");
        }
      });
      if (!current(attempt)) {
        stopControls(started);
        return;
      }
      controls = started;
      setFeedback("Наведите камеру на код и держите телефон неподвижно до распознавания.");
      paintTorch(typeof started.switchTorch === "function");
      await changeTorch(true, attempt, started);
    } catch (error) {
      if (!current(attempt)) return;
      stop();
      setFeedback(cameraErrorMessage(error), "error");
    }
  };

  const cancel = () => {
    if (!busy) return;
    stop();
    setFeedback("Сканирование остановлено. Можно начать снова.");
  };

  scanButton.addEventListener("click", () => { void startCamera(); });
  torchButton.addEventListener("click", () => { if (!torchChanging) void changeTorch(!torchEnabled); });
  stopButton.addEventListener("click", cancel);
  preview.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  });
  preview.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancel();
  });
  preview.addEventListener("close", () => {
    if (!preview.open && cameraMode) cancel();
  });
  copyButton.addEventListener("click", async () => {
    const value = code.value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      if (code.value === value) setFeedback("Код скопирован.", "success");
    } catch {
      if (code.value !== value) return;
      code.focus();
      code.select();
      setFeedback("Код выделен. Скопируйте его через меню телефона или клавишами Ctrl+C.");
    }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); });
  window.addEventListener("pagehide", cancel);
  document.addEventListener("aggregator-auth-ready", (event) => {
    if (!event.detail?.isAdmin && !event.detail?.permissions?.includes("nomenclature")) {
      active = false;
      lookup.setActive(null);
      lookup.clear();
      cancel();
      code.value = "";
      resultPanel.hidden = true;
    }
  });

  return {
    setActive(name) {
      active = name === "nomenclature" && !section.hidden;
      lookup.setActive(active ? name : null);
      if (!active) cancel();
    },
  };
}
