import type { Config } from "@netlify/functions";

declare const process: {
  env?: Record<string, string | undefined>;
};

const fallbackEnv: Record<string, string> = {
  INTERNAL_ACCESS_CODE: "shangyanduanshipin",
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

const dataUrlToBytes = (url: string) => {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;

  const contentType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  const bytes = isBase64
    ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload));

  return { bytes, contentType };
};

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST requests only." }, 405);

  const body = (await req.json().catch(() => ({}))) as {
    accessCode?: string;
    filename?: string;
    url?: string;
  };

  const configuredCode = getEnv("INTERNAL_ACCESS_CODE");
  if (configuredCode && body.accessCode !== configuredCode) {
    return json({ error: "Access code is incorrect." }, 401);
  }

  if (!body.url) return json({ error: "Download URL is missing." }, 400);

  const filename = (body.filename || "shangyan-ai.png").replace(/[^\w.-]+/g, "-");
  if (body.url.startsWith("data:")) {
    const data = dataUrlToBytes(body.url);
    if (!data) return json({ error: "Invalid image data." }, 400);
    return new Response(data.bytes, {
      headers: {
        "content-disposition": `attachment; filename="${filename}"`,
        "content-type": data.contentType,
      },
    });
  }

  if (!/^https?:\/\//.test(body.url)) return json({ error: "Invalid download URL." }, 400);

  const response = await fetch(body.url);
  if (!response.ok) return json({ error: "Image download failed." }, 502);

  return new Response(await response.arrayBuffer(), {
    headers: {
      "content-disposition": `attachment; filename="${filename}"`,
      "content-type": response.headers.get("content-type") || "application/octet-stream",
    },
  });
};

export const config: Config = {
  path: "/api/download",
};
