import { LOCAL_PROVIDERS } from "@/shared/constants/providers/local";

/** Explicit connection URLs win; registered local defaults need no duplicate configuration. */
export function resolveLocalProviderBaseUrl(
  provider: string,
  configuredBaseUrl: unknown
): string | null {
  if (typeof configuredBaseUrl === "string" && configuredBaseUrl.trim()) {
    return configuredBaseUrl;
  }
  if (!Object.prototype.hasOwnProperty.call(LOCAL_PROVIDERS, provider)) {
    return null;
  }
  const entry = LOCAL_PROVIDERS[provider as keyof typeof LOCAL_PROVIDERS] as {
    localDefault?: string | null;
  };
  return entry.localDefault ?? null;
}
