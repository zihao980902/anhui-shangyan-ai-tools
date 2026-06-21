import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

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

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "POST requests only." }, 405);

  const payload = (await req.json().catch(() => null)) as GenerateRequest | null;
  if (!payload) return json({ error: "Invalid JSON body." }, 400);

  const configuredCode = getEnv("INTERNAL_ACCESS_CODE");
  if (configuredCode && payload.accessCode !== configuredCode) {
    return json({ error: "Access code is incorrect." }, 401);
  }

  const prompt = payload.prompt?.trim();
  if (!prompt) return json({ error: "Prompt is required." }, 400);
  if (payload.mode === "video") return json({ error: "Only image generation is enabled." }, 400);

  const jobId = crypto.randomUUID();
  const store = getStore("ai-generation-jobs", { consistency: "strong" });
  await store.setJSON(jobId, {
    createdAt: new Date().toISOString(),
    prompt,
    status: "queued",
  });

  const workerUrl = new URL("/api/generate-worker", req.url);
  context.waitUntil(
    fetch(workerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId, payload: { ...payload, prompt } }),
    }),
  );

  return json({
    ok: true,
    jobId,
    status: "queued",
    message: "Generation job submitted.",
  });
};

export const config: Config = {
  path: "/api/generate",
};
