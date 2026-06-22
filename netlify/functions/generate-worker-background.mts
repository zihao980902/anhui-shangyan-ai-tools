import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";

declare const process: { env?: Record<string, string | undefined> };

type GenerateRequest = {
  accessCode?: string;
  clarity?: string;
  mode?: "image" | "video";
  model?: string;
  negativePrompt?: string;
  prompt?: string;
  quality?: string;
  ratio?: string;
  referenceImage?: string;
  referenceImages?: string[];
  resolution?: string;
  size?: string;
};

type StoredJob = {
  createdAt?: string;
  jobId?: string;
  payload?: GenerateRequest;
  prompt?: string;
  status?: string;
};

type RequestInfo = {
  clarity: string;
  endpoint: "generations" | "edits";
  model: string;
  promptChanged: boolean;
  quality: string;
  ratio: string;
  referenceCount: number;
  safePrompt: string;
  size: string;
};

const fallbackEnv: Record<string, string> = {
  AI_IMAGE_API_AUTH_HEADER: "Authorization",
  AI_IMAGE_API_AUTH_PREFIX: "Bearer",
  AI_IMAGE_API_URL: "https://yunwu.ai/v1/images/generations",
};

const getEnv = (key: string) => {
  const netlify = (globalThis as { Netlify?: { env?: { get?: (name: string) => string | undefined } } }).Netlify;
  return (netlify?.env?.get?.(key) ?? process.env?.[key] ?? fallbackEnv[key] ?? "").trim();
};

const getApiKey = async () => {
  const fromEnv = getEnv("AI_IMAGE_API_KEY");
  if (fromEnv) return fromEnv;
  const store = getStore("ai-private-config", { consistency: "strong" });
  return ((await store.get("AI_IMAGE_API_KEY", { type: "text" })) ?? "").trim();
};

const generationUrl = () => getEnv("AI_IMAGE_API_URL") || fallbackEnv.AI_IMAGE_API_URL;
const editUrl = () => getEnv("AI_IMAGE_EDIT_API_URL") || generationUrl().replace(/\/images\/generations\/?$/, "/images/edits");

const normalizeModel = (model?: string) => (String(model || "").toLowerCase().trim() === "image2" ? "gpt-image-2" : "gpt-image-2");
const normalizeQuality = (quality?: string) => {
  const value = String(quality || "medium").toLowerCase();
  if (["low", "medium", "high"].includes(value)) return value;
  if (value.includes("high") || value.includes("hd")) return "high";
  if (value.includes("low") || value.includes("fast")) return "low";
  return "medium";
};
const normalizeClarity = (clarity?: string, resolution?: string) => {
  const value = `${clarity || ""} ${resolution || ""}`.toLowerCase();
  if (value.includes("4k") || value.includes("4096") || value.includes("3840")) return "4K";
  if (value.includes("2k") || value.includes("2048")) return "2K";
  return "1K";
};
const normalizeRatio = (ratio?: string) => (["1:1", "9:16", "16:9", "4:5"].includes(String(ratio || "")) ? String(ratio) : "1:1");

const sizeFor = (ratio: string, clarity: string, explicitSize?: string) => {
  if (explicitSize && /^\d+x\d+$/.test(explicitSize)) return explicitSize;
  const table: Record<string, Record<string, string>> = {
    "1K": { "1:1": "1024x1024", "4:5": "1024x1280", "9:16": "1024x1536", "16:9": "1536x1024" },
    "2K": { "1:1": "2048x2048", "4:5": "1638x2048", "9:16": "1536x2048", "16:9": "2048x1536" },
    "4K": { "1:1": "4096x4096", "4:5": "3072x3840", "9:16": "2160x3840", "16:9": "3840x2160" },
  };
  return table[clarity]?.[ratio] ?? table["1K"]["1:1"];
};

const referencesFor = (payload: GenerateRequest) => Array.from(new Set([
  ...(Array.isArray(payload.referenceImages) ? payload.referenceImages : []),
  payload.referenceImage,
].filter((value): value is string => Boolean(value && value.trim())))).slice(0, 1);

const sanitizeFashionPrompt = (prompt: string) => {
  const replacements: Array<[RegExp, string]> = [
    [/露脐装/g, "短款上衣"],
    [/露脐/g, "短款上衣版型"],
    [/肚脐/g, "腰线上方的服装剪裁"],
    [/辣妹/g, "潮流时装"],
    [/性感/g, "时尚自信"],
    [/火辣/g, "醒目潮流"],
    [/妩媚/g, "精致"],
    [/撩人/g, "吸睛"],
  ];
  let safePrompt = prompt;
  for (const [pattern, replacement] of replacements) safePrompt = safePrompt.replace(pattern, replacement);
  return `${safePrompt}\n\n成人模特，服装电商展示图。重点展示服装版型、面料、搭配、光线和构图。不要强调裸露身体部位，不要色情化表达，不要未成年人。`;
};

const formatApiError = (message: string) => {
  if (/safety|safety_violation|sexual|rejected by the safety system/i.test(message)) {
    return "提示词被 AI 安全系统拦截。请改成服装展示表达，例如：短款上衣、潮流时装风、成人模特、展示服装版型和搭配；避免露脐、肚脐、辣妹、性感等身体或挑逗词。";
  }
  return message;
};

