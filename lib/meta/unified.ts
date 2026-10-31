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
    for (const account of page.data ?? []) {
      if (!account.id || !account.username) throw new Error("Unified Login returned an invalid Instagram account");
      if (!accounts.some((a) => a.id === account.id)) accounts.push(account);
    }
    after = page.paging?.next ? page.paging.cursors?.after : undefined;
    if (page.paging?.next && (!after || seen.has(after))) {
      throw new Error("Could not finish listing shared Instagram accounts; reconnect");
    }
    if (after) seen.add(after);
  } while (after);
  if (!accounts.length) throw new Error("No Instagram accounts were shared. Reconnect and select your Instagram professional account in the correct business portfolio.");

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
