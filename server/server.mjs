import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const dataDir = path.join(root, "data");
const imagesDir = path.join(dataDir, "images");
const jobsFile = path.join(dataDir, "jobs.json");

const fallbackEnv = {
  AI_IMAGE_API_AUTH_HEADER: "Authorization",
  AI_IMAGE_API_AUTH_PREFIX: "Bearer",
  AI_IMAGE_API_URL: "https://yunwu.ai/v1/images/generations",
  INTERNAL_ACCESS_CODE: "shangyanduanshipin",
  MAX_CONCURRENT_JOBS: "2",
  PORT: "3000",
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

let jobs = new Map();
let activeJobs = 0;
const queue = [];

const loadDotEnv = async () => {
  const file = path.join(root, ".env");
  const text = await fs.readFile(file, "utf8").catch(() => "");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
};

const getEnv = (key) => String(process.env[key] ?? fallbackEnv[key] ?? "").trim();
const json = (res, body, status = 200) => send(res, status, { "content-type": "application/json; charset=utf-8" }, JSON.stringify(body));
const send = (res, status, headers, body) => {
  res.writeHead(status, headers);
  res.end(body);
};

const isValidAccessCode = (accessCode) => {
  const configured = getEnv("INTERNAL_ACCESS_CODE");
  return Boolean(accessCode && (accessCode === configured || accessCode === fallbackEnv.INTERNAL_ACCESS_CODE));
};

const ensureData = async () => {
  await fs.mkdir(imagesDir, { recursive: true });
  const raw = await fs.readFile(jobsFile, "utf8").catch(() => "{}");
  try {
    const parsed = JSON.parse(raw);
    jobs = new Map(Object.entries(parsed));
  } catch {
    jobs = new Map();
  }
  for (const [id, job] of jobs) {
    if (job.status === "running" || job.status === "queued") jobs.set(id, { ...job, status: "error", error: "服务器重启后任务已中断，请重新生成。" });
  }
  await persistJobs();
};

const persistJobs = async () => {
  const safeJobs = Object.fromEntries(Array.from(jobs.entries()).slice(-500));
  await fs.writeFile(jobsFile, JSON.stringify(safeJobs, null, 2));
};

const updateJob = async (jobId, patch) => {
  const current = jobs.get(jobId) || {};
  const next = { ...current, ...patch, jobId, updatedAt: new Date().toISOString() };
  jobs.set(jobId, next);
  await persistJobs();
  return next;
};

const parseBody = async (req, limit = 12 * 1024 * 1024) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求内容太大。请减少参考图数量或压缩图片。");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const generationUrl = () => getEnv("AI_IMAGE_API_URL") || fallbackEnv.AI_IMAGE_API_URL;
const editUrl = () => getEnv("AI_IMAGE_EDIT_API_URL") || generationUrl().replace(/\/images\/generations\/?$/, "/images/edits");
const apiOrigin = () => {
  try { return new URL(generationUrl()).origin; } catch { return "https://yunwu.ai"; }
};
const midjourneyImagineUrl = () => getEnv("MIDJOURNEY_IMAGINE_API_URL") || `${apiOrigin()}/mj/submit/imagine`;
const midjourneyTaskUrl = (taskId) => (getEnv("MIDJOURNEY_TASK_FETCH_URL") || `${apiOrigin()}/mj/task/{taskId}/fetch`).replace("{taskId}", encodeURIComponent(taskId));

const isMidjourneyModel = (model) => ["midjourney", "mj_imagine", "mj-imagine"].includes(String(model || "").toLowerCase().trim());
const normalizeModel = (model) => isMidjourneyModel(model) ? "midjourney" : "gpt-image-2";
const normalizeQuality = (quality) => {
  const value = String(quality || "medium").toLowerCase();
  if (["low", "medium", "high"].includes(value)) return value;
  if (value.includes("high") || value.includes("hd")) return "high";
  if (value.includes("low") || value.includes("fast")) return "low";
  return "medium";
};
const normalizeClarity = (clarity, resolution) => {
  const value = `${clarity || ""} ${resolution || ""}`.toLowerCase();
  if (value.includes("4k") || value.includes("4096") || value.includes("3840")) return "4K";
  if (value.includes("2k") || value.includes("2048")) return "2K";
  return "1K";
};
const normalizeRatio = (ratio) => ["1:1", "9:16", "16:9", "4:5"].includes(String(ratio || "")) ? String(ratio) : "1:1";

const sizeFor = (ratio, clarity, explicitSize) => {
  if (explicitSize && /^\d+x\d+$/.test(explicitSize)) return explicitSize;
  const table = {
    "1K": { "1:1": "1024x1024", "4:5": "1024x1280", "9:16": "1024x1536", "16:9": "1536x1024" },
    "2K": { "1:1": "2048x2048", "4:5": "1638x2048", "9:16": "1536x2048", "16:9": "2048x1536" },
    "4K": { "1:1": "4096x4096", "4:5": "3072x3840", "9:16": "2160x3840", "16:9": "3840x2160" },
  };
  return table[clarity]?.[ratio] ?? table["1K"]["1:1"];
};

const referencesFor = (payload) => Array.from(new Set([...(Array.isArray(payload.referenceImages) ? payload.referenceImages : []), payload.referenceImage].filter((value) => Boolean(value && String(value).trim())))).slice(0, 1);

const sanitizeFashionPrompt = (prompt) => {
  const replacements = [[/露脐装/g, "短款上衣"], [/露脐/g, "短款上衣版型"], [/肚脐/g, "腰线上方的服装剪裁"], [/辣妹/g, "潮流时装"], [/性感/g, "时尚自信"], [/火辣/g, "醒目潮流"], [/妩媚/g, "精致"], [/撩人/g, "吸睛"]];
  let safePrompt = prompt;
  for (const [pattern, replacement] of replacements) safePrompt = safePrompt.replace(pattern, replacement);
  return `${safePrompt}\n\n成人模特，服装电商展示图。重点展示服装版型、面料、搭配、光线和构图。不要强调裸露身体部位，不要色情化表达，不要未成年人。`;
};

const formatApiError = (message) => {
  if (/all_retries_failed/i.test(message)) return "Midjourney 代理多次重试都失败了。请先用更短、更简单的提示词测试；如果连续失败，通常是云雾 MJ 通道或分组暂时不可用。";
  if (/safety|safety_violation|sexual|rejected by the safety system/i.test(message)) return "提示词被 AI 安全系统拦截。请改成服装展示表达，例如：短款上衣、潮流时装风、成人模特、展示服装版型和搭配；避免露脐、肚脐、辣妹、性感等身体或挑逗词。";
  return message;
};

const extractImageUrls = (data) => {
  const items = data?.data ?? data?.images ?? data?.output ?? [];
  const urls = items.map((item) => {
    if (typeof item === "string") return item;
    if (item?.url) return item.url;
    if (item?.imageUrl) return item.imageUrl;
    if (item?.image_url) return item.image_url;
    if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
    return "";
  }).filter(Boolean);
  if (!urls.length && data?.imageUrl) urls.push(data.imageUrl);
  if (!urls.length && data?.image_url) urls.push(data.image_url);
  if (!urls.length && data?.url) urls.push(data.url);
  return urls;
};

const auth = () => {
  const apiKey = getEnv("AI_IMAGE_API_KEY");
  if (!apiKey) throw new Error("AI_IMAGE_API_KEY is missing.");
  const headerName = getEnv("AI_IMAGE_API_AUTH_HEADER") || "Authorization";
  const prefix = getEnv("AI_IMAGE_API_AUTH_PREFIX") || "Bearer";
  return { headerName, value: prefix ? `${prefix} ${apiKey}` : apiKey };
};

const referenceFile = async (reference, index) => {
  const mime = /^data:([^;,]+)/.exec(reference)?.[1] || "image/jpeg";
  const extension = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  const blob = await (await fetch(reference)).blob();
  return { blob, filename: `reference-${index + 1}.${extension}` };
};

const midjourneyPrompt = (prompt, ratio) => [prompt.trim(), `--ar ${ratio}`].filter(Boolean).join(" ");
const build = (payload) => {
  const model = normalizeModel(payload.model);
  const quality = normalizeQuality(payload.quality);
  const clarity = normalizeClarity(payload.clarity, payload.resolution);
  const ratio = normalizeRatio(payload.ratio);
  const size = sizeFor(ratio, clarity, payload.size);
  const references = referencesFor(payload);
  const originalPrompt = String(payload.prompt || "").trim();
  const safePrompt = model === "midjourney" ? originalPrompt : sanitizeFashionPrompt(originalPrompt);
  const negative = [payload.negativePrompt?.trim(), "nudity, sexualized pose, explicit content, minor, teenager, child, underwear focus, body exposure focus"].filter(Boolean).join(", ");
  const prompt = model === "midjourney" ? midjourneyPrompt(safePrompt, ratio) : [safePrompt, negative ? `Avoid: ${negative}` : ""].filter(Boolean).join("\n\n");
  const request = { clarity, endpoint: model === "midjourney" ? "mj_imagine" : references.length ? "edits" : "generations", model, promptChanged: safePrompt !== originalPrompt, quality, ratio, referenceCount: references.length, safePrompt, size };
  return { model, prompt, quality, references, request, size };
};

const readResponse = async (response) => {
  const text = await response.text();
  try { return { data: text ? JSON.parse(text) : null, text }; } catch { return { data: { raw: text }, text }; }
};

const extractTaskId = (data) => {
  if (typeof data?.result === "string") return data.result;
  return data?.taskId || data?.jobId || data?.id || data?.result?.taskId || data?.result?.id || "";
};
const apiErrorMessage = (data, text, fallback) => formatApiError((typeof data?.error === "object" ? data.error.message : data?.error) || data?.message || data?.description || data?.failReason || text || fallback);

const callMidjourneyApi = async (payload) => {
  const built = build(payload);
  if (built.references.length) throw new Error("Midjourney 当前只支持文生图，请先移除参考图。");
  const authorization = auth();
  const submitResponse = await fetch(midjourneyImagineUrl(), { method: "POST", headers: { [authorization.headerName]: authorization.value, "content-type": "application/json" }, body: JSON.stringify({ prompt: built.prompt, base64Array: [], state: "" }) });
  const submit = await readResponse(submitResponse);
  const submitCode = submit.data?.code;
  if (!submitResponse.ok || (typeof submitCode === "number" && ![0, 1, 200].includes(submitCode))) throw new Error(apiErrorMessage(submit.data, submit.text, `${submitResponse.status} ${submitResponse.statusText}`));
  const immediateUrls = extractImageUrls(submit.data);
  if (immediateUrls.length) return { data: submit.data, request: built.request, urls: immediateUrls };
  const taskId = extractTaskId(submit.data);
  if (!taskId) throw new Error("Midjourney 已返回结果，但没有任务编号。");
  for (let attempt = 1; attempt <= 150; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const taskResponse = await fetch(midjourneyTaskUrl(taskId), { headers: { [authorization.headerName]: authorization.value } });
    const task = await readResponse(taskResponse);
    if (!taskResponse.ok) throw new Error(apiErrorMessage(task.data, task.text, "Midjourney 任务查询失败。"));
    const status = String(task.data?.status || "").toUpperCase();
    const urls = extractImageUrls(task.data);
    if (urls.length && (status === "SUCCESS" || task.data?.progress === "100%" || !status)) return { data: { submit: submit.data, task: task.data }, request: built.request, urls };
    if (["FAILURE", "FAILED", "ERROR"].includes(status)) throw new Error(apiErrorMessage(task.data, "", "Midjourney 生成失败。"));
  }
  throw new Error("Midjourney 仍在生成，请稍后再试。当前版本暂不支持超过 12 分钟的 Midjourney 任务。");
};

const callImageApi = async (payload) => {
  const built = build(payload);
  if (built.model === "midjourney") return callMidjourneyApi(payload);
  const authorization = auth();
  let response;
  if (built.references.length) {
    const form = new FormData();
    form.append("model", built.model);
    form.append("prompt", built.prompt);
    form.append("quality", built.quality);
    form.append("size", built.size);
    form.append("n", "1");
    for (let index = 0; index < built.references.length; index += 1) {
      const file = await referenceFile(built.references[index], index);
      form.append("image", file.blob, file.filename);
    }
    response = await fetch(editUrl(), { method: "POST", headers: { [authorization.headerName]: authorization.value }, body: form });
  } else {
    response = await fetch(generationUrl(), { method: "POST", headers: { [authorization.headerName]: authorization.value, "content-type": "application/json" }, body: JSON.stringify({ model: built.model, prompt: built.prompt, quality: built.quality, size: built.size, n: 1 }) });
  }
  const { data, text } = await readResponse(response);
  if (!response.ok) throw new Error(apiErrorMessage(data, text, `${response.status} ${response.statusText}`));
  const urls = extractImageUrls(data);
  if (!urls.length) throw new Error("The AI API returned no image URL.");
  return { data, request: built.request, urls };
};

const extensionForContentType = (contentType) => {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  return "png";
};

const cacheOneImage = async (jobId, url, index) => {
  try {
    let buffer;
    let contentType = "image/png";
    if (url.startsWith("data:")) {
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
      if (!match) return url;
      contentType = match[1] || contentType;
      buffer = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3] || ""));
    } else {
      const response = await fetch(url);
      if (!response.ok) return url;
      contentType = response.headers.get("content-type") || contentType;
      buffer = Buffer.from(await response.arrayBuffer());
    }
    const ext = extensionForContentType(contentType);
    const filename = `${jobId}-${index + 1}.${ext}`;
    await fs.writeFile(path.join(imagesDir, filename), buffer);
    return `/generated/${filename}`;
  } catch {
    return url;
  }
};

