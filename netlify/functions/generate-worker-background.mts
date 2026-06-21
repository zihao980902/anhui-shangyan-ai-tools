import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";

declare const process: {
  env?: Record<string, string | undefined>;
};

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

type WorkerRequest = {
  jobId?: string;
  payload?: GenerateRequest;
};

type RequestInfo = {
  clarity: string;
  endpoint: string;
  model: string;
  promptChanged?: boolean;
  quality: string;
  ratio: string;
  referenceCount: number;
  safePrompt?: string;
  size: string;
};

type JobResult = {
  completedAt?: string;
  createdAt?: string;
  error?: string;
  imageUrl?: string;
  images?: Array<{ url: string }>;
  jobId?: string;
  prompt?: string;
  request?: RequestInfo;
  result?: unknown;
  response?: unknown;
  status: "queued" | "running" | "done" | "error";
  updatedAt?: string;
};

const fallbackEnv: Record<string, string> = {
  AI_IMAGE_API_AUTH_HEADER: "Authorization",
  AI_IMAGE_API_AUTH_PREFIX: "Bearer",
  AI_IMAGE_API_URL: "https://yunwu.ai/v1/images/generations",
  INTERNAL_ACCESS_CODE: "shangyanduanshipin",
};

const getEnv = (key: string) => {
  const netlify = (globalThis as {
    Netlify?: { env?: { get?: (name: string) => string | undefined } };
  }).Netlify;
  return (netlify?.env?.get?.(key) ?? process.env?.[key] ?? fallbackEnv[key] ?? "").trim();
};

const getApiKey = async () => {
  const fromEnv = getEnv("AI_IMAGE_API_KEY");
  if (fromEnv) return fromEnv;

  const store = getStore("ai-private-config", { consistency: "strong" });
  const fromBlob = await store.get("AI_IMAGE_API_KEY", { type: "text" });
  return (fromBlob ?? "").trim();
};

const generationUrl = () => getEnv("AI_IMAGE_API_URL") || fallbackEnv.AI_IMAGE_API_URL;

const editUrl = () => {
  const explicit = getEnv("AI_IMAGE_EDIT_API_URL");
  if (explicit) return explicit;
  return generationUrl().replace(/\/images\/generations\/?$/, "/images/edits");
};

const normalizeModel = (model?: string) => {
  const value = (model || "").trim().toLowerCase();
  if (value === "image2" || value === "gpt-image-2") return "gpt-image-2";
  return "gpt-image-2";
};

const normalizeQuality = (quality?: string) => {
  const value = (quality || "").trim().toLowerCase();
  if (["low", "medium", "high"].includes(value)) return value;
  if (value.includes("low") || value.includes("standard")) return "low";
  if (value.includes("high") || value.includes("hd")) return "high";
  return "medium";
};

const normalizeClarity = (clarity?: string, resolution?: string) => {
  const value = `${clarity || ""} ${resolution || ""}`.toLowerCase();
  if (value.includes("4k") || value.includes("4096") || value.includes("3840")) return "4K";
  if (value.includes("2k") || value.includes("2048")) return "2K";
  return "1K";
};

const normalizeRatio = (ratio?: string) => {
  const value = (ratio || "").trim();
  if (["1:1", "9:16", "16:9", "4:5"].includes(value)) return value;
  return "1:1";
};

const sizeFor = (ratio: string, clarity: string, explicitSize?: string) => {
  if (explicitSize && /^\d+x\d+$/.test(explicitSize)) return explicitSize;

  const table: Record<string, Record<string, string>> = {
    "1K": {
      "1:1": "1024x1024",
      "4:5": "1024x1280",
      "9:16": "1024x1536",
      "16:9": "1536x1024",
    },
    "2K": {
      "1:1": "2048x2048",
      "4:5": "1638x2048",
      "9:16": "1536x2048",
      "16:9": "2048x1536",
    },
    "4K": {
      "1:1": "4096x4096",
      "4:5": "3072x3840",
      "9:16": "2160x3840",
      "16:9": "3840x2160",
    },
  };

  return table[clarity]?.[ratio] ?? table["1K"]["1:1"];
};

const collectReferenceImages = (payload: GenerateRequest) => {
  const images = [
    ...(Array.isArray(payload.referenceImages) ? payload.referenceImages : []),
    payload.referenceImage,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .slice(0, 6);

  return [...new Set(images)];
};

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
    [/身材火辣/g, "身形修长"],
    [/上衣.*很少/g, "短款上衣搭配高腰下装"],
  ];

  let safePrompt = prompt;
  for (const [pattern, replacement] of replacements) {
    safePrompt = safePrompt.replace(pattern, replacement);
  }

  const guidance = [
    "成人模特，服装电商展示图。",
    "重点展示服装版型、面料、搭配、光线和构图。",
    "不要强调裸露身体部位，不要色情化表达，不要未成年人。",
  ].join(" ");

  return `${safePrompt}\n\n${guidance}`;
};

const formatApiError = (message: string) => {
  if (/safety|safety_violation|sexual|rejected by the safety system/i.test(message)) {
    return "提示词被 AI 安全系统拦截。请改成服装展示表达，例如：短款上衣、潮流时装风、成人模特、展示服装版型和搭配；避免露脐、肚脐、辣妹、性感等身体或挑逗词。";
  }
  return message;
};

