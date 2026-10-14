import { afterEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import { startHttpServer, type RunningHttpServer } from "../src/http.js";
import { PlayerStore } from "../src/sleeper/players.js";
import { fakeFetch, testClient } from "./helpers.js";

const issuer = "https://example.auth0.test";
const audience = "https://sleeper-mcp-x7vb.onrender.com/mcp";
const sub = "google-oauth2|test-user";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };
let running: RunningHttpServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.unstubAllGlobals();
});

function token(permissions: string[], overrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: issuer + "/", aud: audience, sub,
    exp: Math.floor(Date.now() / 1000) + 600, permissions, ...overrides,
  })).toString("base64url");
  const data = header + "." + claims;
  const signature = createSign("RSA-SHA256").update(data).end().sign(privateKey).toString("base64url");
  return data + "." + signature;
}

async function setup() {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === issuer + "/.well-known/jwks.json")
      return Promise.resolve(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));
    return originalFetch(input, init);
  });
  const sleeper = testClient(fakeFetch());
  running = await startHttpServer({
    host: "127.0.0.1", port: 0, authToken: null,
    oauthIssuer: issuer, oauthAudience: audience, oauthAllowedSub: sub,
    sleeperToken: "eyJ.fake.jwt", client: sleeper,
    players: new PlayerStore(sleeper, { cacheDir: null }),
    log: () => {}, preloadPlayers: false,
  });
  return running.url;
}

async function listTools(url: string, jwt?: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(jwt ? { authorization: "Bearer " + jwt } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  return { status: res.status, challenge: res.headers.get("www-authenticate"), body: await res.json() };
}

describe("Auth0 OAuth authorization", () => {
  it("advertises resource metadata and rejects requests without tokens", async () => {
    const url = await setup();
    const base = url.replace(/\/mcp$/, "");
    const metadata = await fetch(base + "/.well-known/oauth-protected-resource/mcp");
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource: audience, authorization_servers: [issuer] });
    const result = await listTools(url);
    expect(result.status).toBe(401);
    expect(result.challenge).toContain("resource_metadata");
  });

  it("allows reading without exposing write tools for read-only scope", async () => {
    const url = await setup();
    const result = await listTools(url, token(["read:fantasy"]));
    expect(result.status).toBe(200);
    const names = (result.body as { result: { tools: { name: string }[] } }).result.tools.map(t => t.name);
    expect(names).toContain("get_league");
    expect(names).not.toContain("set_lineup");
    expect(names).not.toContain("submit_waiver_claim");
  });

  it("exposes write tools only with the assigned write permission", async () => {
    const url = await setup();
    const result = await listTools(url, token(["read:fantasy", "write:fantasy"]));
    expect(result.status).toBe(200);
    const names = (result.body as { result: { tools: { name: string }[] } }).result.tools.map(t => t.name);
    expect(names).toContain("set_lineup");
    expect(names).toContain("submit_waiver_claim");
  });

  it("rejects wrong user, wrong audience, expired and tampered tokens", async () => {
    const url = await setup();
    for (const jwt of [
      token(["read:fantasy"], { sub: "someone-else" }),
      token(["read:fantasy"], { aud: "https://different.example/mcp" }),
      token(["read:fantasy"], { exp: 1 }),
      token(["write:fantasy"]),
      token(["read:fantasy"]).slice(0, -2) + "xx",
    ]) {
      const result = await listTools(url, jwt);
      expect(result.status).toBe(401);
    }
  });
});