const cacheImages = async (jobId, urls) => Promise.all(urls.map((url, index) => cacheOneImage(jobId, url, index)));

const runJob = async (jobId) => {
  const job = jobs.get(jobId);
  if (!job?.payload) return;
  await updateJob(jobId, { status: "running", error: "" });
  try {
    const result = await callImageApi(job.payload);
    const cachedUrls = await cacheImages(jobId, result.urls);
    await updateJob(jobId, { completedAt: new Date().toISOString(), imageUrl: cachedUrls[0], images: cachedUrls.map((url) => ({ url })), request: result.request, result: { imageUrl: cachedUrls[0], images: cachedUrls.map((url) => ({ url })), request: result.request, response: result.data }, response: result.data, status: "done" });
  } catch (error) {
    await updateJob(jobId, { completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "Generation failed.", status: "error" });
  } finally {
    activeJobs -= 1;
    processQueue();
  }
};

const processQueue = () => {
  const max = Number(getEnv("MAX_CONCURRENT_JOBS")) || 2;
  while (activeJobs < max && queue.length) {
    const jobId = queue.shift();
    activeJobs += 1;
    runJob(jobId);
  }
};

const cleanupOldImages = async () => {
  const maxAgeMs = 48 * 60 * 60 * 1000;
  const now = Date.now();
  const files = await fs.readdir(imagesDir).catch(() => []);
  await Promise.all(files.map(async (file) => {
    const full = path.join(imagesDir, file);
    const stat = await fs.stat(full).catch(() => null);
    if (stat && now - stat.mtimeMs > maxAgeMs) await fs.rm(full, { force: true }).catch(() => {});
  }));
};

