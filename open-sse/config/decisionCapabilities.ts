import { decisionHeaders, readDecisionJson } from "../handlers/decisionTransport.ts";
import {
  DecisionError,
  record,
  type DecisionBackend,
  type DecisionCredentials,
  type DecisionFetch,
} from "../handlers/decisionTypes.ts";

/** Known native format; this does not register a provider or advertise a model. */
export function nativeDecisionFormat(provider: string): "systemone" | null {
  return provider.trim().toLowerCase() === "supersoniclabs" ? "systemone" : null;
}

/** Prove the selected connection supports the requested target before inference. */
export async function assertDecisionModelCapability(
  backend: DecisionBackend,
  credentials: DecisionCredentials,
  fetcher: DecisionFetch,
  signal: AbortSignal,
  model: string
): Promise<void> {
  if (backend.models && backend.discovery !== "ollama" && backend.discovery !== "openai") {
    if (backend.models.includes(model)) return;
    throw new DecisionError(404, "decision_model_not_found");
  }
  const response = await fetcher(backend.modelsUrl, credentials, {
    headers: decisionHeaders(credentials),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new DecisionError(response.status, "model_discovery_failed");
  }
  const payload = record(await readDecisionJson(response, 502, signal));
  const rows = payload.data ?? payload.models ?? payload.result;
  if (!Array.isArray(rows) || rows.length > 2048)
    throw new DecisionError(502, "invalid_model_catalog");
  const found = rows.some((item) => {
    const row = record(item);
    return (
      (backend.discovery === "cloudflare" ? row.name : (row.id ?? row.name ?? row.model)) === model
    );
  });
  if (!found) throw new DecisionError(404, "decision_model_not_found");
  await assertNativeCapability(backend, credentials, fetcher, signal, model);
}

async function assertNativeCapability(
  backend: DecisionBackend,
  credentials: DecisionCredentials,
  fetcher: DecisionFetch,
  signal: AbortSignal,
  model: string
): Promise<void> {
  if (backend.discovery === "ollama") {
    const response = await fetcher(new URL("/api/show", backend.modelsUrl).href, credentials, {
      method: "POST",
      headers: decisionHeaders(credentials),
      body: JSON.stringify({ model }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DecisionError(response.status, "model_capabilities_failed");
    }
    const capabilities = record(await readDecisionJson(response, 502, signal)).capabilities;
    if (Array.isArray(capabilities) && capabilities.includes("decision")) return;
  } else if (backend.discovery === "openai") {
    if (model === "gpt-6-luna") return;
  } else if (backend.discovery === "cloudflare") {
    if (["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"].includes(model)) return;
  } else return; // Explicitly configured native server, never a chat catalog.
  throw new DecisionError(404, "decision_model_not_found");
}
