import { getMetaGraphApiVersion, requireEnv } from "@/lib/env";
import { packUnifiedCredentials } from "./credentials";

function base() {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

async function read<T>(response: Response): Promise<T> {
  const data = await response.json();
  // Do not persist upstream error text: OAuth responses may echo credentials.
  if (!response.ok || data.error) {
    throw new Error(`Unified Login request failed (HTTP ${response.status}, Meta code ${data.error?.code ?? "unknown"}); check app configuration and account access`);
  }
  return data as T;
}

interface TokenDebug {
  is_valid?: boolean;
  app_id?: string;
  scopes?: string[];
  granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
}

// A successful business login does not prove an Instagram asset was assigned.
// When the assignment edge is empty, inspect this app's token grants rather
// than telling the user to repeat the same login with no further evidence.
async function accountsFromTokenGrants(accessToken: string) {
  const url = new URL(`${base()}/debug_token`);
  url.searchParams.set("input_token", accessToken);
  const debug = await read<{ data?: TokenDebug }>(await fetch(url, {
    headers: { Authorization: `Bearer ${requireEnv("FACEBOOK_APP_ID")}|${requireEnv("FACEBOOK_APP_SECRET")}` },
    cache: "no-store",
  }));
  const data = debug.data;
  if (!data || data.is_valid !== true || String(data.app_id) !== requireEnv("FACEBOOK_APP_ID")) {
    throw new Error("Unified Login: token validation failed for this Meta app. No Instagram account was connected.");
  }
  const required = ["instagram_basic", "instagram_manage_messages", "instagram_manage_comments"];
  const scopes = new Set(data.scopes ?? []);
  const missing = required.filter((scope) => !scopes.has(scope));
  if (missing.length) {
    throw new Error(`Unified Login: Meta did not grant required permissions: ${missing.join(", ")}. No Instagram account was connected.`);
  }
  // Prefer IDs explicitly named in the Instagram grants of this token. When
  // Meta omits them (all-asset grants), fall back to the operator-configured
  // META_INSTAGRAM_ACCOUNT_IDS. Either way, an ID is only accepted below if
  // this token can actually read that Instagram profile, so a configured ID
  // never grants access the token does not already have.
  const grantIds = (data.granular_scopes ?? [])
    .filter((grant) => required.includes(grant.scope))
    .flatMap((grant) => grant.target_ids ?? []);
  const configuredIds = (process.env.META_INSTAGRAM_ACCOUNT_IDS ?? "")
    .split(",").map((id) => id.trim());
  const ids = [...new Set(grantIds.length ? grantIds : configuredIds)]
    .filter((id) => typeof id === "string" && /^\d+$/.test(id));
  if (!ids.length) {
    throw new Error("Unified Login: permissions OK; assigned Instagram accounts=0; explicit Instagram grant IDs=0. Meta may omit IDs for all-asset grants. Set META_INSTAGRAM_ACCOUNT_IDS to the Instagram account ID shown under Business settings → Instagram accounts, then reconnect.");
  }
  const accounts: Array<{ id: string; username: string }> = [];
  for (const id of ids) {
    const response = await fetch(`${base()}/${id}?fields=id,username`, {
      headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store",
    });
    // Some permission target IDs can refer to a different type of asset. Only
    // accept a readable Instagram profile with the exact granted ID.
    if (!response.ok) continue;
    const account = await response.json();
    if (!account.error && account.id === id && typeof account.username === "string" && account.username) {
      accounts.push({ id, username: account.username });
    }
  }
  if (!accounts.length) {
    throw new Error(`Unified Login: token has ${ids.length} Instagram grant target(s), but none returned an accessible Instagram profile. No account was connected.`);
  }
  return accounts;
}

export async function connectUnifiedAccounts(code: string, redirectUri: string) {
  const tokenUrl = new URL(`${base()}/oauth/access_token`);
  tokenUrl.search = new URLSearchParams({
    client_id: requireEnv("FACEBOOK_APP_ID"),
    client_secret: requireEnv("FACEBOOK_APP_SECRET"),
    code,
    redirect_uri: redirectUri,
  }).toString();
  const token = await read<{ access_token: string; expires_in?: number }>(
    await fetch(tokenUrl, { cache: "no-store" })
  );
  if (!token.access_token) throw new Error("Unified Login returned no access token");
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const business = await read<{ client_business_id?: string }>(await fetch(
    `${base()}/me?fields=client_business_id`, { headers, cache: "no-store" }
  ));
  if (!business.client_business_id) throw new Error("Unified Login returned no client business ID");

  const accounts: Array<{ id: string; username: string }> = [];
  let after: string | undefined;
  const seen = new Set<string>();
  do {
    const url = new URL(`${base()}/me/assigned_instagram_accounts`);
    url.searchParams.set("fields", "id,username");
    if (after) url.searchParams.set("after", after);
    const page = await read<{
      data: Array<{ id: string; username: string }>;
      paging?: { next?: string; cursors?: { after?: string } };
    }>(await fetch(url, { headers, cache: "no-store" }));
    if (!Array.isArray(page.data)) {
      throw new Error("Unified Login: Meta returned an unexpected assigned-account response (missing data list). No account was connected.");
    }
    for (const account of page.data) {
      if (!account.id || !account.username) throw new Error("Unified Login returned an invalid Instagram account");
      if (!accounts.some((a) => a.id === account.id)) accounts.push(account);
    }
    after = page.paging?.next ? page.paging.cursors?.after : undefined;
    if (page.paging?.next && (!after || seen.has(after))) {
      throw new Error("Could not finish listing shared Instagram accounts; reconnect");
    }
    if (after) seen.add(after);
  } while (after);
  if (!accounts.length) accounts.push(...await accountsFromTokenGrants(token.access_token));

  const expiresAt = token.expires_in && token.expires_in > 0
    ? new Date(Date.now() + token.expires_in * 1000) : null;
  return accounts.map((account) => ({
    instagramId: account.id,
    username: account.username,
    tokenExpiresAt: expiresAt,
    credentials: packUnifiedCredentials({
      accessToken: token.access_token,
      instagramId: account.id,
      clientBusinessId: business.client_business_id!,
      configId: requireEnv("META_LOGIN_CONFIG_ID"),
    }),
  }));
}
