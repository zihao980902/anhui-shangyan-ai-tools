const form = document.querySelector("#generate-form");
const appShell = document.querySelector("#app-shell");
const accessScreen = document.querySelector("#access-screen");
const accessForm = document.querySelector("#access-form");
const accessError = document.querySelector("#access-error");
const statusPill = document.querySelector("#status-pill");
const submitButton = document.querySelector("#submit-button");
const results = document.querySelector("#results");
const template = document.querySelector("#result-template");
const clearHistory = document.querySelector("#clear-history");
const openHistory = document.querySelector("#open-history");
const switchAccess = document.querySelector("#switch-access");
const referenceImage = document.querySelector("#referenceImage");
const referenceImageName = document.querySelector("#referenceImageName");

const storageKey = "fashion-ai-studio-history";
const accessKey = "fashion-ai-studio-access-code";
const historyLimit = 24;
let volatileHistory = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clarityToResolution = (clarity) => {
  const value = String(clarity || "high").toLowerCase();
  if (value.includes("low") || value.includes("1k")) return "1K";
  if (value.includes("medium") || value.includes("2k")) return "2K";
  return "4K";
};

const ratioToSize = (ratio, clarity) => {
  const value = String(ratio || "1:1").toLowerCase();
  const resolution = clarityToResolution(clarity);
  const sizes = {
    "1K": { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024", feed: "1024x1280" },
    "2K": { square: "2048x2048", portrait: "1536x2048", landscape: "2048x1536", feed: "1638x2048" },
    "4K": { square: "4096x4096", portrait: "2160x3840", landscape: "3840x2160", feed: "3072x3840" },
  }[resolution];

  if (value.includes("9:16")) return sizes.portrait;
  if (value.includes("16:9")) return sizes.landscape;
  if (value.includes("4:5")) return sizes.feed;
  return sizes.square;
};

const normalizeError = (message) => {
  const text = String(message || "");
  if (/fetch failed|network|ENOTFOUND|ECONN|ETIMEDOUT|timeout/i.test(text)) {
    return "AI 服务连接失败，请稍后重试；如果连续失败，需要检查后台接口地址或密钥。";
  }
  return text;
};

const setStatus = (text, tone = "ready") => {
  statusPill.textContent = text;
  statusPill.className = `status-pill ${tone === "ready" ? "" : tone}`.trim();
};

const compactResult = (value, depth = 0) => {
  if (depth > 8) return "[内容层级过深，已省略]";
  if (typeof value === "string") {
    if (/^data:image\//.test(value) || value.length > 50000) return "[图片数据较大，未保存到历史]";
    return value;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactResult(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/^(b64_json|base64|image_base64)$/i.test(key) && typeof item === "string") {
        return [key, "[图片数据较大，未保存到历史]"];
      }
      return [key, compactResult(item, depth + 1)];
    }),
  );
};

const findMediaUrl = (data) => {
  const stack = [data];
  const keys = ["url", "mediaUrl", "image_url", "video_url", "output", "src"];

  while (stack.length) {
    const item = stack.shift();
    if (!item || typeof item !== "object") continue;
    for (const key of keys) {
      const value = item[key];
      if (typeof value === "string" && /^https?:\/\//.test(value)) return value;
    }
    if (Array.isArray(item)) stack.push(...item);
    else stack.push(...Object.values(item));
  }
  return "";
};

const findBase64Image = (data) => {
  const stack = [data];
  while (stack.length) {
    const item = stack.shift();
    if (!item || typeof item !== "object") continue;
    if (typeof item.b64_json === "string") return item.b64_json;
    if (Array.isArray(item)) stack.push(...item);
    else stack.push(...Object.values(item));
  }
  return "";
};

const compactHistoryItem = (item) => {
  const result = item?.result || {};
  const mediaUrl = findMediaUrl(result);
  const compactedResult = compactResult(result);

  if (mediaUrl && compactedResult && typeof compactedResult === "object" && !Array.isArray(compactedResult)) {
    compactedResult.mediaUrl = mediaUrl;
  }

  return {
    createdAt: item?.createdAt || new Date().toISOString(),
    mode: item?.mode === "video" ? "video" : "image",
    prompt: String(item?.prompt || "").slice(0, 1200),
    result: compactedResult,
  };
};

const readStoredHistory = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(compactHistoryItem).slice(0, historyLimit);
  } catch {
    localStorage.removeItem(storageKey);
    return [];
  }
};

const readHistory = () => [...volatileHistory, ...readStoredHistory()].slice(0, historyLimit);

const saveHistory = (items) => {
  let safeItems = items.map(compactHistoryItem).slice(0, historyLimit);
  while (safeItems.length > 0) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(safeItems));
      return;
    } catch {
      safeItems = safeItems.slice(0, Math.max(0, safeItems.length - 4));
    }
  }
  localStorage.removeItem(storageKey);
};

const waitForJob = async (jobId) => {
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    const response = await fetch(`/api/result/${jobId}`);
    const body = await response.json();
    if (!response.ok || body.ok === false || body.status === "error") {
      throw new Error(body.error || "生成失败");
    }
    if (body.status === "done") return body;
    setStatus(`生成中 ${attempt}`, "busy");
    await sleep(4000);
  }
  throw new Error("生成时间太久，请稍后再试。");
};

