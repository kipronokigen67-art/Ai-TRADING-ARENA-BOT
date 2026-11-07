
const DERIV_AUTHORIZE_URL = "https://auth.deriv.com/oauth2/auth";
const DERIV_TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const CALLBACK_URL =
  "https://ai-trading-arena-bot.dollarprinterchoosen.workers.dev/auth/callback";

function cookie(name, value, maxAge = 600, path = "/auth") {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=${maxAge}`;
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const item = header.split(";").map(v => v.trim())
    .find(v => v.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(length = 64) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function response(message, status = 200, headers = {}) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers }
  });
}

function responseWithCookies(body, init = {}, cookies = []) {
  const headers = new Headers(init.headers || {});
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(body, { ...init, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Start Deriv OAuth login
      if (path === "/auth/login" && request.method === "GET") {
        if (!env.DERIV_CLIENT_ID) {
          return response("Server setup incomplete: Deriv client ID is missing.", 500);
        }

        const verifier = randomString(64);
        const state = randomString(32);

        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier)
        );

        const challenge = base64url(new Uint8Array(digest));

        const authorizeUrl = new URL(DERIV_AUTHORIZE_URL);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", env.DERIV_CLIENT_ID);
        authorizeUrl.searchParams.set("redirect_uri", CALLBACK_URL);
        authorizeUrl.searchParams.set("scope", "trade");
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("code_challenge", challenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");

        return responseWithCookies(null, {
          status: 302,
          headers: {
            "Location": authorizeUrl.toString(),
            "Cache-Control": "no-store"
          }
        }, [
          cookie("deriv_oauth_state", state),
          cookie("deriv_oauth_verifier", verifier)
        ]);
      }

      // Handle Deriv's OAuth callback
      if (path === "/auth/callback" && request.method === "GET") {
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const savedState = readCookie(request, "deriv_oauth_state");
        const verifier = readCookie(request, "deriv_oauth_verifier");

        const clearCookies = [
          cookie("deriv_oauth_state", "", 0),
          cookie("deriv_oauth_verifier", "", 0)
        ];

        if (url.searchParams.get("error")) {
          return responseWithCookies(
            "Deriv login was cancelled or denied. Please try again.",
            { status: 400, headers: { "Cache-Control": "no-store" } },
            clearCookies
          );
        }

        if (!code || !returnedState || !savedState ||
            returnedState !== savedState || !verifier) {
          return responseWithCookies(
            "Login verification failed. Please start again from the dashboard.",
            { status: 400, headers: { "Cache-Control": "no-store" } },
            clearCookies
          );
        }

        if (!env.DERIV_CLIENT_ID || !env.TOKENS) {
          return responseWithCookies(
            "Server setup incomplete. Please configure the Cloudflare client ID and TOKENS storage.",
            { status: 500, headers: { "Cache-Control": "no-store" } },
            clearCookies
          );
        }

        const body = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: env.DERIV_CLIENT_ID,
          code,
          code_verifier: verifier,
          redirect_uri: CALLBACK_URL
        });

        const tokenResponse = await fetch(DERIV_TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body
        });

        if (!tokenResponse.ok) {
          return responseWithCookies(
            "Deriv could not complete the token exchange. Please try connecting again.",
            { status: 502, headers: { "Cache-Control": "no-store" } },
            clearCookies
          );
        }

        const tokenData = await tokenResponse.json();

        if (!tokenData.access_token) {
          return responseWithCookies(
            "Deriv did not return an access token. Please try again.",
            { status: 502, headers: { "Cache-Control": "no-store" } },
            clearCookies
          );
        }

        const sessionId = randomString(32);
        const expiresIn = Math.max(60, Number(tokenData.expires_in) || 3600);

        await env.TOKENS.put(
          `session:${sessionId}`,
          JSON.stringify({
            access_token: tokenData.access_token,
            expires_at: Date.now() + expiresIn * 1000
          }),
          { expirationTtl: expiresIn }
        );

        return responseWithCookies(
          null,
          {
            status: 302,
            headers: {
              "Location": "/",
              "Cache-Control": "no-store"
            }
          },
          [
            ...clearCookies,
            cookie("ai_trading_session", sessionId, expiresIn, "/")
          ]
        );
      }

      // Retrieve the authenticated user's Options accounts (demo and real).
      // The access token stays server-side and is never returned to the browser.
      if (path === "/api/accounts" && request.method === "GET") {
        const sessionId = readCookie(request, "ai_trading_session");
        if (!sessionId || !env.TOKENS) {
          return Response.json({ error: "not_connected" }, { status: 401 });
        }

        const saved = await env.TOKENS.get(`session:${sessionId}`);
        if (!saved) {
          return Response.json({ error: "session_expired" }, { status: 401 });
        }

        const session = JSON.parse(saved);
        if (!session.access_token ||
            (session.expires_at && Date.now() >= session.expires_at)) {
          await env.TOKENS.delete(`session:${sessionId}`);
          return Response.json({ error: "session_expired" }, { status: 401 });
        }

        const accountsResponse = await fetch(
          "https://api.derivws.com/trading/v1/options/accounts",
          {
            headers: {
              "Authorization": `Bearer ${session.access_token}`,
              "Deriv-App-ID": env.DERIV_CLIENT_ID,
              "Accept": "application/json"
            }
          }
        );

        const accountsData = await accountsResponse.json();
        return Response.json(accountsData, {
          status: accountsResponse.status,
          headers: { "Cache-Control": "no-store" }
        });
      }

      // Issue a short-lived authenticated WebSocket URL for an active Demo Options account.
      // The OAuth access token remains in server-side KV and is never sent to the browser.
      if (path === "/api/otp" && request.method === "POST") {
        const sessionId = readCookie(request, "ai_trading_session");
        if (!sessionId || !env.TOKENS) {
          return Response.json({ error: "not_connected" }, { status: 401 });
        }

        const saved = await env.TOKENS.get(`session:${sessionId}`);
        if (!saved) {
          return Response.json({ error: "session_expired" }, { status: 401 });
        }

        const session = JSON.parse(saved);
        if (!session.access_token ||
            (session.expires_at && Date.now() >= session.expires_at)) {
          await env.TOKENS.delete(`session:${sessionId}`);
          return Response.json({ error: "session_expired" }, { status: 401 });
        }

        let body;
        try { body = await request.json(); }
        catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }

        const accountId = String(body?.account_id || "");
        if (!/^DOT[0-9]{8,12}$/.test(accountId)) {
          return Response.json({ error: "invalid_account_id" }, { status: 400 });
        }

        // Verify account ownership and enforce Demo-only WebSocket access in this first release.
        const accountsResponse = await fetch(
          "https://api.derivws.com/trading/v1/options/accounts",
          { headers: {
            "Authorization": `Bearer ${session.access_token}`,
            "Accept": "application/json"
          } }
        );
        if (!accountsResponse.ok) {
          return Response.json({ error: "accounts_verification_failed" }, { status: 502 });
        }
        const accountsPayload = await accountsResponse.json();
        const account = Array.isArray(accountsPayload?.data)
          ? accountsPayload.data.find(a => a?.account_id === accountId)
          : null;
        if (!account || account.status !== "active" || account.account_type !== "demo") {
          return Response.json({ error: "demo_account_required" }, { status: 403 });
        }

        const otpResponse = await fetch(
          `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
          { method: "POST", headers: {
            "Authorization": `Bearer ${session.access_token}`,
            "Accept": "application/json"
          } }
        );
        const otpPayload = await otpResponse.json();
        const wsUrl = otpPayload?.data?.url;
        if (!otpResponse.ok || typeof wsUrl !== "string") {
          return Response.json({ error: "otp_request_failed" }, { status: otpResponse.status || 502 });
        }

        const parsedWsUrl = new URL(wsUrl);
        if (parsedWsUrl.protocol !== "wss:" ||
            parsedWsUrl.hostname !== "api.derivws.com" ||
            parsedWsUrl.pathname !== "/trading/v1/options/ws/demo") {
          return Response.json({ error: "unexpected_websocket_endpoint" }, { status: 502 });
        }

        return Response.json({ url: wsUrl, account_id: accountId, account_type: "demo" }, {
          headers: { "Cache-Control": "no-store" }
        });
      }

      // Check whether this browser has a connected Deriv session
      if (path === "/api/connection" && request.method === "GET") {
        const sessionId = readCookie(request, "ai_trading_session");

        if (!sessionId || !env.TOKENS) {
          return Response.json({ connected: false });
        }

        const saved = await env.TOKENS.get(`session:${sessionId}`);

        if (!saved) {
          return Response.json({ connected: false }, {
            headers: { "Cache-Control": "no-store" }
          });
        }

        const session = JSON.parse(saved);
        const connected = !!session.access_token &&
          (!session.expires_at || Date.now() < session.expires_at);
        if (!connected) await env.TOKENS.delete(`session:${sessionId}`);

        return Response.json(
          { connected },
          { headers: { "Cache-Control": "no-store" } }
        );
      }

      // Disconnect this browser session
      if (path === "/auth/logout" && request.method === "POST") {
        const sessionId = readCookie(request, "ai_trading_session");

        if (sessionId && env.TOKENS) {
          await env.TOKENS.delete(`session:${sessionId}`);
        }

        return response("Disconnected.", 200, {
          "Set-Cookie": cookie("ai_trading_session", "", 0, "/")
        });
      }

      // Serve the existing dashboard
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return response("Dashboard assets are not configured yet.", 404);

    } catch (error) {
      console.error("Worker error:", error.message);
      return response("A server error occurred. Please try again.", 500);
    }
  }
};
