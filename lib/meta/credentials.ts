// Stored inside the existing encrypted accessToken column. Legacy rows remain
// plain tokens after decryption; Unified Login also needs an explicit IG ID
// because /me denotes the business integration system user.
const PREFIX = "openreply:unified:v1:";

export interface UnifiedCredentials {
  accessToken: string;
  instagramId: string;
  clientBusinessId: string;
  configId: string;
}

export function packUnifiedCredentials(value: UnifiedCredentials): string {
  return PREFIX + JSON.stringify(value);
}

export function unpackUnifiedCredentials(value: string): UnifiedCredentials | null {
  if (!value.startsWith(PREFIX)) return null;
  const parsed = JSON.parse(value.slice(PREFIX.length)) as UnifiedCredentials;
  for (const key of ["accessToken", "instagramId", "clientBusinessId", "configId"] as const) {
    if (typeof parsed[key] !== "string" || !parsed[key]) {
      throw new Error("Invalid stored Unified Login credentials; reconnect Instagram");
    }
  }
  return parsed;
}

export function rawMetaToken(value: string): string {
  return unpackUnifiedCredentials(value)?.accessToken ?? value;
}

export function metaAccountPath(value: string): string {
  return unpackUnifiedCredentials(value)?.instagramId ?? "me";
}
