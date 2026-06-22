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
const toggleHistory = document.querySelector("#toggle-history");
const referenceImage = document.querySelector("#referenceImage");
const referenceImageName = document.querySelector("#referenceImageName");
const modelNote = document.querySelector("#model-note");

const storageKey = "fashion-ai-studio-history-v2";
const accessKey = "fashion-ai-studio-access-code";
const historyLimit = 24;
const historyPreviewLimit = 6;
let historyExpanded = false;
let volatileHistory = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isMidjourneyModel = (model) => String(model || "").toLowerCase() === "midjourney";

const clarityToResolution = (clarity) => {
  const value = String(clarity || "high").toLowerCase();
  if (value.includes("low") || value.includes("1k")) return "1K";
  if (value.includes("medium") || value.includes("2k")) return "2K";
  return "4K";
};

const ratioToSize = (ratio, clarity) => {
  const value = String(ratio || "1:1");
  const resolution = clarityToResolution(clarity);
  const sizes = {
    "1K": { "1:1": "1024x1024", "4:5": "1024x1280", "9:16": "1024x1536", "16:9": "1536x1024" },
    "2K": { "1:1": "2048x2048", "4:5": "1638x2048", "9:16": "1536x2048", "16:9": "2048x1536" },
    "4K": { "1:1": "4096x4096", "4:5": "3072x3840", "9:16": "2160x3840", "16:9": "3840x2160" },
  };
  return sizes[resolution]?.[value] || sizes["1K"]["1:1"];
};

const setStatus = (text, tone = "ready") => {
  statusPill.textContent = text;
  statusPill.className = `status-pill ${tone === "ready" ? "" : tone}`.trim();
};

const normalizeError = (message) => {
  const text = String(message || "");
  if (/all_retries_failed/i.test(text)) return "Midjourney 代理多次重试都失败了。请先用更短、更简单的提示词测试；如果连续失败，通常是云雾 MJ 通道或分组暂时不可用。";
  if (/failed to fetch|fetch failed|network|ENOTFOUND|ECONN|ETIMEDOUT|timeout/i.test(text)) {
    return "连接生成接口失败。通常是参考图仍然太大、网络中断，或浏览器缓存还没刷新。请按 Ctrl + F5 后先用 1 张参考图再试。";
  }
  return text;
};

const parseJsonResponse = async (response) => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const preview = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
    throw new Error(`接口返回异常（HTTP ${response.status}）：${preview || "返回内容不是 JSON"}`);
  }
};

const compactValue = (value, depth = 0) => {
  if (depth > 6) return "[已省略]";
  if (typeof value === "string") {
    if (/^data:image\//.test(value) || value.length > 2000) return "[大图数据已省略]";
    return value;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => compactValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/^(b64_json|base64|image_base64)$/i.test(key)) return [key, "[大图数据已省略]"];
      return [key, compactValue(item, depth + 1)];
    }),
  );
};