const extractImageUrls = (data: unknown) => {
  const value = data as { data?: Array<{ b64_json?: string; url?: string }>; images?: Array<{ b64_json?: string; url?: string } | string>; output?: Array<{ b64_json?: string; url?: string } | string>; url?: string };
  const items = value.data ?? value.images ?? value.output ?? [];
  const urls = items.map((item) => {
    if (typeof item === "string") return item;
    if (item?.url) return item.url;
    if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
    return "";
  }).filter(Boolean);
  if (!urls.length && value.url) urls.push(value.url);
  return urls;
};

const auth = async () => {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("AI_IMAGE_API_KEY is missing.");
  const headerName = getEnv("AI_IMAGE_API_AUTH_HEADER") || "Authorization";
  const prefix = getEnv("AI_IMAGE_API_AUTH_PREFIX") || "Bearer";
  return { headerName, value: prefix ? `${prefix} ${apiKey}` : apiKey };
};

const referenceFile = async (reference: string, index: number) => {
  const mime = /^data:([^;,]+)/.exec(reference)?.[1] || "image/jpeg";
  const extension = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  const blob = await (await fetch(reference)).blob();
  return { blob, filename: `reference-${index + 1}.${extension}` };
};

const build = (payload: GenerateRequest) => {
  const model = normalizeModel(payload.model);
  const quality = normalizeQuality(payload.quality);
  const clarity = normalizeClarity(payload.clarity, payload.resolution);
  const ratio = normalizeRatio(payload.ratio);
  const size = sizeFor(ratio, clarity, payload.size);
  const references = referencesFor(payload);
  const originalPrompt = payload.prompt?.trim() || "";
  const safePrompt = sanitizeFashionPrompt(originalPrompt);
  const negative = [payload.negativePrompt?.trim(), "nudity, sexualized pose, explicit content, minor, teenager, child, underwear focus, body exposure focus"].filter(Boolean).join(", ");
  const prompt = [safePrompt, negative ? `Avoid: ${negative}` : ""].filter(Boolean).join("\n\n");
  const request: RequestInfo = { clarity, endpoint: references.length ? "edits" : "generations", model, promptChanged: safePrompt !== originalPrompt, quality, ratio, referenceCount: references.length, safePrompt, size };
  return { model, prompt, quality, references, request, size };
};

const readResponse = async (response: Response) => {
  const text = await response.text();
  try {
    return { data: text ? JSON.parse(text) : null, text };
  } catch {
    return { data: { raw: text }, text };
  }
};

const callImageApi = async (payload: GenerateRequest) => {
  const built = build(payload);
  const authorization = await auth();
  let response: Response;

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
    response = await fetch(generationUrl(), {
      method: "POST",
      headers: { [authorization.headerName]: authorization.value, "content-type": "application/json" },
      body: JSON.stringify({ model: built.model, prompt: built.prompt, quality: built.quality, size: built.size, n: 1 }),
    });
  }

  const { data, text } = await readResponse(response);
  if (!response.ok) {
    const message = (data as { error?: { message?: string }; message?: string })?.error?.message
      ?? (data as { error?: string; message?: string })?.error
      ?? (data as { message?: string })?.message
      ?? text
      ?? `${response.status} ${response.statusText}`;
    throw new Error(formatApiError(String(message)));
  }

  const urls = extractImageUrls(data);
  if (!urls.length) throw new Error("The AI API returned no image URL.");
  return { data, request: built.request, urls };
};

export default async (req: Request) => {
  const body = (await req.json().catch(() => ({}))) as { jobId?: string; payload?: GenerateRequest };
  const jobId = body.jobId;
  if (!jobId) return;

  const store = getStore("ai-generation-jobs", { consistency: "strong" });
  const saved = (await store.get(jobId, { type: "json" })) as StoredJob | null;
  const payload = body.payload ?? saved?.payload;
  const prompt = payload?.prompt?.trim() || saved?.prompt || "";
  const baseJob = { createdAt: saved?.createdAt ?? new Date().toISOString(), jobId, prompt };

  const update = async (value: Record<string, unknown>) => store.setJSON(jobId, value);
  if (!payload?.prompt) {
    await update({ ...baseJob, completedAt: new Date().toISOString(), error: "Generation payload was not found.", status: "error" });
    return;
  }

  await update({ ...baseJob, status: "running", updatedAt: new Date().toISOString() });

  try {
    const result = await callImageApi(payload);
    await update({
      ...baseJob,
      completedAt: new Date().toISOString(),
      imageUrl: result.urls[0],
      images: result.urls.map((url) => ({ url })),
      request: result.request,
      result: { imageUrl: result.urls[0], images: result.urls.map((url) => ({ url })), request: result.request, response: result.data },
      response: result.data,
      status: "done",
    });
  } catch (error) {
    await update({ ...baseJob, completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "Generation failed.", status: "error" });
  }
};

export const config: Config = { path: "/api/generate-worker" };
