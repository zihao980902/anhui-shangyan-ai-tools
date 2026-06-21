import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default async (_req: Request, context: { params?: { jobId?: string } }) => {
  const jobId = context.params?.jobId;
  if (!jobId) return json({ error: "Job ID is missing." }, 400);

  const store = getStore("ai-generation-jobs", { consistency: "strong" });
  const result = await store.get(jobId, { type: "json" });
  if (!result) return json({ error: "Generation job was not found." }, 404);

  return json(result);
};

export const config: Config = {
  path: "/api/result/:jobId",
};
