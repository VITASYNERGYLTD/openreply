import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthorizationUrl } from "../lib/meta/oauth";
import { getMissingInstagramOAuthEnv } from "../lib/env";
import { connectUnifiedAccounts } from "../lib/meta/unified";
import { packUnifiedCredentials, unpackUnifiedCredentials } from "../lib/meta/credentials";
import { getUserInfo, getUserMedia, sendPrivateReply, subscribeInstagramAccountToWebhooks, refreshLongLivedToken } from "../lib/meta/client";

const redirect = "https://reply.example.com/api/instagram/callback";
const credentials = {
  accessToken: "test-business-token", instagramId: "ig-1",
  clientBusinessId: "business-1", configId: "config-1",
};
const packed = packUnifiedCredentials(credentials);
const fetchMock = vi.fn();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeEach(() => {
  vi.stubEnv("META_LOGIN_CONFIG_ID", "config-1");
  vi.stubEnv("FACEBOOK_APP_ID", "meta-app-1");
  vi.stubEnv("FACEBOOK_APP_SECRET", "test-secret");
  vi.stubEnv("META_GRAPH_API_VERSION", "v26.0");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Unified Login", () => {
  it("uses the Meta configuration and real signed state without legacy scopes", () => {
    const url = new URL(getAuthorizationUrl(redirect, "signed-state"));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("meta-app-1");
    expect(url.searchParams.get("config_id")).toBe("config-1");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("redirect_uri")).toBe(redirect);
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("requires Meta secrets rather than Instagram secrets in unified mode", () => {
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
    vi.stubEnv("NEXTAUTH_SECRET", "state-secret");
    vi.stubEnv("INSTAGRAM_APP_ID", "");
    vi.stubEnv("INSTAGRAM_APP_SECRET", "");
    expect(getMissingInstagramOAuthEnv()).toEqual([]);
    vi.stubEnv("FACEBOOK_APP_SECRET", "");
    expect(getMissingInstagramOAuthEnv()).toEqual(["FACEBOOK_APP_SECRET"]);
  });

  it("retains Instagram Login when no configuration is set", () => {
    vi.stubEnv("META_LOGIN_CONFIG_ID", "");
    vi.stubEnv("INSTAGRAM_APP_ID", "legacy-id");
    const url = new URL(getAuthorizationUrl(redirect, "signed-state"));
    expect(url.hostname).toBe("www.instagram.com");
    expect(url.searchParams.get("client_id")).toBe("legacy-id");
    expect(url.searchParams.has("config_id")).toBe(false);
  });

  it("exchanges once and discovers every shared account using trusted cursor pagination", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: credentials.accessToken, expires_in: 0 }))
      .mockResolvedValueOnce(json({ client_business_id: "business-1" }))
      .mockResolvedValueOnce(json({ data: [{ id: "ig-1", username: "first" }], paging: { next: "https://untrusted.example/", cursors: { after: "cursor-1" } } }))
      .mockResolvedValueOnce(json({ data: [{ id: "ig-2", username: "second" }] }));
    const accounts = await connectUnifiedAccounts("auth-code", redirect);
    expect(accounts.map((a) => a.instagramId)).toEqual(["ig-1", "ig-2"]);
    expect(accounts[0].tokenExpiresAt).toBeNull();
    expect(unpackUnifiedCredentials(accounts[0].credentials)).toEqual(credentials);
    expect(unpackUnifiedCredentials(accounts[1].credentials)?.instagramId).toBe("ig-2");
    const exchange = new URL(String(fetchMock.mock.calls[0][0]));
    expect(exchange.hostname).toBe("graph.facebook.com");
    expect(exchange.searchParams.get("client_secret")).toBe("test-secret");
    const next = new URL(String(fetchMock.mock.calls[3][0]));
    expect(next.hostname).toBe("graph.facebook.com");
    expect(next.searchParams.get("after")).toBe("cursor-1");
  });

  it("rejects a login that did not share any Instagram accounts", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "test-token" }))
      .mockResolvedValueOnce(json({ client_business_id: "business-1" }))
      .mockResolvedValueOnce(json({ data: [] }));
    await expect(connectUnifiedAccounts("code", redirect)).rejects.toThrow("No Instagram accounts were shared");
  });

  it("does not echo token exchange secrets in errors", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 100, message: "test-secret" } }, 400));
    await expect(connectUnifiedAccounts("code", redirect)).rejects.toThrow("Meta code 100");
  });

  it("uses the explicit IG account for profile and media, sending only the raw token", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "ig-1", username: "first" }))
      .mockResolvedValueOnce(json({ data: [] }));
    await getUserInfo(packed);
    await getUserMedia(packed);
    const urls = fetchMock.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls[0].pathname).toBe("/v26.0/ig-1");
    expect(urls[1].pathname).toBe("/v26.0/ig-1/media");
    expect(urls.every((url) => url.hostname === "graph.facebook.com")).toBe(true);
    expect(urls[0].searchParams.get("fields")).not.toContain("user_id");
    expect(urls[0].searchParams.get("access_token")).toBe(credentials.accessToken);
  });

  it("routes replies and webhook subscriptions through Facebook Graph", async () => {
    fetchMock.mockImplementation(async () => json({ success: true }));
    await sendPrivateReply(packed, "ig-1", "comment-1", "test");
    await subscribeInstagramAccountToWebhooks("ig-1", packed);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://graph.facebook.com/v26.0/ig-1/messages");
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://graph.facebook.com/v26.0/ig-1/subscribed_apps");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer test-business-token");
  });

  it("retains the legacy API host and /me path for existing tokens", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "legacy-id" }));
    await getUserInfo("legacy-token");
    expect(new URL(String(fetchMock.mock.calls[0][0])).hostname).toBe("graph.instagram.com");
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe("/v26.0/me");
  });

  it("never sends business tokens to the Instagram token refresh endpoint", async () => {
    await expect(refreshLongLivedToken(packed)).rejects.toThrow("reconnect Instagram");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