const findMediaUrl = (data) => {
  const stack = [data];
  const keys = ["imageUrl", "url", "mediaUrl", "image_url", "video_url", "output", "src"];
  while (stack.length) {
    const item = stack.shift();
    if (!item) continue;
    if (typeof item === "string" && (/^https?:\/\//.test(item) || /^data:image\//.test(item))) return item;
    if (typeof item !== "object") continue;
    for (const key of keys) {
      const value = item[key];
      if (typeof value === "string" && (/^https?:\/\//.test(value) || /^data:image\//.test(value))) return value;
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

const getJobId = (result) => {
  if (!result || typeof result !== "object") return "";
  return result.jobId || result.id || result.result?.jobId || "";
};

const isMidjourneyResult = (item) => {
  const result = item?.result || {};
  return Boolean(
    isMidjourneyModel(result.request?.model) ||
      isMidjourneyModel(result.result?.request?.model) ||
      result.response?.submit ||
      result.response?.task ||
      result.data?.submit ||
      result.data?.task,
  );
};

const compactHistoryItem = (item) => {
  const result = item?.result || {};
  const mediaUrl = findMediaUrl(result);
  const compactedResult = compactValue(result);
  if (mediaUrl && !mediaUrl.startsWith("data:") && compactedResult && typeof compactedResult === "object" && !Array.isArray(compactedResult)) compactedResult.imageUrl = mediaUrl;
  return { createdAt: item?.createdAt || new Date().toISOString(), mode: item?.mode === "video" ? "video" : "image", prompt: String(item?.prompt || "").slice(0, 1200), result: compactedResult };
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

const readHistory = () => {
  const merged = [...volatileHistory, ...readStoredHistory()];
  const seen = new Set();
  return merged.filter((item) => {
    const result = item.result || {};
    const key = getJobId(result) || `${item.createdAt}-${findMediaUrl(result)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, historyLimit);
};

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

const upsertHistoryItem = (item) => {
  const next = compactHistoryItem(item);
  const nextJobId = getJobId(next.result);
  const stored = readStoredHistory().filter((historyItem) => !nextJobId ? historyItem.createdAt !== next.createdAt : getJobId(historyItem.result) !== nextJobId);
  saveHistory([next, ...stored]);
};

const waitForJob = async (jobId, pendingItem) => {
  for (let attempt = 1; attempt <= 240; attempt += 1) {
    const response = await fetch(`/api/result/${jobId}`);
    const body = await parseJsonResponse(response);
    if (!response.ok || body.ok === false || body.status === "error") throw new Error(body.error || "生成失败");
    upsertHistoryItem({ ...pendingItem, result: { ...body, jobId } });
    if (body.status === "done") return body;
    renderHistory();
    setStatus(`生成中 ${attempt}`, "busy");
    await sleep(5000);
  }
  throw new Error("后台仍在生成，请稍后点历史记录里的“刷新结果”。");
};

const resizeImage = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error("参考图读取失败"));
  reader.onload = () => {
    const image = new Image();
    image.onerror = () => reject(new Error("参考图格式不支持"));
    image.onload = () => {
      const maxSide = 512;
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const width = Math.round(image.width * scale);
      const height = Math.round(image.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.55));
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
});

const downloadDirect = (url, filename) => {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
};

const getMediaBlob = async (url, filename) => {
  if (url.startsWith("data:")) return (await fetch(url)).blob();
  const response = await fetch("/api/download", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessCode: sessionStorage.getItem(accessKey) || "", filename, url }),
  });
  if (!response.ok) throw new Error("下载失败");
  return response.blob();
};

const downloadMediaUrl = async (url, filename) => {
  if (url.startsWith("data:")) return downloadDirect(url, filename);
  try {
    const blob = await getMediaBlob(url, filename);
    const objectUrl = URL.createObjectURL(blob);
    downloadDirect(objectUrl, filename);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
};

const loadImageBlob = (blob) => new Promise((resolve, reject) => {
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  image.onload = () => resolve({ image, objectUrl });
  image.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    reject(new Error("图片读取失败"));
  };
  image.src = objectUrl;
});

const downloadMidjourneyCrop = async (url, filename, index) => {
  let sourceUrl = "";
  try {
    setStatus(`切图 ${index + 1}`, "busy");
    const blob = await getMediaBlob(url, filename);
    const loaded = await loadImageBlob(blob);
    sourceUrl = loaded.objectUrl;
    const { image } = loaded;
    const cropWidth = Math.floor(image.naturalWidth / 2);
    const cropHeight = Math.floor(image.naturalHeight / 2);
    const sx = (index % 2) * cropWidth;
    const sy = Math.floor(index / 2) * cropHeight;
    const canvas = document.createElement("canvas");
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    canvas.getContext("2d").drawImage(image, sx, sy, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    const cropBlob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("切图失败")), "image/png"));
    const objectUrl = URL.createObjectURL(cropBlob);
    downloadDirect(objectUrl, filename.replace(/\.png$/i, `-${index + 1}.png`));
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    setStatus("已完成");
  } catch (error) {
    setStatus("切图失败", "error");
    alert(normalizeError(error instanceof Error ? error.message : String(error)) || "四宫格切图失败，请先下载原图。 ");
  } finally {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }
};

const applyMidjourneyPreviewRatio = (grid, url) => {
  const image = new Image();
  image.onload = () => {
    if (image.naturalWidth && image.naturalHeight) grid.style.setProperty("--mj-tile-ratio", `${image.naturalWidth} / ${image.naturalHeight}`);
  };
  image.src = url;
};

const createMidjourneySplitPreview = (url) => {
  const grid = document.createElement("div");
  grid.className = "mj-split-grid";
  applyMidjourneyPreviewRatio(grid, url);
  const positions = ["0% 0%", "100% 0%", "0% 100%", "100% 100%"];
  for (let index = 0; index < 4; index += 1) {
    const tile = document.createElement("div");
    tile.className = "mj-crop";
    tile.style.backgroundImage = `url(${JSON.stringify(url)})`;
    tile.style.backgroundPosition = positions[index];
    const label = document.createElement("span");
    label.textContent = String(index + 1);
    tile.append(label);
    grid.append(tile);
  }
  return grid;
};

const createMidjourneyDownloadButtons = (url, filename) => {
  const group = document.createElement("div");
  group.className = "split-downloads";
  for (let index = 0; index < 4; index += 1) {
    const button = document.createElement("button");
    button.className = "download-button";
    button.type = "button";
    button.textContent = `下载第 ${index + 1} 张`;
    button.addEventListener("click", () => downloadMidjourneyCrop(url, filename, index));
    group.append(button);
  }
  return group;
};

const refreshJob = async (jobId, item) => {
  try {
    setStatus("刷新中", "busy");
    const response = await fetch(`/api/result/${jobId}`);
    const body = await parseJsonResponse(response);
    if (!response.ok || body.status === "error") throw new Error(body.error || "刷新失败");
    upsertHistoryItem({ ...item, result: { ...body, jobId } });
    renderHistory();
    setStatus(body.status === "done" ? "已完成" : "仍在生成", body.status === "done" ? "ready" : "busy");
  } catch (error) {
    setStatus("刷新失败", "error");
    alert(normalizeError(error instanceof Error ? error.message : String(error)));
  }
};

const updateHistoryToggle = (historyLength) => {
  if (!toggleHistory) return;
  const hasMore = historyLength > historyPreviewLimit;
  toggleHistory.hidden = !hasMore;
  toggleHistory.textContent = historyExpanded ? "收起历史记录" : `展开更多记录（${historyLength - historyPreviewLimit}）`;
};

const renderHistory = () => {
  const history = readHistory();
  results.innerHTML = "";
  updateHistoryToggle(history.length);
  if (history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "生成后的图片会显示在这里。";
    results.append(empty);
    return;
  }
  for (const [index, item] of history.entries()) {
    const node = template.content.firstElementChild.cloneNode(true);
    if (!historyExpanded && index >= historyPreviewLimit) node.classList.add("is-collapsed-extra");
    const mediaUrl = findMediaUrl(item.result);
    const base64Image = findBase64Image(item.result);
    const jobId = getJobId(item.result);
    const status = item.result?.status;
    const filename = `shangyan-ai-${new Date(item.createdAt).getTime()}.png`;
    const shouldSplitMidjourney = isMidjourneyResult(item);
    node.querySelector("strong").textContent = item.mode === "video" ? "AI 视频" : "AI 生图";
    node.querySelector("time").textContent = new Date(item.createdAt).toLocaleString("zh-CN");
    node.querySelector("p").hidden = true;
    node.querySelector("pre").textContent = JSON.stringify({ prompt: item.prompt, result: compactValue(item.result) }, null, 2);
    const preview = node.querySelector(".preview");
    const actions = node.querySelector(".result-actions");
    if (mediaUrl) {
      const isVideo = item.mode === "video" || /\.(mp4|webm|mov)(\?|$)/i.test(mediaUrl);
      if (!isVideo && shouldSplitMidjourney) {
        preview.append(createMidjourneySplitPreview(mediaUrl));
        actions.append(createMidjourneyDownloadButtons(mediaUrl, filename));
      } else {
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
      }
    } else if (base64Image) {
      const image = document.createElement("img");
      image.src = `data:image/png;base64,${base64Image}`;
      image.alt = item.prompt;
      preview.append(image);
      const button = document.createElement("button");
      button.className = "download-button";
      button.type = "button";
      button.textContent = "下载";
      button.addEventListener("click", () => downloadDirect(image.src, filename));
      actions.append(button);
    } else if (jobId && (status === "queued" || status === "running")) {
      preview.innerHTML = "<span class=\"loading-text\">生成中，请稍等。Midjourney 任务通常会更慢。</span>";
      const button = document.createElement("button");
      button.className = "download-button";
      button.type = "button";
      button.textContent = "刷新结果";
      button.addEventListener("click", () => refreshJob(jobId, item));
      actions.append(button);
    } else {
      preview.textContent = "接口已返回结果，请展开查看原始内容。";
    }
    results.append(node);
  }
};

const updateModelMode = () => {
  const model = new FormData(form).get("model");
  const isMj = isMidjourneyModel(model);
  form.classList.toggle("is-midjourney", isMj);
  if (modelNote) {
    modelNote.hidden = !isMj;
    modelNote.textContent = "Midjourney 当前只接文生图，会先返回四宫格预览；生成目录会自动切成 4 张图，并提供单张下载。";
  }
  referenceImage.disabled = isMj;
  if (isMj) referenceImage.value = "";
  referenceImageName.textContent = isMj ? "Midjourney 当前仅支持文生图。" : "可上传商品图、模特图、风格图。当前优先使用 1 张参考图。";
};

const lockApp = () => { appShell.classList.add("is-locked"); accessScreen.classList.add("is-open"); };
const unlockApp = () => { appShell.classList.remove("is-locked"); accessScreen.classList.remove("is-open"); };

const checkAccess = async (accessCode) => {
  const response = await fetch("/api/check-access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessCode }) });
  const body = await parseJsonResponse(response);
  if (!response.ok) throw new Error(body.error || "访问码校验失败");
};

accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  accessError.textContent = "";
  const accessCode = new FormData(accessForm).get("accessCode");
  try { await checkAccess(accessCode); sessionStorage.setItem(accessKey, accessCode); unlockApp(); }
  catch (error) { accessError.textContent = error instanceof Error ? error.message : String(error); }
});

switchAccess.addEventListener("click", () => { sessionStorage.removeItem(accessKey); lockApp(); });

toggleHistory?.addEventListener("click", () => {
  historyExpanded = !historyExpanded;
  renderHistory();
});

referenceImage.addEventListener("change", () => {
  const files = Array.from(referenceImage.files || []);
  const model = new FormData(form).get("model");
  if (isMidjourneyModel(model)) {
    referenceImageName.textContent = "Midjourney 当前仅支持文生图。";
    return;
  }
  referenceImageName.textContent = files.length > 0 ? `已选择 ${files.length} 张，本次先使用第 1 张：${files[0].name}` : "可上传商品图、模特图、风格图。当前优先使用 1 张参考图。";
});

form.addEventListener("change", (event) => {
  if (event.target?.name !== "model") return;
  updateModelMode();
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
      if (isMidjourneyModel(data.model)) throw new Error("Midjourney 当前只支持文生图，请先移除参考图。");
      if (!files[0].type.startsWith("image/")) throw new Error("参考图必须是图片文件。");
      data.referenceImages = [await resizeImage(files[0])];
    }
    const response = await fetch("/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    const body = await parseJsonResponse(response);
    if (!response.ok || body.ok === false) throw new Error(body.error || "生成失败");
    const createdAt = new Date().toISOString();
    const pendingItem = compactHistoryItem({ createdAt, mode: data.mode, prompt: data.prompt, result: { jobId: body.jobId, status: body.status || "queued", request: { clarity: data.resolution, model: data.model, quality: data.quality, ratio: data.ratio, size: data.size } } });
    if (body.jobId) { upsertHistoryItem(pendingItem); renderHistory(); }
    const finalBody = body.jobId ? await waitForJob(body.jobId, pendingItem) : body;
    if (finalBody.ok === false) throw new Error(finalBody.error || "生成失败");
    const finishedAt = finalBody.completedAt || finalBody.finishedAt || finalBody.createdAt || new Date().toISOString();
    const rawResult = finalBody.result || finalBody;
    const historyItem = compactHistoryItem({ createdAt: finishedAt, mode: data.mode, prompt: data.prompt, result: rawResult });
    if (findMediaUrl(rawResult)?.startsWith("data:") || findBase64Image(rawResult)) {
      volatileHistory.unshift({ createdAt: finishedAt, mode: data.mode, prompt: data.prompt, result: rawResult });
      volatileHistory = volatileHistory.slice(0, 3);
    }
    if (body.jobId) upsertHistoryItem({ ...historyItem, result: { ...historyItem.result, jobId: body.jobId } });
    else saveHistory([historyItem, ...readStoredHistory()]);
    historyExpanded = false;
    renderHistory();
    setStatus("已完成");
  } catch (error) {
    const message = normalizeError(error instanceof Error ? error.message : String(error));
    setStatus(message.includes("后台仍在生成") ? "后台生成中" : "失败", message.includes("后台仍在生成") ? "busy" : "error");
    alert(message);
  } finally {
    submitButton.disabled = false;
  }
});

clearHistory.addEventListener("click", () => { volatileHistory = []; localStorage.removeItem(storageKey); historyExpanded = false; renderHistory(); });
openHistory.addEventListener("click", () => { renderHistory(); results.scrollIntoView({ behavior: "smooth", block: "nearest" }); setStatus("历史记录"); });

const initAccess = async () => {
  renderHistory();
  updateModelMode();
  const savedAccessCode = sessionStorage.getItem(accessKey);
  if (!savedAccessCode) return lockApp();
  try { await checkAccess(savedAccessCode); unlockApp(); }
  catch { sessionStorage.removeItem(accessKey); lockApp(); }
};

initAccess();
