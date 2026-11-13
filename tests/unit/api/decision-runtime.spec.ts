import { describe, it, expect, vi, beforeEach } from "vitest";
const deps = vi.hoisted(() => ({
  valid: vi.fn(),
  policy: vi.fn(),
  scope: vi.fn(),
  select: vi.fn(),
  fetch: vi.fn(),
  log: vi.fn(),
  usage: vi.fn(),
  recover: vi.fn(),
  unavailable: vi.fn(),
}));
vi.mock("@/sse/services/auth", () => ({
  extractApiKey: (r: Request) => r.headers.get("authorization")?.replace("Bearer ", ""),
  isValidApiKey: deps.valid,
  getProviderCredentialsWithQuotaPreflight: deps.select,
  clearRecoveredProviderState: deps.recover,
  markAccountUnavailable: deps.unavailable,
}));
vi.mock("@/shared/utils/apiKeyPolicy", () => ({ enforceApiKeyPolicy: deps.policy }));
vi.mock("@/sse/services/keyConnectionScope", () => ({
  resolveKeyConnectionScope: deps.scope,
  isKeyScopeBlockedCredentials: (c: Record<string, unknown>) => c.keyScopeBlocked === true,
}));
vi.mock("@/lib/usage/callLogs", () => ({ saveCallLog: deps.log }));
vi.mock("@/lib/usage/usageHistory", () => ({ saveRequestUsage: deps.usage }));
vi.mock("@/shared/constants/providers", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveProviderId: (p: string) => p,
}));
vi.mock("@/middleware/promptInjectionGuard", () => ({
  withInjectionGuard: (handler: unknown) => handler,
}));
vi.mock("@/app/api/v1/_shared/specialtyCatalog", () => ({
  getSpecialtyModelsResponse: vi.fn(async () => Response.json({ data: [] })),
}));
vi.mock("@omniroute/open-sse/handlers/systemOne.ts", () => ({
  handleSystemOneProxy: vi.fn(async () => Response.json({ legacy: true })),
}));
vi.mock("@/lib/providers/decisionFetch", () => ({ fetchDecision: deps.fetch }));
vi.mock("@/shared/network/safeOutboundFetch", () => ({ safeOutboundFetch: vi.fn() }));
vi.mock("@/shared/network/outboundUrlGuardPolicy", () => ({
  getProviderOutboundGuard: () => "public-only",
}));
vi.mock("@/lib/db/settings", () => ({ resolveProxyForConnection: vi.fn(async () => null) }));

import { POST } from "@/app/api/v1/systemone/route";
import { handleSystemOneProxy } from "@omniroute/open-sse/handlers/systemOne.ts";
const body = {
  model: "basal/current",
  state: "private payload",
  questions: { a: { type: "noul", instructions: "Safe?" } },
};
const makeRequest = (key = "client-test") =>
  new Request("http://gateway/v1/systemone", {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: JSON.stringify(body),
  });
describe("decision routes use real runtime policy wiring", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    deps.valid.mockResolvedValue(true);
    deps.policy.mockResolvedValue({
      apiKeyInfo: { id: "key1", name: "test", allowedConnections: ["c1"] },
      rejection: null,
    });
    deps.scope.mockResolvedValue({ allowedConnections: ["c1"], rejection: null });
    deps.select.mockResolvedValue({ connectionId: "c1", apiKey: "upstream-test" });
    deps.fetch.mockImplementation(async (_url, _c, init) =>
      Response.json(
        init.method === "POST"
          ? {
              answers: { a: { type: "noul", noul: 0.9 } },
              usage: { input_tokens: 10, output_tokens: 0, cost: 0.002 },
            }
          : { models: [{ name: "current" }] }
      )
    );
    deps.log.mockResolvedValue(undefined);
    deps.usage.mockResolvedValue(undefined);
  });
  it.each(["typesafe/jev-latest", "openrouter/typesafe/jev-1.13", "jev-latest", undefined])(
    "retains the merged System One backend for %s",
    async (model) => {
      const response = await POST(
        new Request("http://gateway/v1/systemone", {
          method: "POST",
          headers: { authorization: "Bearer client-test" },
          body: JSON.stringify({
            ...body,
            model,
            questions: { a: { type: "noul", instructions: "Safe?" } },
          }),
        })
      );
      expect(response.status).toBe(200);
      expect(handleSystemOneProxy).toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
    }
  );
  it("requires a client key even in keyless mode", async () => {
    expect((await POST(makeRequest(""))).status).toBe(401);
    expect(deps.select).not.toHaveBeenCalled();
  });
  it("rejects invalid credentials", async () => {
    deps.valid.mockResolvedValue(false);
    expect((await POST(makeRequest())).status).toBe(401);
  });
  it.each([403, 429])(
    "returns endpoint/model/rate policy rejection %s without upstream access",
    async (status) => {
      deps.policy.mockResolvedValue({ rejection: new Response(null, { status }) });
      expect((await POST(makeRequest())).status).toBe(status);
      expect(deps.select).not.toHaveBeenCalled();
    }
  );
  it("applies scoped quota preflight and binds accounting to caller and selected connection", async () => {
    expect((await POST(makeRequest())).status).toBe(200);
    expect(deps.select).toHaveBeenCalledWith("basal", null, ["c1"], "current");
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: "key1",
        connectionId: "c1",
        provider: "basal",
        path: "/v1/systemone",
      })
    );
    expect(deps.usage).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: "key1",
        tokens: { input_tokens: 10, output_tokens: 0, cost_usd: 0.002 },
      }),
      { deduplicate: false }
    );
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain("private payload");
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain("upstream-test");
  });
  it.each([
    { result: null, status: 503 },
    { result: { allRateLimited: true }, status: 429 },
    { result: { keyScopeBlocked: true }, status: 403 },
  ])("fails closed for ineligible connection $status", async ({ result, status }) => {
    deps.select.mockResolvedValue(result);
    expect((await POST(makeRequest())).status).toBe(status);
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("feeds upstream failures into existing model/connection cooldown", async () => {
    deps.fetch.mockImplementation(async (_url, _c, init) =>
      init.method === "POST"
        ? new Response(null, { status: 429 })
        : Response.json({ models: [{ name: "current" }] })
    );
    expect((await POST(makeRequest())).status).toBe(429);
    expect(deps.unavailable).toHaveBeenCalledWith(
      "c1",
      429,
      "Decision upstream HTTP 429",
      "basal",
      "current",
      null,
      expect.any(Object)
    );
  });
});