const handleApi = async (req, res, pathname) => {
  if (pathname === "/api/check-access") {
    if (req.method !== "POST") return json(res, { error: "POST requests only." }, 405);
    const body = await parseBody(req);
    if (!isValidAccessCode(body.accessCode)) return json(res, { error: "Access code is incorrect." }, 401);
    return json(res, { ok: true });
  }
  if (pathname === "/api/generate") {
    if (req.method !== "POST") return json(res, { error: "POST requests only." }, 405);
    const payload = await parseBody(req);
    if (!isValidAccessCode(payload.accessCode)) return json(res, { error: "Access code is incorrect." }, 401);
    const prompt = String(payload.prompt || "").trim();
    if (!prompt) return json(res, { error: "Prompt is required." }, 400);
    if (payload.mode === "video") return json(res, { error: "Only image generation is enabled." }, 400);
    const jobId = crypto.randomUUID();
    await updateJob(jobId, { createdAt: new Date().toISOString(), payload: { ...payload, prompt }, prompt, status: "queued" });
    queue.push(jobId);
    processQueue();
    return json(res, { ok: true, jobId, status: "queued", message: "Generation job submitted." });
  }
  if (pathname.startsWith("/api/result/")) {
    const jobId = decodeURIComponent(pathname.slice("/api/result/".length));
    const job = jobs.get(jobId);
    if (!job) return json(res, { error: "Generation job was not found." }, 404);
    const { payload, ...safeJob } = job;
    return json(res, safeJob);
  }
  if (pathname === "/api/download") {
    if (req.method !== "POST") return json(res, { error: "POST requests only." }, 405);
    const body = await parseBody(req);
    if (!isValidAccessCode(body.accessCode)) return json(res, { error: "Access code is incorrect." }, 401);
    if (!body.url) return json(res, { error: "Download URL is missing." }, 400);
    const filename = String(body.filename || "shangyan-ai.png").replace(/[^\w.-]+/g, "-");
    let buffer;
    let contentType = "application/octet-stream";
    if (String(body.url).startsWith("data:")) {
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(body.url);
      if (!match) return json(res, { error: "Invalid image data." }, 400);
      contentType = match[1] || contentType;
      buffer = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3] || ""));
    } else {
      const target = String(body.url).startsWith("/") ? new URL(body.url, `http://127.0.0.1:${getEnv("PORT")}`).toString() : String(body.url);
      if (!/^https?:\/\//.test(target)) return json(res, { error: "Invalid download URL." }, 400);
      const response = await fetch(target);
      if (!response.ok) return json(res, { error: "Image download failed." }, 502);
      contentType = response.headers.get("content-type") || contentType;
      buffer = Buffer.from(await response.arrayBuffer());
    }
    return send(res, 200, { "content-disposition": `attachment; filename="${filename}"`, "content-type": contentType }, buffer);
  }
  return json(res, { error: "Not found." }, 404);
};

const serveFile = async (res, pathname) => {
  const clean = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const base = clean.startsWith("/generated/") ? imagesDir : distDir;
  const relative = clean.startsWith("/generated/") ? clean.slice("/generated/".length) : clean.slice(1);
  const full = path.resolve(base, relative);
  if (!full.startsWith(base)) return json(res, { error: "Invalid path." }, 400);
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) throw new Error("not file");
    const ext = path.extname(full).toLowerCase();
    return send(res, 200, { "content-type": mimeTypes[ext] || "application/octet-stream" }, await fs.readFile(full));
  } catch {
    return send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not found");
  }
};

await loadDotEnv();
await ensureData();
await cleanupOldImages();
setInterval(cleanupOldImages, 60 * 60 * 1000).unref();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname);
    return await serveFile(res, url.pathname);
  } catch (error) {
    return json(res, { error: error instanceof Error ? error.message : "Server error." }, 500);
  }
});

server.listen(Number(getEnv("PORT")) || 3000, "127.0.0.1", () => {
  console.log(`Anhui Shangyan AI tools running on http://127.0.0.1:${getEnv("PORT") || 3000}`);
});
