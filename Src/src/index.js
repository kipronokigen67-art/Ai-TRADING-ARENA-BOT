
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



async function handleTradingConnectionTest(request, env) {
  const allowedOrigin = "https://ai-trading-arena-bot.dollarprinterchoosen.workers.dev";
  if (request.headers.get("Origin") !== allowedOrigin) {
    return Response.json({ connected: false, error: "origin_not_allowed" }, { status: 403 });
  }
  if (!env.TOKENS || !env.DERIV_CLIENT_ID) {
    return Response.json({ connected: false, error: "server_setup_incomplete" }, { status: 500 });
  }
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ connected: false, error: "invalid_request" }, { status: 400 });
  }
  const accountId = String(body?.account_id || "");
  if (!/^DOT[0-9]{8,12}$/.test(accountId)) {
    return Response.json({ connected: false, error: "invalid_account_id" }, { status: 400 });
  }
  const sessionId = readCookie(request, "ai_trading_session");
  if (!sessionId) return Response.json({ connected: false, error: "not_connected" }, { status: 401 });
  const saved = await env.TOKENS.get(`session:${sessionId}`);
  if (!saved) return Response.json({ connected: false, error: "session_expired" }, { status: 401 });
  const session = JSON.parse(saved);
  if (!session.access_token || (session.expires_at && Date.now() >= session.expires_at)) {
    await env.TOKENS.delete(`session:${sessionId}`);
    return Response.json({ connected: false, error: "session_expired" }, { status: 401 });
  }

  const authHeaders = {
    "Authorization": `Bearer ${session.access_token}`,
    "Deriv-App-ID": env.DERIV_CLIENT_ID,
    "Accept": "application/json"
  };
  const accountsResponse = await fetch("https://api.derivws.com/trading/v1/options/accounts", {
    headers: authHeaders
  });
  if (!accountsResponse.ok) {
    console.error("AI_TRADING_TEST stage=accounts_failed status=" + accountsResponse.status);
    return Response.json({ connected: false, error: "accounts_verification_failed" }, { status: 502 });
  }
  const accountsPayload = await accountsResponse.json();
  const account = Array.isArray(accountsPayload?.data)
    ? accountsPayload.data.find(a => a?.account_id === accountId)
    : null;
  if (!account || account.status !== "active" || account.account_type !== "demo") {
    return Response.json({ connected: false, error: "active_demo_account_required" }, { status: 403 });
  }

  const otpResponse = await fetch(
    `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    { method: "POST", headers: authHeaders }
  );
  let otpPayload;
  try { otpPayload = await otpResponse.json(); } catch {
    console.error("AI_TRADING_TEST stage=otp_invalid_json");
    return Response.json({ connected: false, error: "otp_response_invalid" }, { status: 502 });
  }
  const wsUrl = otpPayload?.data?.url;
  if (!otpResponse.ok || typeof wsUrl !== "string") {
    console.error("AI_TRADING_TEST stage=otp_failed status=" + otpResponse.status);
    return Response.json({ connected: false, error: "otp_request_failed" }, { status: 502 });
  }
  let parsed;
  try { parsed = new URL(wsUrl); } catch {
    return Response.json({ connected: false, error: "otp_url_invalid" }, { status: 502 });
  }
  if (parsed.protocol !== "wss:" || parsed.hostname !== "api.derivws.com" ||
      parsed.pathname !== "/trading/v1/options/ws/demo" || !parsed.searchParams.get("otp")) {
    return Response.json({ connected: false, error: "unexpected_websocket_endpoint" }, { status: 502 });
  }

  let upstreamResponse;
  try {
    const upstreamHttpUrl = new URL(wsUrl);
    upstreamHttpUrl.protocol = "https:";
    upstreamResponse = await fetch(upstreamHttpUrl.toString(), { headers: { "Upgrade": "websocket" } });
  } catch (error) {
    console.error("AI_TRADING_TEST stage=websocket_fetch_failed name=" + (error?.name || "Error") + " message=" + String(error?.message || "").slice(0,180));
    return Response.json({ connected: false, error: "websocket_fetch_failed" }, { status: 502 });
  }
  const upstream = upstreamResponse.webSocket;
  if (upstreamResponse.status !== 101 || !upstream) {
    console.error("AI_TRADING_TEST stage=websocket_upgrade_rejected status=" + upstreamResponse.status);
    return Response.json({
      connected: false,
      error: "websocket_upgrade_rejected",
      upstream_status: upstreamResponse.status
    }, { status: 502 });
  }
  console.log("AI_TRADING_TEST stage=websocket_upgrade_success status=101");
  try { upstream.accept(); upstream.close(1000, "Connection test complete"); } catch {}
  return Response.json({
    connected: true,
    handshake_status: 101,
    account_type: "demo",
    message: "Deriv Demo WebSocket handshake succeeded. No proposal or buy request was sent."
  }, { headers: { "Cache-Control": "no-store" } });
}

async function handleTradingSocket(request, env) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return response("Expected a WebSocket upgrade.", 426);
  }
  if (request.headers.get("Origin") !== "https://ai-trading-arena-bot.dollarprinterchoosen.workers.dev") {
    return response("WebSocket origin is not allowed.", 403);
  }
  const sessionId = readCookie(request, "ai_trading_session");
  if (!sessionId || !env.TOKENS) return Response.json({ error: "not_connected" }, { status: 401 });
  const saved = await env.TOKENS.get(`session:${sessionId}`);
  if (!saved) return Response.json({ error: "session_expired" }, { status: 401 });
  const session = JSON.parse(saved);
  if (!session.access_token || (session.expires_at && Date.now() >= session.expires_at)) {
    await env.TOKENS.delete(`session:${sessionId}`);
    return Response.json({ error: "session_expired" }, { status: 401 });
  }

  const accountId = new URL(request.url).searchParams.get("account_id") || "";
  if (!/^DOT[0-9]{8,12}$/.test(accountId)) {
    return Response.json({ error: "invalid_account_id" }, { status: 400 });
  }
  const accountsResponse = await fetch("https://api.derivws.com/trading/v1/options/accounts", {
    headers: { "Authorization": `Bearer ${session.access_token}`, "Accept": "application/json" }
  });
  if (!accountsResponse.ok) return Response.json({ error: "accounts_verification_failed" }, { status: 502 });
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
  let otpPayload;
  try {
    otpPayload = await otpResponse.json();
  } catch (error) {
    console.error("AI_TRADING_WS stage=otp_response_json_failed");
    return Response.json({ error: "otp_response_invalid" }, { status: 502 });
  }
  const wsUrl = otpPayload?.data?.url;
  if (!otpResponse.ok || typeof wsUrl !== "string") {
    console.error("AI_TRADING_WS stage=otp_request_failed status=" + otpResponse.status);
    return Response.json({ error: "otp_request_failed" }, { status: otpResponse.status || 502 });
  }
  let parsedWsUrl;
  try {
    parsedWsUrl = new URL(wsUrl);
  } catch {
    console.error("AI_TRADING_WS stage=otp_url_invalid");
    return Response.json({ error: "otp_url_invalid" }, { status: 502 });
  }
  if (parsedWsUrl.protocol !== "wss:" || parsedWsUrl.hostname !== "api.derivws.com" ||
      parsedWsUrl.pathname !== "/trading/v1/options/ws/demo" ||
      !parsedWsUrl.searchParams.get("otp")) {
    console.error("AI_TRADING_WS stage=otp_url_validation_failed");
    return Response.json({ error: "unexpected_websocket_endpoint" }, { status: 502 });
  }
  let upstreamResponse;
  try {
    const upstreamHttpUrl = new URL(wsUrl);
    upstreamHttpUrl.protocol = "https:";
    upstreamResponse = await fetch(upstreamHttpUrl.toString(), { headers: { "Upgrade": "websocket" } });
  } catch (error) {
    console.error("AI_TRADING_WS stage=upstream_fetch_failed name=" + (error?.name || "Error") + " message=" + String(error?.message || "").slice(0,180));
    return Response.json({ error: "deriv_websocket_fetch_failed" }, { status: 502 });
  }
  const upstream = upstreamResponse.webSocket;
  if (upstreamResponse.status !== 101 || !upstream) {
    console.error("AI_TRADING_WS stage=upstream_upgrade_rejected status=" + upstreamResponse.status);
    return Response.json({ error: "deriv_websocket_upgrade_failed", upstream_status: upstreamResponse.status }, { status: 502 });
  }
  console.log("AI_TRADING_WS stage=upstream_upgrade_success status=101");

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept({ allowHalfOpen: true });
  upstream.accept({ allowHalfOpen: true });

  const day = new Date().toISOString().slice(0, 10);
  const riskKey = `risk:${sessionId}:${accountId}:${day}`;
  let risk = { netProfit: 0, stopLoss: 10, takeProfit: 10, maxStake: 10, settled: [] };
  const storedRisk = await env.TOKENS.get(riskKey);
  if (storedRisk) {
    try { risk = { ...risk, ...JSON.parse(storedRisk) }; } catch {}
  }
  const activeBots = new Set();
  const validContracts = new Map();
  const proposals = new Map();
  const proposalRequests = new Map();
  const buyRequests = new Map();
  const openContracts = new Map();
  let nextInternalReqId = 900000;

  const sendClient = value => {
    try { if (server.readyState === WebSocket.OPEN) server.send(JSON.stringify(value)); } catch {}
  };
  const sendError = (reqId, code, message) => {
    const out = { error: { code, message } };
    if (Number.isInteger(reqId)) out.req_id = reqId;
    sendClient(out);
  };
  const saveRisk = async () => {
    await env.TOKENS.put(riskKey, JSON.stringify(risk), { expirationTtl: 172800 });
  };
  const halted = () => risk.netProfit <= -risk.stopLoss || risk.netProfit >= risk.takeProfit;

  server.addEventListener("message", async event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return sendError(null, "INVALID_JSON", "Invalid trading message."); }

    if (msg?.ai_trading_config) {
      const c = msg.ai_trading_config;
      const values = [c.stop_loss, c.take_profit, c.max_stake].map(Number);
      if (values.some(v => !Number.isFinite(v) || v <= 0 || v > 10)) {
        return sendError(null, "RISK_LIMIT", "Stop-loss, take-profit and maximum stake must be greater than zero and no more than $10.");
      }
      risk.stopLoss = values[0];
      risk.takeProfit = values[1];
      risk.maxStake = values[2];
      await saveRisk();
      sendClient({ ai_risk_status: { net_profit: risk.netProfit, stop_loss: risk.stopLoss,
        take_profit: risk.takeProfit, max_stake: risk.maxStake, halted: halted() } });
      return;
    }

    if (msg?.ai_bot_state) {
      const { bot, state } = msg.ai_bot_state;
      if (bot !== "over" || !["RUNNING", "PAUSED", "STOPPED"].includes(state)) {
        return sendError(null, "INVALID_BOT_STATE", "Invalid bot state.");
      }
      if (state === "RUNNING" && !halted()) activeBots.add(bot);
      else activeBots.delete(bot);
      sendClient({ ai_bot_state: { bot, state: activeBots.has(bot) ? "RUNNING" : state } });
      if (halted()) sendClient({ ai_risk_halt: { net_profit: risk.netProfit } });
      return;
    }

    if (msg?.proposal) {
      const bot = msg.passthrough?.bot_id;
      const expectedType = bot === "over" ? "DIGITOVER" : "";
      const expectedBarrier = "2";
      const amount = Number(msg.amount);
      const cap = risk.maxStake;
      if (!activeBots.has(bot) || msg.contract_type !== expectedType || String(msg.barrier) !== expectedBarrier) {
        return sendError(msg.req_id, "BOT_NOT_ARMED", "This bot is not armed for that contract.");
      }
      if (halted()) {
        activeBots.clear();
        sendClient({ ai_risk_halt: { net_profit: risk.netProfit } });
        return sendError(msg.req_id, "RISK_LIMIT_REACHED", "Daily Demo risk limit reached. Bots have been stopped.");
      }
      if (!validContracts.get(msg.underlying_symbol)?.has(expectedType)) {
        return sendError(msg.req_id, "UNSUPPORTED_MARKET", "Deriv has not confirmed this market supports DIGITOVER.");
      }
      if (msg.basis !== "stake" || msg.currency !== (account.currency || "USD") ||
          msg.duration_unit !== "t" || !Number.isInteger(msg.duration) ||
          msg.duration < 1 || msg.duration > 6 || !Number.isFinite(amount) ||
          amount < 0.35 || amount > Math.min(risk.maxStake, cap)) {
        return sendError(msg.req_id, "TRADE_VALIDATION", "Trade parameters exceed the verified Demo limits.");
      }
      if (openContracts.size >= 2) return sendError(msg.req_id, "MAX_OPEN_TRADES", "The maximum of two open Demo contracts has been reached.");
      proposalRequests.set(msg.req_id, { bot, amount, contractType: expectedType, symbol: msg.underlying_symbol });
      upstream.send(JSON.stringify(msg));
      return;
    }

    if (msg?.buy) {
      const proposal = proposals.get(msg.buy);
      if (!proposal || !activeBots.has(proposal.bot) || halted()) {
        return sendError(msg.req_id, "PROPOSAL_NOT_APPROVED", "This proposal is no longer approved for purchase.");
      }
      const price = Number(msg.price);
      if (!Number.isFinite(price) || Math.abs(price - proposal.askPrice) > 0.000001) {
        return sendError(msg.req_id, "PRICE_MISMATCH", "Buy price must match the latest Deriv proposal price.");
      }
      if (openContracts.size >= 2) return sendError(msg.req_id, "MAX_OPEN_TRADES", "The maximum of two open Demo contracts has been reached.");
      proposals.delete(msg.buy);
      buyRequests.set(msg.req_id, proposal);
      upstream.send(JSON.stringify(msg));
      return;
    }

    if (msg?.contracts_for) {
      upstream.send(JSON.stringify(msg));
      return;
    }
    if (msg?.active_symbols || msg?.ticks || msg?.balance || msg?.proposal_open_contract ||
        msg?.portfolio || msg?.forget || msg?.ping) {
      upstream.send(JSON.stringify(msg));
      return;
    }
    sendError(msg?.req_id, "REQUEST_NOT_ALLOWED", "This request is not enabled in the Demo trading connection.");
  });

  upstream.addEventListener("message", async event => {
    let data;
    try { data = JSON.parse(event.data); } catch { sendClient(event.data); return; }

    if (data.msg_type === "contracts_for") {
      const symbol = data.echo_req?.contracts_for;
      const available = Array.isArray(data.contracts_for?.available) ? data.contracts_for.available : [];
      if (symbol) validContracts.set(symbol, new Set(available.map(x => x.contract_type)));
    }

    if (data.error && data.req_id) { proposalRequests.delete(data.req_id); buyRequests.delete(data.req_id); }

    if (data.msg_type === "proposal" && data.proposal?.id) {
      const req = proposalRequests.get(data.req_id);
      if (req) {
        const askPrice = Number(data.proposal.ask_price);
        if (Number.isFinite(askPrice) && askPrice > 0) {
          proposals.set(data.proposal.id, { ...req, askPrice });
        }
        proposalRequests.delete(data.req_id);
      }
    }

    if (data.msg_type === "buy" && data.buy?.contract_id) {
      const meta = buyRequests.get(data.req_id);
      if (meta) {
        openContracts.set(data.buy.contract_id, meta);
        buyRequests.delete(data.req_id);
        upstream.send(JSON.stringify({ proposal_open_contract: 1, contract_id: data.buy.contract_id, subscribe: 1, req_id: ++nextInternalReqId }));
      }
    }

    if (data.msg_type === "proposal_open_contract" && data.proposal_open_contract) {
      const c = data.proposal_open_contract;
      const id = c.contract_id;
      const terminal = c.is_sold === 1 || c.is_sold === true ||
        ["won", "lost", "sold", "expired"].includes(String(c.status || "").toLowerCase());
      if (id && terminal && !risk.settled.includes(id)) {
        const profit = Number(c.profit);
        if (Number.isFinite(profit)) {
          risk.netProfit = Number((risk.netProfit + profit).toFixed(2));
          risk.settled = [...risk.settled, id].slice(-200);
          openContracts.delete(id);
          await saveRisk();
          if (halted()) {
            activeBots.clear();
            sendClient({ ai_risk_halt: { net_profit: risk.netProfit } });
          }
          sendClient({ ai_risk_status: { net_profit: risk.netProfit, stop_loss: risk.stopLoss,
            take_profit: risk.takeProfit, halted: halted() } });
        }
      }
    }

    sendClient(data);
  });

  server.addEventListener("close", () => { try { upstream.close(1000, "Dashboard disconnected"); } catch {} });
  server.addEventListener("error", () => { try { upstream.close(1011, "Dashboard connection error"); } catch {} });
  upstream.addEventListener("close", event => { try { server.close(event.code || 1000, "Deriv disconnected"); } catch {} });
  upstream.addEventListener("error", () => { try { server.close(1011, "Deriv connection error"); } catch {} });

  return new Response(null, { status: 101, webSocket: client });
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

      // Safe Demo WebSocket diagnostic. It never sends trading requests.
      if (path === "/api/trading/test-connection" && request.method === "POST") {
        return await handleTradingConnectionTest(request, env);
      }

      // Secure Demo-only WebSocket proxy. Deriv OTP and OAuth token stay server-side.
      if (path === "/api/trading/ws" && request.method === "GET") {
        return await handleTradingSocket(request, env);
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
