/**
 * Authenticated client for Sleeper's private GraphQL API (the one the web/mobile apps use).
 *
 * Everything the public REST API cannot do goes through here: lineup changes, IR/taxi moves,
 * add/drop, waiver claims, trades and league chat. The operation names and arguments below were
 * taken from the live schema via introspection (https://sleeper.com/graphql, Absinthe, snake_case).
 *
 * This API is unofficial and undocumented. It can change without notice, and automating an
 * account is at the user's own risk.
 */

export const SLEEPER_GRAPHQL_URL = "https://sleeper.com/graphql";

/** Fields selected for every roster-returning mutation. */
const ROSTER_FIELDS = "roster_id league_id owner_id players starters reserve taxi settings metadata";
/** Fields selected for every transaction-returning operation. */
const TRANSACTION_FIELDS =
  "transaction_id type status status_updated created creator leg league_id roster_ids consenter_ids adds drops draft_picks waiver_budget settings metadata";

export class SleeperGraphqlError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly status: number,
    public readonly code: string | null = null,
    public readonly errors: GraphqlErrorEntry[] = [],
  ) {
    super(message);
    this.name = "SleeperGraphqlError";
  }

  get unauthorized(): boolean {
    return this.status === 401 || this.code === "unauthorized";
  }
}

export interface GraphqlErrorEntry {
  message?: string;
  code?: string;
  path?: (string | number)[];
  data?: unknown;
  [key: string]: unknown;
}

export interface GqlRoster {
  roster_id: number;
  league_id: string;
  owner_id: string | null;
  players: string[] | null;
  starters: string[] | null;
  reserve: string[] | null;
  taxi: string[] | null;
  settings: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export interface GqlTransaction {
  transaction_id: string;
  type: string;
  status: string;
  status_updated: number | null;
  created: number | null;
  creator: string | null;
  leg: number;
  league_id: string;
  roster_ids: number[] | null;
  consenter_ids: number[] | null;
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  draft_picks: unknown[] | null;
  waiver_budget: unknown[] | null;
  settings: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export interface GqlUser {
  user_id: string;
  username: string | null;
  display_name: string | null;
  token?: string | null;
  verification?: unknown;
  email?: string | null;
}

export interface GqlMessage {
  message_id: string;
  parent_id: string | null;
  parent_type: string | null;
  text: string | null;
  created: number | null;
  author_id: string | null;
}

export interface TokenClaims {
  user_id?: string | number;
  display_name?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

export interface SleeperGraphqlOptions {
  /** Session JWT (the `authorization` header the Sleeper web app sends). */
  token?: string | null;
  /** Credentials for a username/password login, used lazily when no token is set. */
  email?: string | null;
  password?: string | null;
  url?: string;
  fetch?: typeof fetch;
  userAgent?: string;
  timeoutMs?: number;
  log?: (message: string) => void;
}

/** Mapping of player_id -> roster_id, encoded as Sleeper's parallel k_/v_ arrays. */
export type PlayerRosterMap = Record<string, number>;

export interface WaiverClaimOptions {
  /** FAAB bid (leagues with a waiver budget). */
  bid?: number;
  /** Order among your own pending claims (1 = processed first). */
  sequence?: number;
}

export interface ProposeTradeOptions {
  /** Draft picks, in Sleeper's string encoding (pass-through, optional). */
  draftPicks?: string[];
  /** FAAB transfers, in Sleeper's string encoding (pass-through, optional). */
  waiverBudget?: string[];
  /** When countering: the offer being rejected in the same step. */
  rejectTransactionId?: string;
  rejectTransactionLeg?: number;
}

export interface TransactionFilter {
  types?: string[];
  statuses?: string[];
  legs?: number[];
  rosterIds?: number[];
  limit?: number;
}

function splitMap(map: PlayerRosterMap | undefined): { k: string[] | null; v: number[] | null } {
  const entries = Object.entries(map ?? {});
  if (!entries.length) return { k: null, v: null };
  return { k: entries.map(([id]) => id), v: entries.map(([, rosterId]) => rosterId) };
}

function splitSettings(settings: Record<string, number | string> | undefined): { k: string[] | null; v: (number | string)[] | null } {
  const entries = Object.entries(settings ?? {});
  if (!entries.length) return { k: null, v: null };
  return { k: entries.map(([key]) => key), v: entries.map(([, value]) => value) };
}

/** Decode the payload of a JWT without verifying it (we only use it for display/expiry hints). */
export function decodeTokenClaims(token: string): TokenClaims | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(payload) as unknown;
    return claims && typeof claims === "object" ? (claims as TokenClaims) : null;
  } catch {
    return null;
  }
}

export class SleeperGraphqlClient {
  readonly url: string;
  private token: string | null;
  private readonly email: string | null;
  private readonly password: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;
  private loginPromise: Promise<GqlUser> | null = null;
  private loggedInUserId: string | null = null;
  private requestCount = 0;

