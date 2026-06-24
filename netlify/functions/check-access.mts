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

const isValidAccessCode = (accessCode?: string) => {
  const configuredCode = getEnv("INTERNAL_ACCESS_CODE");
  const fallbackCode = fallbackEnv.INTERNAL_ACCESS_CODE;
  return Boolean(accessCode && (accessCode === configuredCode || accessCode === fallbackCode));
};

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST requests only." }, 405);

  const body = (await req.json().catch(() => ({}))) as { accessCode?: string };
  if (!isValidAccessCode(body.accessCode)) {
    return json({ error: "Access code is incorrect." }, 401);
  }

  return json({ ok: true });
};

export const config: Config = {
  path: "/api/check-access",
};