const extractImageUrls = (data: unknown) => {
  const response = data as {
    data?: Array<{ b64_json?: string; url?: string }>;
    images?: Array<{ b64_json?: string; url?: string } | string>;
    output?: Array<{ b64_json?: string; url?: string } | string>;
    url?: string;
  };

  const values = response.data ?? response.images ?? response.output ?? [];
  const urls = values
    .map((item) => {
      if (typeof item === "string") return item;
      if (item?.url) return item.url;
      if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
      return "";
    })
    .filter(Boolean);

  if (!urls.length && response.url) urls.push(response.url);
  return urls;
};

const authHeader = async () => {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("AI_IMAGE_API_KEY is missing.");

  const headerName = getEnv("AI_IMAGE_API_AUTH_HEADER") || "Authorization";
  const prefix = getEnv("AI_IMAGE_API_AUTH_PREFIX") || "Bearer";
  return { headerName, value: prefix ? `${prefix} ${apiKey}` : apiKey };
};

const jsonHeaders = async () => {
  const auth = await authHeader();
  return {
    [auth.headerName]: auth.value,
    "content-type": "application/json",
  };
};

const dataUrlToBlob = (dataUrl: string, index: number) => {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Reference image data is invalid.");

  const contentType = match[1] || "image/jpeg";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  const bytes = isBase64
    ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload));
  const extension = contentType.includes("png") ? "png" : "jpg";

  return {
    blob: new Blob([bytes], { type: contentType }),
    filename: `reference-${index + 1}.${extension}`,
  };
};

const buildRequest = (payload: GenerateRequest) => {
  const model = normalizeModel(payload.model);
  const quality = normalizeQuality(payload.quality);
  const clarity = normalizeClarity(payload.clarity, payload.resolution);
  const ratio = normalizeRatio(payload.ratio);
  const size = sizeFor(ratio, clarity, payload.size);
  const references = collectReferenceImages(payload);
  const originalPrompt = payload.prompt?.trim() || "";
  const safePrompt = sanitizeFashionPrompt(originalPrompt);
  const negativePrompt = [
    payload.negativePrompt?.trim(),
    "nudity, sexualized pose, explicit content, minor, teenager, child, underwear focus, body exposure focus",
  ]
    .filter(Boolean)
    .join(", ");
  const prompt = [safePrompt, negativePrompt ? `Avoid: ${negativePrompt}` : ""]
    .filter(Boolean)
    .join("\n\n");
  const request: RequestInfo = {
    clarity,
    endpoint: references.length ? "edits" : "generations",
    model,
    promptChanged: safePrompt !== originalPrompt,
    quality,
    ratio,
    referenceCount: references.length,
    safePrompt,
    size,
  };

  return { model, prompt, quality, references, request, size };
};

const readApiResponse = async (response: Response) => {
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { data, text };
};

const callGenerationApi = async (payload: GenerateRequest) => {
  const { model, prompt, quality, request, size } = buildRequest(payload);
  const response = await fetch(generationUrl(), {
    method: "POST",
    headers: await jsonHeaders(),
    body: JSON.stringify({ model, prompt, quality, size, n: 1 }),
  });
  const { data, text } = await readApiResponse(response);
  return { data, request, response, text };
};

const callEditApi = async (payload: GenerateRequest) => {
  const { model, prompt, quality, references, request, size } = buildRequest(payload);
  const auth = await authHeader();
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("quality", quality);
  form.append("size", size);
  form.append("n", "1");

  references.forEach((reference, index) => {
    const { blob, filename } = dataUrlToBlob(reference, index);
    form.append("image", blob, filename);
  });

  const response = await fetch(editUrl(), {
    method: "POST",
    headers: { [auth.headerName]: auth.value },
    body: form,
  });
  const { data, text } = await readApiResponse(response);
  return { data, request, response, text };
};

const callImageApi = async (payload: GenerateRequest) => {
  const references = collectReferenceImages(payload);
  const result = references.length ? await callEditApi(payload) : await callGenerationApi(payload);

  if (result.response.ok) {
    const urls = extractImageUrls(result.data);
    if (urls.length) return { data: result.data, request: result.request, urls };
    throw new Error("The AI API returned no image URL.");
  }

  const data = result.data;
  const message = (data as { error?: { message?: string }; message?: string })?.error?.message
    ?? (data as { error?: string; message?: string })?.error
    ?? (data as { message?: string })?.message
    ?? result.text
    ?? `${result.response.status} ${result.response.statusText}`;
  throw new Error(formatApiError(String(message)));
};

export default async (req: Request) => {
  const { jobId, payload } = (await req.json().catch(() => ({}))) as WorkerRequest;
  if (!jobId || !payload?.prompt) return;

  const store = getStore("ai-generation-jobs", { consistency: "strong" });
  const update = async (value: JobResult) => store.setJSON(jobId, value);

  await update({
    createdAt: new Date().toISOString(),
    jobId,
    prompt: payload.prompt,
    status: "running",
    updatedAt: new Date().toISOString(),
  });

  try {
    const result = await callImageApi(payload);
    await update({
      completedAt: new Date().toISOString(),
      imageUrl: result.urls[0],
      images: result.urls.map((url) => ({ url })),
      jobId,
      prompt: payload.prompt,
      request: result.request,
      result: {
        imageUrl: result.urls[0],
        images: result.urls.map((url) => ({ url })),
        request: result.request,
        response: result.data,
      },
      response: result.data,
      status: "done",
    });
  } catch (error) {
    await update({
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Generation failed.",
      jobId,
      prompt: payload.prompt,
      status: "error",
    });
  }
};

export const config: Config = {
  path: "/api/generate-worker",
};