const resizeImage = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("参考图读取失败"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("参考图格式不支持"));
      image.onload = () => {
        const maxSide = 1600;
        const ratio = Math.min(1, maxSide / Math.max(image.width, image.height));
        const width = Math.round(image.width * ratio);
        const height = Math.round(image.height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

const downloadDataUrl = (dataUrl, filename) => {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
};

const downloadMediaUrl = async (url, filename) => {
  try {
    const response = await fetch("/api/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessCode: sessionStorage.getItem(accessKey) || "", filename, url }),
    });
    if (!response.ok) throw new Error("下载失败");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    downloadDataUrl(objectUrl, filename);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
};

const renderHistory = () => {
  const history = readHistory();
  results.innerHTML = "";

  if (history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有生成记录。生成后的图片会出现在这里。";
    results.append(empty);
    return;
  }

  for (const item of history) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector("strong").textContent = item.mode === "video" ? "AI 视频" : "AI 生图";
    node.querySelector("time").textContent = new Date(item.createdAt).toLocaleString("zh-CN");
    node.querySelector("p").textContent = item.prompt;
    node.querySelector("pre").textContent = JSON.stringify(item.result, null, 2);

    const preview = node.querySelector(".preview");
    const actions = node.querySelector(".result-actions");
    const mediaUrl = findMediaUrl(item.result);
    const base64Image = findBase64Image(item.result);
    const filename = `shangyan-ai-${new Date(item.createdAt).getTime()}.png`;

    if (mediaUrl) {
      const isVideo = item.mode === "video" || /\.(mp4|webm|mov)(\?|$)/i.test(mediaUrl);
      const media = document.createElement(isVideo ? "video" : "img");
      media.src = mediaUrl;
      if (isVideo) media.controls = true;
      else media.alt = item.prompt;
      preview.append(media);

      const button = document.createElement("button");
      button.className = "download-button";
      button.type = "button";
      button.textContent = "下载";
      button.addEventListener("click", () => downloadMediaUrl(mediaUrl, filename));
      actions.append(button);
    } else if (base64Image) {
      const image = document.createElement("img");
      image.src = `data:image/png;base64,${base64Image}`;
      image.alt = item.prompt;
      preview.append(image);

      const button = document.createElement("button");
      button.className = "download-button";
      button.type = "button";
      button.textContent = "下载";
      button.addEventListener("click", () => downloadDataUrl(image.src, filename));
      actions.append(button);
    } else {
      preview.textContent = "接口已返回结果，请展开查看原始返回。";
    }

    results.append(node);
  }
};

const lockApp = () => {
  appShell.classList.add("is-locked");
  accessScreen.classList.add("is-open");
};

const unlockApp = () => {
  appShell.classList.remove("is-locked");
  accessScreen.classList.remove("is-open");
};

const checkAccess = async (accessCode) => {
  const response = await fetch("/api/check-access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessCode }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "访问码校验失败");
};

accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  accessError.textContent = "";
  const accessCode = new FormData(accessForm).get("accessCode");
  try {
    await checkAccess(accessCode);
    sessionStorage.setItem(accessKey, accessCode);
    unlockApp();
  } catch (error) {
    accessError.textContent = error instanceof Error ? error.message : String(error);
  }
});

switchAccess.addEventListener("click", () => {
  sessionStorage.removeItem(accessKey);
  lockApp();
});

referenceImage.addEventListener("change", () => {
  const files = Array.from(referenceImage.files || []);
  referenceImageName.textContent =
    files.length > 0 ? `已选择 ${files.length} 张：${files.map((item) => item.name).join("、")}` : "可多选商品图、模特图、风格图，最多取前 6 张。";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());
  const files = Array.from(referenceImage.files || []);

  data.accessCode = sessionStorage.getItem(accessKey) || "";
  data.resolution = clarityToResolution(data.clarity);
  data.size = ratioToSize(data.ratio, data.clarity);
  delete data.referenceImage;

  submitButton.disabled = true;
  setStatus("生成中", "busy");

  try {
    if (files.length > 0) {
      if (files.some((file) => !file.type.startsWith("image/"))) throw new Error("参考图必须都是图片文件。");
      data.referenceImages = await Promise.all(files.slice(0, 6).map((file) => resizeImage(file)));
      data.referenceImage = data.referenceImages[0];
    }

    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(body.error || "生成失败");

    const finalBody = body.jobId ? await waitForJob(body.jobId) : body;
    if (finalBody.ok === false) throw new Error(finalBody.error || "生成失败");

    const createdAt = finalBody.finishedAt || finalBody.createdAt || new Date().toISOString();
    const rawResult = finalBody.result || {};
    const historyItem = compactHistoryItem({ createdAt, mode: data.mode, prompt: data.prompt, result: rawResult });

    if (!findMediaUrl(rawResult) && findBase64Image(rawResult)) {
      volatileHistory.unshift({ createdAt, mode: data.mode, prompt: data.prompt, result: rawResult });
      volatileHistory = volatileHistory.slice(0, 3);
    }

    saveHistory([historyItem, ...readStoredHistory()]);
    renderHistory();
    setStatus("已完成");
  } catch (error) {
    setStatus("失败", "error");
    alert(normalizeError(error instanceof Error ? error.message : String(error)));
  } finally {
    submitButton.disabled = false;
  }
});

clearHistory.addEventListener("click", () => {
  volatileHistory = [];
  localStorage.removeItem(storageKey);
  renderHistory();
});

openHistory.addEventListener("click", () => {
  renderHistory();
  results.scrollIntoView({ behavior: "smooth", block: "nearest" });
  setStatus("历史记录");
});

const initAccess = async () => {
  renderHistory();
  const savedAccessCode = sessionStorage.getItem(accessKey);
  if (!savedAccessCode) {
    lockApp();
    return;
  }
  try {
    await checkAccess(savedAccessCode);
    unlockApp();
  } catch {
    sessionStorage.removeItem(accessKey);
    lockApp();
  }
};

initAccess();