  constructor(options: SleeperGraphqlOptions = {}) {
    this.url = options.url ?? SLEEPER_GRAPHQL_URL;
    this.token = options.token?.trim() || null;
    this.email = options.email?.trim() || null;
    this.password = options.password ?? null;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? "sleeper-mcp (+https://github.com/joscaz/sleeper-mcp)";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.log = options.log ?? (() => {});
    if (!this.fetchImpl) throw new Error("No fetch implementation available; Node.js 20+ is required.");
  }

  /** True when a token is set or a login can be attempted. */
  get configured(): boolean {
    return Boolean(this.token || (this.email && this.password));
  }

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  /** Claims from the current token (user_id, display_name, exp), if it is a JWT. */
  get claims(): TokenClaims | null {
    return this.token ? decodeTokenClaims(this.token) : null;
  }

  get requestsSent(): number {
    return this.requestCount;
  }

  /** user_id of the session owner: from the login response, else from the JWT claims. */
  get userId(): string | null {
    if (this.loggedInUserId) return this.loggedInUserId;
    const claim = this.claims?.user_id;
    return claim === undefined || claim === null ? null : String(claim);
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  /**
   * Execute one operation. `operation` is the root field name; it is also sent as
   * `x-sleeper-graphql-op` like the web app does. Auth is attached unless `anonymous` is set.
   */
  async execute<T>(operation: string, query: string, variables: Record<string, unknown> = {}, opts: { anonymous?: boolean } = {}): Promise<T> {
    if (!opts.anonymous && !this.token) await this.ensureLoggedIn();

    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      origin: "https://sleeper.com",
      referer: "https://sleeper.com/",
      "user-agent": this.userAgent,
      "x-sleeper-graphql-op": operation,
    };
    if (!opts.anonymous && this.token) headers.authorization = this.token;

    this.requestCount++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ operationName: operation, variables, query }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new SleeperGraphqlError(`Network error calling Sleeper GraphQL: ${(err as Error).message}`, operation, 0);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: { data?: Record<string, unknown> | null; errors?: GraphqlErrorEntry[] } = {};
    if (text) {
      try {
        payload = JSON.parse(text) as typeof payload;
      } catch {
        throw new SleeperGraphqlError(`Sleeper GraphQL returned non-JSON (HTTP ${response.status})`, operation, response.status);
      }
    }

