import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";

declare const process: {
  env?: Record<string, string | undefined>;
};

const fallbackEnv: Record<string, string> = {
  INTERNAL_ACCESS_CODE: "shangyanduanshipin",
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const getEnv = (key: string) => {
  const netlify = (globalThis as {
    Netlify?: { env?: { get?: (name: string) => string | undefined } };
  }).Netlify;
  return (netlify?.env?.get?.(key) ?? process.env?.[key] ?? fallbackEnv[key] ?? "").trim();
};

const isValidAccessCode = (accessCode?: string) => {
  const configuredCode = getEnv("INTERNAL_ACCESS_CODE");
  const fallbackCode = fallbackEnv.INTERNAL_ACCESS_CODE;
  return Boolean(accessCode && (accessCode === configuredCode || accessCode === fallbackCode));
};

const compactPayload = (payload: GenerateRequest, prompt: string): GenerateRequest => {
  const { accessCode: _accessCode, referenceImage, referenceImages, ...rest } = payload;
  const refs = [
    ...(Array.isArray(referenceImages) ? referenceImages : []),
    referenceImage,
  ].filter((value): value is string => Boolean(value && value.trim()));
  const uniqueRefs = Array.from(new Set(refs)).slice(0, 1);
  return {
    ...rest,
    prompt,
    ...(uniqueRefs.length ? { referenceImages: uniqueRefs } : {}),
  };
};

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST requests only." }, 405);

  const payload = (await req.json().catch(() => null)) as GenerateRequest | null;
  if (!payload) return json({ error: "Invalid JSON body." }, 400);

  if (!isValidAccessCode(payload.accessCode)) {
    return json({ error: "Access code is incorrect." }, 401);
  }

  const prompt = payload.prompt?.trim();
  if (!prompt) return json({ error: "Prompt is required." }, 400);
  if (payload.mode === "video") return json({ error: "Only image generation is enabled." }, 400);

  const jobId = crypto.randomUUID();
  const store = getStore("ai-generation-jobs", { consistency: "strong" });
  const createdAt = new Date().toISOString();
  const jobPayload = compactPayload(payload, prompt);

  await store.setJSON(jobId, {
    createdAt,
    jobId,
    payload: jobPayload,
    prompt,
    status: "queued",
    updatedAt: createdAt,
  });

  const workerUrl = new URL("/api/generate-worker", req.url);
  const workerResponse = await fetch(workerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId }),
  });

  if (!workerResponse.ok) {
    const text = await workerResponse.text().catch(() => "");
    const error = `Worker did not accept the job: ${workerResponse.status} ${text.slice(0, 180)}`;
    await store.setJSON(jobId, {
      completedAt: new Date().toISOString(),
      error,
      jobId,
      prompt,
      status: "error",
    });
    return json({ error, ok: false, status: "error" }, 502);
  }

  return json({
    ok: true,
    createdAt,
    jobId,
    status: "queued",
    message: "Generation job submitted.",
  });
};

export const config: Config = {
  path: "/api/generate",
};
