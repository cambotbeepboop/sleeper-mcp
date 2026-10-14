import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server as NodeHttpServer } from "node:http";
import { randomUUID, createPublicKey, verify as verifySignature } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, SERVER_NAME, SERVER_VERSION, type CreateServerOptions } from "./server.js";
import type { ServerContext } from "./context.js";

export interface HttpServerOptions extends CreateServerOptions {
  host?: string;
  port?: number;
  /** Optional bearer token required on /mcp. Read from SLEEPER_MCP_AUTH_TOKEN by default. */
  authToken?: string | null;
  /** Value for Access-Control-Allow-Origin (default "*"). */
  corsOrigin?: string;
  /** Path the MCP endpoint is served on (default "/mcp"). */
  path?: string;
  /**
   * Allow account write tools on a non-loopback address without a bearer token. Off by default:
   * the server refuses to start in that configuration. Read from SLEEPER_MCP_INSECURE_NO_AUTH.
   * Only for deployments that terminate authentication in front of the server.
   */
  insecureNoAuth?: boolean;
  /** Trusted OAuth issuer URL. */
  oauthIssuer?: string | null;
  oauthAudience?: string | null;
  oauthAllowedSub?: string | null;
}

export interface RunningHttpServer {
  httpServer: NodeHttpServer;
  ctx: ServerContext;
  url: string;
  close: () => Promise<void>;
}

/**
 * Serve the MCP server over Streamable HTTP.
 *
 * The server is stateless: every request gets a fresh transport (no session ids), which makes it
 * trivially safe to run behind a load balancer or on serverless hosts. Caches live in `ctx` and are
 * shared across requests.
 */
export async function startHttpServer(options: HttpServerOptions = {}): Promise<RunningHttpServer> {
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const authToken = options.authToken === undefined ? (process.env.SLEEPER_MCP_AUTH_TOKEN ?? null) : options.authToken;
  const corsOrigin = options.corsOrigin ?? "*";
  const mcpPath = options.path ?? "/mcp";
  const insecureNoAuth = options.insecureNoAuth ?? /^(1|true|yes)$/i.test(process.env.SLEEPER_MCP_INSECURE_NO_AUTH ?? "");
  const issuer = (options.oauthIssuer ?? process.env.AUTH0_ISSUER ?? "").replace(/\/$/, "");
  const audience = options.oauthAudience ?? process.env.AUTH0_AUDIENCE ?? "";
  const allowedSub = options.oauthAllowedSub ?? process.env.AUTH0_ALLOWED_SUB ?? "";
  if (issuer && (!issuer.startsWith("https://") || !audience || !allowedSub)) throw new Error("OAuth requires AUTH0_ISSUER, AUTH0_AUDIENCE and AUTH0_ALLOWED_SUB.");
  const oauthEnabled = Boolean(issuer);
  if (oauthEnabled && authToken) throw new Error("OAuth and static bearer auth cannot both be enabled.");
  const { ctx } = createServer(options);
  const jwks = oauthEnabled ? new JwksVerifier(issuer) : null;

  if (ctx.auth && ctx.allowWrites && !authToken && !oauthEnabled && !isLoopback(host) && !insecureNoAuth) {
    throw new Error(
      `Refusing to start: a Sleeper session with account write tools enabled would listen on ${host} ` +
        "without authentication, so anyone who can reach this port could change your lineups, drop players " +
        "and send trades. Set SLEEPER_MCP_AUTH_TOKEN (clients then send \"Authorization: Bearer <token>\"), " +
        "bind to loopback with --host 127.0.0.1, or pass --read-only. If authentication is handled in front " +
        "of this server, set SLEEPER_MCP_INSECURE_NO_AUTH=1 to override.",
    );
  }

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    setCors(res, corsOrigin);

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (url.pathname === "/healthz" || url.pathname === "/health") {
      json(res, 200, {
        ok: true,
        name: SERVER_NAME,
        version: SERVER_VERSION,
        players_loaded: ctx.players.isLoaded,
        players: ctx.players.count,
        requests_sent: ctx.client.requestsSent,
        sleeper_session: Boolean(ctx.auth),
        writes_enabled: ctx.allowWrites,
      });
      return;
    }

    if (url.pathname === "/" && req.method === "GET") {
      json(res, 200, {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        transport: "streamable-http",
        endpoint: mcpPath,
        docs: "https://github.com/joscaz/sleeper-mcp",
      });
      return;
    }

    if (oauthEnabled && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      json(res, 200, { resource: audience, authorization_servers: [issuer], scopes_supported: ["read:fantasy", "write:fantasy"] });
      return;
    }
    if (oauthEnabled && url.pathname === "/.well-known/oauth-protected-resource") {
      json(res, 200, { resource: audience, authorization_servers: [issuer], scopes_supported: ["read:fantasy", "write:fantasy"] });
      return;
    }
    if (url.pathname !== mcpPath) {
      json(res, 404, { error: "not_found", hint: `MCP endpoint is ${mcpPath}` });
      return;
    }

    let canWrite = false;
    if (oauthEnabled) {
      try {
        const match = /^Bearer\\s+(\\S+)$/i.exec(req.headers.authorization ?? "");
        if (!match?.[1]) throw new Error("missing token");
        const claims = await jwks!.verify(match[1], audience);
        if (claims.sub !== allowedSub || !claims.permissions?.includes("read:fantasy")) throw new Error("access denied");
        canWrite = claims.permissions.includes("write:fantasy");
      } catch {
        res.setHeader("WWW-Authenticate", 'Bearer realm="sleeper-mcp", resource_metadata="' + new URL("/.well-known/oauth-protected-resource/mcp", "https://" + req.headers.host).href + '", scope="read:fantasy"');
        json(res, 401, { error: "unauthorized" });
        return;
      }
    }
    if (authToken && !authorized(req, authToken)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="sleeper-mcp"');
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method !== "POST") {
      // Stateless mode: no server-initiated streams (GET) and nothing to DELETE.
      json(res, 405, { error: "method_not_allowed", hint: "Use POST with a JSON-RPC body (stateless Streamable HTTP)." });
      return;
    }

    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close().catch(() => {});
      });
      const { server } = createServer({ ...options, preloadPlayers: false, allowWrites: oauthEnabled ? canWrite : ctx.allowWrites });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      ctx.log(`request failed: ${(err as Error).message}`);
      if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const publicUrl = `http://${displayHost}:${actualPort}${mcpPath}`;
  ctx.log(`listening on ${publicUrl}${authToken ? " (bearer auth enabled)" : ""}${ctx.auth ? (ctx.allowWrites ? " (Sleeper session: account write tools enabled)" : " (Sleeper session: read-only)") : ""}`);
  if (ctx.auth && ctx.allowWrites && !authToken && !oauthEnabled && !isLoopback(host)) {
    ctx.log("WARNING: account write tools are reachable without authentication (SLEEPER_MCP_INSECURE_NO_AUTH is set)");
  }

  return {
    httpServer,
    ctx,
    url: publicUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
        httpServer.closeAllConnections?.();
      }),
  };
}