    if (response.status === 401) {
      const message = payload.errors?.[0]?.message ?? "Your token is invalid.";
      throw new SleeperGraphqlError(`Sleeper rejected the session token: ${message}`, operation, 401, "unauthorized", payload.errors ?? []);
    }
    if (response.status === 429) {
      throw new SleeperGraphqlError("Sleeper rate limit hit (HTTP 429). Slow down and retry shortly.", operation, 429);
    }
    if (payload.errors?.length) {
      const first = payload.errors[0]!;
      const code = typeof first.code === "string" ? first.code : null;
      const message = first.message ?? "unknown error";
      const detail = payload.errors.length > 1 ? ` (+${payload.errors.length - 1} more)` : "";
      throw new SleeperGraphqlError(`${operation} failed: ${message}${detail}`, operation, response.status, code, payload.errors);
    }
    if (!response.ok) {
      throw new SleeperGraphqlError(`Sleeper GraphQL error (HTTP ${response.status})`, operation, response.status);
    }
    const data = payload.data?.[operation];
    return data as T;
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  /** Log in with email/phone/username + password and keep the returned token for later calls. */
  async login(emailOrUsername: string, password: string): Promise<GqlUser> {
    const user = await this.execute<GqlUser | null>(
      "login",
      `query login($who: String!, $password: String) { login(email_or_phone_or_username: $who, password: $password) { user_id username display_name token verification email } }`,
      { who: emailOrUsername, password },
      { anonymous: true },
    );
    if (!user?.token) {
      const hint = user?.verification ? " Sleeper is asking for extra verification (2FA/captcha); log in through the app and use SLEEPER_TOKEN instead." : "";
      throw new SleeperGraphqlError(`Login did not return a session token.${hint}`, "login", 200, "login_failed");
    }
    this.token = user.token;
    this.loggedInUserId = String(user.user_id);
    this.log(`logged in to Sleeper as ${user.display_name ?? user.username ?? user.user_id}`);
    return user;
  }

  private ensureLoggedIn(): Promise<GqlUser> {
    if (!this.email || !this.password) {
      return Promise.reject(
        new SleeperGraphqlError(
          "No Sleeper session. Set SLEEPER_TOKEN (or SLEEPER_EMAIL + SLEEPER_PASSWORD) to enable authenticated tools.",
          "login",
          0,
          "unauthorized",
        ),
      );
    }
    this.loginPromise ??= this.login(this.email, this.password).catch((err: Error) => {
      this.loginPromise = null;
      throw err;
    });
    return this.loginPromise;
  }

  /** The logged-in user (validates the token). */
  me(): Promise<GqlUser> {
    return this.execute<GqlUser>("me", `query me { me { user_id username display_name email } }`);
  }

  // ---------------------------------------------------------------------------
  // Roster management
  // ---------------------------------------------------------------------------

  /** Every roster in a league from Sleeper's live store; the public API can trail a write by a minute or two. */
  rosters(leagueId: string): Promise<GqlRoster[]> {
    return this.execute<GqlRoster[]>(
      "league_rosters",
      `query league_rosters($league_id: Snowflake!) { league_rosters(league_id: $league_id) { ${ROSTER_FIELDS} } }`,
      { league_id: leagueId },
    );
  }

  /** Update the scoring lineup for a specific matchup week, not the roster-level default starters. */
  updateStarters(leagueId: string, rosterId: number, starters: string[], week: number): Promise<GqlRoster> {
    return this.execute<GqlRoster>(
      "update_matchup_leg",
      `mutation update_matchup_leg($league_id: Snowflake!, $roster_id: Int!, $round: Int!, $leg: Int!, $starters: [String]) { update_matchup_leg(league_id: $league_id, roster_id: $roster_id, round: $round, leg: $leg, starters: $starters) { roster_id starters } }`,
      { league_id: leagueId, roster_id: rosterId, round: week, leg: week, starters },
    );
  }

  /** Authenticated uncached weekly matchup read for independent post-write verification. */
  matchupLegStarters(leagueId: string, week: number): Promise<Array<{ roster_id: number; starters: string[] | null }>> {
    return this.execute<Array<{ roster_id: number; starters: string[] | null }>>(
      "matchup_legs",
      `query matchup_legs($league_id: Snowflake!, $round: Int!) { matchup_legs(league_id: $league_id, round: $round) { roster_id starters } }`,
      { league_id: leagueId, round: week },
    );
  }

  /** Replace the full IR list. */
  updateReserve(leagueId: string, rosterId: number, reserve: string[]): Promise<GqlRoster> {
    return this.execute<GqlRoster>(
      "roster_update_reserve",
      `mutation roster_update_reserve($league_id: Snowflake!, $roster_id: Int!, $reserve: [String]) { roster_update_reserve(league_id: $league_id, roster_id: $roster_id, reserve: $reserve) { ${ROSTER_FIELDS} } }`,
      { league_id: leagueId, roster_id: rosterId, reserve },
    );
  }

