# Instagram API with Unified Login

New Meta apps can expose **API setup with Unified login** instead of the
legacy Instagram Login setup. Supplying the main Meta app ID to the legacy
`instagram.com/oauth/authorize` flow produces `Invalid platform app`.

## Deployment

Set on the web app **and the worker**:

- `META_LOGIN_CONFIG_ID`: the Instagram Login Compatible configuration ID.
- `FACEBOOK_APP_ID`: the main Meta app ID from App settings → Basic.
- `FACEBOOK_APP_SECRET`: the matching main Meta app secret. Enter it only in
  the hosting secret settings, never in a chat or committed file.
- `META_GRAPH_API_VERSION`: a supported Graph API version (Meta's current
  Unified Login examples use `v26.0`).
- `NEXTAUTH_URL`: your public HTTPS origin, without a trailing slash.

Keep `ENCRYPTION_KEY` unchanged and identical on both services. Existing legacy
tokens retain their original API host. Setting `META_LOGIN_CONFIG_ID` switches
**new connections** to Unified Login; it does not migrate existing connections.
The legacy `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` are not used for new
Unified connections.

In Meta, save `${NEXTAUTH_URL}/api/instagram/callback` as the Redirect URL.
The configuration must include `instagram_basic`, `instagram_manage_messages`,
and `instagram_manage_comments`. Add `instagram_manage_insights` for reports.
Use the **Never** token expiration configuration. Expiring business tokens can
be stored, but automatic Business Integration System User token renewal is not
implemented; reconnect before expiration. They are never sent to Instagram's
legacy token refresh endpoint.

The app constructs a Facebook Login for Business URL with `config_id`, a
signed, expiring `state`, and `prompt=login` so the user can choose their login
identity. It exchanges the returned code on Facebook Graph, reads the client
business ID, and connects all explicitly shared Instagram accounts from
`/me/assigned_instagram_accounts`. No linked Facebook Page is required. Each
encrypted credential stores its token, Instagram account ID, client business
ID, and configuration ID; no database migration is needed.

If Meta grants the permissions but lists no accounts (`assigned Instagram
accounts=0; explicit Instagram grant IDs=0`), set `META_INSTAGRAM_ACCOUNT_IDS`
on the web app to the comma-separated Instagram account IDs shown under
Business settings → Instagram accounts, then reconnect. Each ID is only
connected if the login token can read that profile.

If the desired Instagram account is missing, check the selected business
portfolio, account ownership/access, app roles and accepted Instagram tester
invite. Developer phone verification is separate from granting access to an
Instagram account. Do not create another app or change IDs to work around a
missing asset.

## Verify after deployment

1. Connect through OpenReply's button, not the dashboard URL with `<STATE>`.
2. Confirm the Facebook and Instagram login options are offered.
3. Choose the intended portfolio and explicitly share the intended Instagram
   account. Skip the optional ad account if it is not needed.
4. Confirm the correct username appears in OpenReply and webhook subscription
   is enabled. Configure the webhook callback and comments/messages fields in
   Meta as described in the setup guide.
5. Check `/api/health` for a healthy worker, then use a different Instagram
   account to test one keyword comment and verify the DM and log entry.

Sources:

- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication
- https://developers.facebook.com/documentation/instagram-platform/overview