/** True for bind addresses that only accept connections from the local machine. */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value === token;
}

function setCors(res: ServerResponse, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export { randomUUID };

interface AuthClaims { sub?: string; permissions?: string[]; iss?: string; aud?: string | string[]; exp?: number; nbf?: number }
class JwksVerifier {
  private keys: JsonWebKey[] = [];
  private expires = 0;
  constructor(private readonly issuer: string) {}
  async verify(jwt: string, audience: string): Promise<AuthClaims> {
    const parts = jwt.split(".");
    if (parts.length !== 3) throw new Error("invalid JWT");
    const [h, p, sig] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg?: string; kid?: string };
    if (header.alg !== "RS256" || !header.kid) throw new Error("invalid JWT header");
    if (Date.now() > this.expires || !this.keys.some(k => k.kid === header.kid)) {
      const response = await fetch(this.issuer + "/.well-known/jwks.json", { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("JWKS unavailable");
      this.keys = (await response.json() as { keys: JsonWebKey[] }).keys;
      this.expires = Date.now() + 300000;
    }
    const key = this.keys.find(k => k.kid === header.kid && k.kty === "RSA" && k.use === "sig");
    if (!key || !verifySignature("RSA-SHA256", Buffer.from(h + "." + p), createPublicKey({ key, format: "jwk" }), Buffer.from(sig, "base64url"))) throw new Error("invalid signature");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as AuthClaims;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== this.issuer + "/" || !(typeof claims.aud === "string" ? claims.aud === audience : claims.aud?.includes(audience)) || !claims.exp || claims.exp <= now || (claims.nbf !== undefined && claims.nbf > now)) throw new Error("invalid claims");
    return claims;
  }
}