  /** Replace the full taxi squad list. */
  updateTaxi(leagueId: string, rosterId: number, taxi: string[], force = false): Promise<GqlRoster> {
    return this.execute<GqlRoster>(
      "roster_update_taxi",
      `mutation roster_update_taxi($league_id: Snowflake!, $roster_id: Int!, $taxi: [String], $force: Boolean) { roster_update_taxi(league_id: $league_id, roster_id: $roster_id, taxi: $taxi, force: $force) { ${ROSTER_FIELDS} } }`,
      { league_id: leagueId, roster_id: rosterId, taxi, force },
    );
  }

  // ---------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------

  /** Immediate free-agent add and/or drop. `adds`/`drops` map player_id -> roster_id. */
  createFreeAgentTransaction(leagueId: string, adds: PlayerRosterMap, drops: PlayerRosterMap): Promise<GqlTransaction> {
    const a = splitMap(adds);
    const d = splitMap(drops);
    return this.execute<GqlTransaction>(
      "league_create_transaction",
      `mutation league_create_transaction($league_id: Snowflake!, $type: String!, $k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int]) { league_create_transaction(league_id: $league_id, type: $type, k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops) { ${TRANSACTION_FIELDS} } }`,
      { league_id: leagueId, type: "free_agent", k_adds: a.k, v_adds: a.v, k_drops: d.k, v_drops: d.v },
    );
  }

  /** Submit a waiver claim (processed at the league's waiver run). */
  submitWaiverClaim(leagueId: string, adds: PlayerRosterMap, drops: PlayerRosterMap, options: WaiverClaimOptions = {}): Promise<GqlTransaction> {
    const a = splitMap(adds);
    const d = splitMap(drops);
    const settings: Record<string, number> = {};
    if (options.bid !== undefined) settings.waiver_bid = options.bid;
    if (options.sequence !== undefined) settings.seq = options.sequence;
    const s = splitSettings(settings);
    return this.execute<GqlTransaction>(
      "submit_waiver_claim",
      `mutation submit_waiver_claim($league_id: Snowflake!, $k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int], $k_settings: [String], $v_settings: [Int]) { submit_waiver_claim(league_id: $league_id, k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops, k_settings: $k_settings, v_settings: $v_settings) { ${TRANSACTION_FIELDS} } }`,
      { league_id: leagueId, k_adds: a.k, v_adds: a.v, k_drops: d.k, v_drops: d.v, k_settings: s.k, v_settings: s.v },
    );
  }

  /** Change the bid / order of a pending waiver claim. */
  updateWaiverClaim(leagueId: string, transactionId: string, leg: number, options: WaiverClaimOptions): Promise<GqlTransaction> {
    const settings: Record<string, number> = {};
    if (options.bid !== undefined) settings.waiver_bid = options.bid;
    if (options.sequence !== undefined) settings.seq = options.sequence;
    const s = splitSettings(settings);
    return this.execute<GqlTransaction>(
      "update_waiver_claim",
      `mutation update_waiver_claim($league_id: Snowflake!, $transaction_id: Snowflake!, $leg: Int!, $k_settings: [String], $v_settings: [Int]) { update_waiver_claim(league_id: $league_id, transaction_id: $transaction_id, leg: $leg, k_settings: $k_settings, v_settings: $v_settings) { ${TRANSACTION_FIELDS} } }`,
      { league_id: leagueId, transaction_id: transactionId, leg, k_settings: s.k, v_settings: s.v },
    );
  }

  cancelWaiverClaim(leagueId: string, transactionId: string, leg: number): Promise<GqlTransaction> {
    return this.execute<GqlTransaction>(
      "cancel_waiver_claim",
      `mutation cancel_waiver_claim($league_id: Snowflake!, $transaction_id: Snowflake!, $leg: Int!) { cancel_waiver_claim(league_id: $league_id, transaction_id: $transaction_id, leg: $leg) { ${TRANSACTION_FIELDS} } }`,
      { league_id: leagueId, transaction_id: transactionId, leg },
    );
  }

  /**
   * Propose a trade. `adds` maps player_id -> roster_id that receives the player,
   * `drops` maps player_id -> roster_id that gives the player up.
   */
  proposeTrade(leagueId: string, adds: PlayerRosterMap, drops: PlayerRosterMap, options: ProposeTradeOptions = {}): Promise<GqlTransaction> {
    const a = splitMap(adds);
    const d = splitMap(drops);
    return this.execute<GqlTransaction>(
      "propose_trade",
      `mutation propose_trade($league_id: Snowflake!, $k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int], $draft_picks: [String], $waiver_budget: [String], $reject_transaction_id: Snowflake, $reject_transaction_leg: Int) { propose_trade(league_id: $league_id, k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops, draft_picks: $draft_picks, waiver_budget: $waiver_budget, reject_transaction_id: $reject_transaction_id, reject_transaction_leg: $reject_transaction_leg) { ${TRANSACTION_FIELDS} } }`,
      {
        league_id: leagueId,
        k_adds: a.k,
        v_adds: a.v,
        k_drops: d.k,
        v_drops: d.v,
        draft_picks: options.draftPicks ?? null,
        waiver_budget: options.waiverBudget ?? null,
        reject_transaction_id: options.rejectTransactionId ?? null,
        reject_transaction_leg: options.rejectTransactionLeg ?? null,
      },
    );
  }

  acceptTrade(leagueId: string, transactionId: string, leg: number): Promise<GqlTransaction> {
    return this.execute<GqlTransaction>(
      "accept_trade",
      `mutation accept_trade($league_id: Snowflake!, $transaction_id: Snowflake!, $leg: Int!) { accept_trade(league_id: $league_id, transaction_id: $transaction_id, leg: $leg) { ${TRANSACTION_FIELDS} } }`,
      { league_id: leagueId, transaction_id: transactionId, leg },
    );
  }

  /** Reject an incoming offer, or cancel one you proposed (same mutation on Sleeper's side). */
  rejectTrade(leagueId: string, transactionId: string, leg: number): Promise<GqlTransaction> {
    return this.execute<GqlTransaction>(
      "reject_trade",
      `mutation reject_trade($league_id: Snowflake!, $transaction_id: Snowflake!, $leg: Int!) { reject_trade(league_id: $league_id, transaction_id: $transaction_id, leg: $leg) { ${TRANSACTION_FIELDS} } }`,
      { league_id: leagueId, transaction_id: transactionId, leg },
    );
  }

  /** Transactions including pending waiver claims and proposed trades (needs league membership). */
  async transactions(leagueId: string, filter: TransactionFilter = {}): Promise<GqlTransaction[]> {
    const result = await this.execute<GqlTransaction[] | null>(
      "league_transactions_filtered",
      `query league_transactions_filtered($league_id: Snowflake!, $type_filters: [String], $status_filters: [String], $leg_filters: [Int], $roster_id_filters: [Int], $limit: Int) { league_transactions_filtered(league_id: $league_id, type_filters: $type_filters, status_filters: $status_filters, leg_filters: $leg_filters, roster_id_filters: $roster_id_filters, limit: $limit) { ${TRANSACTION_FIELDS} } }`,
      {
        league_id: leagueId,
        type_filters: filter.types ?? null,
        status_filters: filter.statuses ?? null,
        leg_filters: filter.legs ?? null,
        roster_id_filters: filter.rosterIds ?? null,
        limit: filter.limit ?? null,
      },
    );
    return result ?? [];
  }

  // ---------------------------------------------------------------------------
  // League chat
  // ---------------------------------------------------------------------------

  /** Post a message to the league chat. */
  postLeagueMessage(leagueId: string, text: string): Promise<GqlMessage> {
    return this.execute<GqlMessage>(
      "create_message",
      `mutation create_message($parent_id: Snowflake!, $parent_type: String!, $text: String, $client_id: String) { create_message(parent_id: $parent_id, parent_type: $parent_type, text: $text, client_id: $client_id) { message_id parent_id parent_type text created author_id } }`,
      { parent_id: leagueId, parent_type: "league", text, client_id: `sleeper-mcp-${Date.now()}` },
    );
  }
}
