import { afterEach, describe, expect, it } from "vitest";
import { SleeperGraphqlClient, SleeperGraphqlError, SLEEPER_GRAPHQL_URL, decodeTokenClaims } from "../src/sleeper/graphql.js";
import { connectedClient } from "./helpers.js";
import { LEAGUE_ID, SCHEDULE_URL, preKickoffSchedule2026, transactionsWeek5 } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Fake Sleeper GraphQL endpoint
// ---------------------------------------------------------------------------

type Handler = (vars: Record<string, unknown>) => unknown;
interface GqlCall {
  op: string;
  vars: Record<string, unknown>;
  headers: Record<string, string>;
}

/** HTTP-level override: `{ __status, body }` is sent verbatim instead of being wrapped in `data`. */
const raw = (status: number, body: unknown) => ({ __status: status, body });

function fakeGraphql(handlers: Record<string, Handler> = {}) {
  const calls: GqlCall[] = [];
  const table: Record<string, Handler> = { ...handlers };
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    expect(url).toBe(SLEEPER_GRAPHQL_URL);
    const body = JSON.parse(String(init?.body)) as { operationName: string; variables: Record<string, unknown>; query: string };
    calls.push({ op: body.operationName, vars: body.variables, headers: (init?.headers ?? {}) as Record<string, string> });
    expect(body.query).toContain(body.operationName);
    const handler = body.operationName === "matchup_legs"
      ? (() => {
          const updated = calls.filter(x => x.op === "update_matchup_leg").at(-1);
          if (updated) return [{ roster_id: updated.vars.roster_id as number, starters: updated.vars.starters }];
          const dedicated = table.matchup_legs?.({ league_id: LEAGUE_ID });
          if (Array.isArray(dedicated)) return dedicated;
          const live = table.league_rosters?.({ league_id: LEAGUE_ID });
          const liveRows = Array.isArray(live) ? live as Array<{ roster_id: number; starters: string[] }> : [ROSTER_1];
          return liveRows.map(r => ({ roster_id: r.roster_id, starters: r.starters }));
        })
      : table[body.operationName];
    if (!handler) {
      return json(200, { data: { [body.operationName]: null }, errors: [{ code: "unauthorized", message: "Unauthorized", path: [body.operationName] }] });
    }
    const out = handler(body.variables) as { __status?: number; body?: unknown } | unknown;
    if (out && typeof out === "object" && "__status" in (out as object)) {
      const o = out as { __status: number; body: unknown };
      return json(o.__status, o.body);
    }
    return json(200, { data: { [body.operationName]: out } });
  }) as typeof fetch;
  return {
    fetch: impl,
    calls,
    set: (op: string, handler: Handler) => {
      table[op] = handler;
    },
    last: (op: string) => [...calls].reverse().find((c) => c.op === op),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Unsigned JWT for user 111 (alice in the fixtures). */
function fakeJwt(claims: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ user_id: 111, display_name: "Alice", exp: 4_102_444_800, ...claims })}.sig`;
}

const ROSTER_1 = {
  roster_id: 1,
  league_id: LEAGUE_ID,
  owner_id: "111",
  players: ["4046", "9226", "8138", "7564", "6794", "5850", "8112", "4195", "DET", "6813", "9509"],
  starters: ["4046", "9226", "8138", "7564", "6794", "5850", "8112", "4195", "DET"],
  reserve: null,
  taxi: null,
  settings: {},
  metadata: {},
};

/** Echo back what the mutation asked for, the way Sleeper returns the updated roster. */
const rosterEcho: Record<string, Handler> = {
  roster_update_starters: (v) => ({ ...ROSTER_1, starters: v.starters }),
  update_matchup_leg: (v) => ({ ...ROSTER_1, roster_id: v.roster_id, starters: v.starters }),
  roster_update_reserve: (v) => ({ ...ROSTER_1, reserve: v.reserve }),
  roster_update_taxi: (v) => ({ ...ROSTER_1, taxi: v.taxi }),
};

const pendingTrade = {
  transaction_id: "t9",
  type: "trade",
  status: "proposed",
  status_updated: null,
  created: 1_760_100_000_000,
  creator: "222",
  leg: 5,
  league_id: LEAGUE_ID,
  roster_ids: [2, 1],
  consenter_ids: [2],
  adds: { "4984": 1, "5850": 2 },
  drops: { "4984": 2, "5850": 1 },
  draft_picks: [],
  waiver_budget: [],
  settings: null,
  metadata: null,
};

const pendingClaim = {
  transaction_id: "w7",
  type: "waiver",
  status: "pending",
  status_updated: null,
  created: 1_760_100_500_000,
  creator: "111",
  leg: 5,
  league_id: LEAGUE_ID,
  roster_ids: [1],
  consenter_ids: [1],
  adds: { "11000": 1 },
  drops: { "4195": 1 },
  draft_picks: [],
  waiver_budget: [],
  settings: { waiver_bid: 12, seq: 1 },
  metadata: null,
};

type Connected = Awaited<ReturnType<typeof connectedClient>>;
let c: Connected | undefined;

async function connectWithAuth(
  handlers: Record<string, Handler> = {},
  options: { allowWrites?: boolean; token?: string | null; email?: string; password?: string; routes?: Record<string, unknown> } = {},
) {
  const gql = fakeGraphql({ me: () => ({ user_id: "111", username: "alice", display_name: "Alice", email: null }), ...handlers });
  const auth = new SleeperGraphqlClient({
    token: options.token === undefined ? fakeJwt() : options.token,
    email: options.email,
    password: options.password,
    fetch: gql.fetch,
  });
  c = await connectedClient(options.routes ?? {}, { auth, allowWrites: options.allowWrites });
  return { ...c, gql };
}

afterEach(async () => {
  await c?.close();
  c = undefined;
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("account tools registration", () => {
  it("registers read + write account tools when a session is configured", async () => {
    const { client } = await connectWithAuth();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      "get_auth_status",
      "get_pending_transactions",
      "set_lineup",
      "update_ir",
      "update_taxi",
      "add_drop_player",
      "submit_waiver_claim",
      "cancel_waiver_claim",
      "propose_trade",
      "respond_to_trade",
      "post_league_message",
    ]) {
      expect(names).toContain(name);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.get_auth_status!.annotations?.readOnlyHint).toBe(true);
    expect(byName.get_pending_transactions!.annotations?.readOnlyHint).toBe(true);
    expect(byName.set_lineup!.annotations?.readOnlyHint).toBe(false);
    expect(byName.add_drop_player!.annotations?.destructiveHint).toBe(true);
    expect(byName.set_lineup!.description).toContain("dry_run");
  });

  it("keeps only the private reads in --read-only mode", async () => {
    const { client, ctx } = await connectWithAuth({}, { allowWrites: false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("get_auth_status");
    expect(names).toContain("get_pending_transactions");
    expect(names).not.toContain("set_lineup");
    expect(names).not.toContain("propose_trade");
    expect(ctx.allowWrites).toBe(false);
  });

  it("registers nothing account-related without credentials", async () => {
    c = await connectedClient();
    const names = (await c.client.listTools()).tools.map((t) => t.name);
    expect(names.some((n) => ["get_auth_status", "set_lineup", "propose_trade"].includes(n))).toBe(false);
    expect(c.ctx.auth).toBeNull();
    expect(c.ctx.allowWrites).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

describe("get_auth_status", () => {
  it("sends the raw token as the authorization header and reports the session", async () => {
    const { call, gql } = await connectWithAuth();
    const { data } = await call("get_auth_status");
    expect(data).toMatchObject({ authenticated: true, user_id: "111", username: "alice", writes_enabled: true, source: "token" });
    expect(data!.token_expires).toBe("2100-01-01T00:00:00.000Z");
    const me = gql.last("me")!;
    expect(me.headers.authorization).toBe(fakeJwt());
    expect(me.headers.authorization.startsWith("Bearer")).toBe(false);
    expect(me.headers["x-sleeper-graphql-op"]).toBe("me");
    expect(me.headers.origin).toBe("https://sleeper.com");
  });

  it("explains an expired/invalid token", async () => {
    const { call } = await connectWithAuth({ me: () => raw(401, { errors: [{ message: "Your token is invalid." }] }) });
    const { result, text } = await call("get_auth_status");
    expect(result.isError).toBe(true);
    expect(text).toContain("Your token is invalid");
    expect(text).toContain("SLEEPER_TOKEN");
  });
});

// ---------------------------------------------------------------------------
// Lineup
// ---------------------------------------------------------------------------

describe("set_lineup", () => {
  it("swaps a bench player in for a starter and sends the full starters array", async () => {
    const { call, gql } = await connectWithAuth(rosterEcho);
    const { data, result } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(data).toMatchObject({ dry_run: false, team: "Alice's Avengers (Alice)", changes: ["TE: Travis Kelce (TE, KC) → Sam LaPorta (TE, DET)"] });
    const sent = gql.last("update_matchup_leg")!;
    expect(sent.vars).toEqual({ league_id: LEAGUE_ID, roster_id: 1, round: 5, leg: 5, starters: ["4046", "9226", "8138", "7564", "6794", "9509", "8112", "4195", "DET"] });
    const starters = (data!.roster as { starters: { slot: string; name: string }[] }).starters;
    expect(starters.find((s) => s.slot === "TE")?.name).toBe("Sam LaPorta");
  });

  it("sees a player added seconds ago that the public roster does not list yet", async () => {
    // The public API copy (fixtures) has no Rookie Runner; Sleeper's live store already does.
    const { call, gql } = await connectWithAuth({
      ...rosterEcho,
      league_rosters: () => [{ ...ROSTER_1, players: [...ROSTER_1.players, "11000"] }],
    });
    const { data, result } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Rookie Runner", bench: "Breece Hall" }] });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(gql.last("league_rosters")!.vars).toEqual({ league_id: LEAGUE_ID });
    expect(data!.changes).toEqual(["RB: Breece Hall (RB, NYJ) → Rookie Runner (RB, GB)"]);
    expect(gql.last("update_matchup_leg")!.vars.starters).toEqual(["4046", "9226", "11000", "7564", "6794", "5850", "8112", "4195", "DET"]);
  });

  it("falls back to the public roster when the live read fails", async () => {
    const { call } = await connectWithAuth({ ...rosterEcho, league_rosters: () => ({ __status: 500, body: { errors: [{ message: "boom" }] } }) });
    const { result } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  });

  it("swaps two starters when both are already in the lineup", async () => {
    const { call, gql } = await connectWithAuth(rosterEcho);
    const { data } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Drake London", bench: "Justin Jefferson" }] });
    expect(data!.changes).toEqual(["WR: Justin Jefferson (WR, MIN) → Drake London (WR, ATL)", "FLEX: Drake London (WR, ATL) → Justin Jefferson (WR, MIN)"]);
    expect(gql.last("update_matchup_leg")!.vars.starters).toEqual(["4046", "9226", "8138", "7564", "8112", "5850", "6794", "4195", "DET"]);
  });

  it("dry_run validates and previews without calling Sleeper", async () => {
    const { call, gql } = await connectWithAuth(rosterEcho);
    const { data } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Jonathan Taylor", bench: "Breece Hall" }], dry_run: true });
    expect(data).toMatchObject({ dry_run: true, changes: ["RB: Breece Hall (RB, NYJ) → Jonathan Taylor (RB, IND)"] });
    expect(gql.calls.filter((x) => x.op === "update_matchup_leg")).toHaveLength(0);
  });

  it("accepts a full starters list with empty slots", async () => {
    const { call, gql } = await connectWithAuth(rosterEcho);
    const { data, result } = await call("set_lineup", {
      league_id: LEAGUE_ID,
      starters: ["Patrick Mahomes", "Bijan Robinson", "Jonathan Taylor", "Ja'Marr Chase", "Justin Jefferson", "Sam LaPorta", "Breece Hall", "Harrison Butker", "Lions"],
    });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(gql.last("update_matchup_leg")!.vars.starters).toEqual(["4046", "9226", "6813", "7564", "6794", "9509", "8138", "4195", "DET"]);
    expect(data!.changes).toHaveLength(3);
  });

  it("rejects ineligible slots, IR/taxi players and unknown names before sending anything", async () => {
    const { call, gql } = await connectWithAuth(rosterEcho);
    let r = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Jonathan Taylor", bench: "Patrick Mahomes" }] });
    expect(r.result.isError).toBe(true);
    expect(r.text).toContain("cannot start at QB");

    r = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Josh Allen", bench: "Patrick Mahomes" }] });
    expect(r.result.isError).toBe(true);
    expect(r.text).toContain("is not on this roster");

    r = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Jonathan Taylor" }] });
    expect(r.result.isError).toBe(true);
    expect(r.text).toContain("not currently starting");

    r = await call("set_lineup", { league_id: LEAGUE_ID, starters: ["Patrick Mahomes"] });
    expect(r.result.isError).toBe(true);
    expect(r.text).toContain("9 starting slots");

    r = await call("set_lineup", { league_id: LEAGUE_ID });
    expect(r.result.isError).toBe(true);
    expect(gql.calls.filter((x) => x.op === "update_matchup_leg")).toHaveLength(0);
  });

  it("reports when nothing changes", async () => {
    const { call, gql } = await connectWithAuth(rosterEcho);
    const { data } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Travis Kelce", bench: "Travis Kelce" }] });
    expect(data).toMatchObject({ changed: false });
    expect(gql.calls.filter((x) => x.op === "update_matchup_leg")).toHaveLength(0);
  });

  it("fills an empty slot when no bench player is named", async () => {
    const { call, gql, ff } = await connectWithAuth({
      update_matchup_leg: (v) => ({ ...ROSTER_1, roster_id: 2, owner_id: "222", players: ["4984", "SF", "11001"], starters: v.starters }),
      matchup_legs: () => [{ roster_id: 2, starters: ["4984", "0", "0", "0", "0", "0", "0", "0", "SF"] }],
    });
    // Bob's roster (2) has empty slots; give him a bench RB and act on it explicitly via roster_id.
    (ff as unknown as { set: (path: string, body: unknown) => void }).set(`/league/${LEAGUE_ID}/rosters`, [
      ROSTER_1,
      { ...ROSTER_1, roster_id: 2, owner_id: "222", players: ["4984", "SF", "11001"], starters: ["4984", "0", "0", "0", "0", "0", "0", "0", "SF"] },
    ]);
    const { data, result } = await call("set_lineup", { league_id: LEAGUE_ID, roster_id: 2, moves: [{ start: "Handcuff Harry" }] });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(data!.changes).toEqual(["RB: (empty) → Handcuff Harry (RB, PHI)"]);
    const sent = gql.last("update_matchup_leg")!;
    expect(sent.vars.roster_id).toBe(2);
    expect(sent.vars.starters).toEqual(["4984", "11001", "0", "0", "0", "0", "0", "0", "SF"]);

    const noRoom = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta" }] });
    expect(noRoom.result.isError).toBe(true);
    expect(noRoom.text).toContain("No empty slot");
  });

  it("surfaces Sleeper's refusal message", async () => {
    const { call } = await connectWithAuth({
      update_matchup_leg: () => raw(200, { data: { update_matchup_leg: null }, errors: [{ code: "invalid", message: "Games have already started for this player", path: ["update_matchup_leg"] }] }),
    });
    const { result, text } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError).toBe(true);
    expect(text).toContain("Sleeper refused the change");
    expect(text).toContain("Games have already started");
  });
});

describe("check_lineups with a session", () => {
  it("checks the logged-in manager's live lineup and its moves apply as-is with set_lineup", async () => {
    // Sleeper's live store already has Breece Hall benched (empty RB slot); the public copy still starts him.
    const live = { ...ROSTER_1, starters: ["4046", "9226", "0", "7564", "6794", "5850", "8112", "4195", "DET"] };
    const { call, gql } = await connectWithAuth({ ...rosterEcho, league_rosters: () => [live] }, { routes: { [SCHEDULE_URL]: preKickoffSchedule2026 } });
    const { data, result } = await call("check_lineups", {});
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(data!.user_id).toBe("111");
    expect(data!.note).toBeUndefined();
    expect(data!.next_step).toMatch(/set_lineup/);
    const [report] = data!.leagues as { problems: { slot: string; issue: string; replacement: { name: string } }[]; set_lineup: Record<string, unknown> }[];
    expect(report!.problems.map((p) => [p.slot, p.issue, p.replacement.name])).toEqual([
      ["RB", "empty", "Jonathan Taylor"],
      ["TE", "out", "Sam LaPorta"],
    ]);
    expect(report!.set_lineup).toEqual({ league_id: LEAGUE_ID, moves: [{ start: "6813", slot: "RB" }, { start: "9509", bench: "5850" }] });
    expect(gql.calls.filter((x) => x.op === "roster_update_starters")).toHaveLength(0);

    const applied = await call("set_lineup", report!.set_lineup);
    expect(applied.result.isError, JSON.stringify(applied.result.content)).toBeFalsy();
    expect(gql.last("update_matchup_leg")!.vars.starters).toEqual(["4046", "9226", "6813", "7564", "6794", "9509", "8112", "4195", "DET"]);
  });
});

// ---------------------------------------------------------------------------
// IR / taxi
// ---------------------------------------------------------------------------

describe("update_ir / update_taxi", () => {
  it("benches a starter before moving him to IR and respects the slot count", async () => {
    const { call, gql } = await connectWithAuth(rosterEcho);
    const { data, result } = await call("update_ir", { league_id: LEAGUE_ID, add: ["Travis Kelce"] });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(data!.changes).toEqual(["Travis Kelce (TE, KC): starter → IR (slot left empty, fill it with set_lineup)"]);
    const ops = gql.calls.map((x) => x.op).filter((op) => op.startsWith("roster_update"));
    expect(ops).toEqual(["roster_update_starters", "roster_update_reserve"]);
    expect(gql.last("roster_update_starters")!.vars.starters).toEqual(["4046", "9226", "8138", "7564", "6794", "0", "8112", "4195", "DET"]);
    expect(gql.last("roster_update_reserve")!.vars).toEqual({ league_id: LEAGUE_ID, roster_id: 1, reserve: ["5850"] });
    expect((data!.roster as { ir: { name: string }[] }).ir.map((p) => p.name)).toEqual(["Travis Kelce"]);

    const tooMany = await call("update_ir", { league_id: LEAGUE_ID, add: ["Travis Kelce", "Jonathan Taylor"] });
    expect(tooMany.result.isError).toBe(true);
    expect(tooMany.text).toContain("IR holds 1 player(s)");
  });

  it("activates from IR and moves bench players to taxi", async () => {
    const { call, gql, ff } = await connectWithAuth(rosterEcho);
    // Give alice a player on IR for this test.
    const base = ff as unknown as { set: (path: string, body: unknown) => void };
    base.set(`/league/${LEAGUE_ID}/rosters`, [{ ...ROSTER_1, reserve: ["6813"] }]);
    const off = await call("update_ir", { league_id: LEAGUE_ID, remove: ["Jonathan Taylor"] });
    expect(off.result.isError, off.text).toBeFalsy();
    expect(gql.last("roster_update_reserve")!.vars.reserve).toEqual([]);

    const taxi = await call("update_taxi", { league_id: LEAGUE_ID, add: ["Sam LaPorta"] });
    expect(taxi.result.isError, taxi.text).toBeFalsy();
    expect(gql.last("roster_update_taxi")!.vars).toEqual({ league_id: LEAGUE_ID, roster_id: 1, taxi: ["9509"], force: false });
    expect(taxi.data!.changes).toEqual(["Sam LaPorta (TE, DET): bench → taxi"]);
  });
});

// ---------------------------------------------------------------------------
// Free agents & waivers
// ---------------------------------------------------------------------------

describe("add_drop_player / submit_waiver_claim / cancel_waiver_claim", () => {
  it("adds a free agent and drops a rostered player in one free_agent transaction", async () => {
    const { call, gql } = await connectWithAuth({
      league_create_transaction: (v) => ({ ...pendingClaim, transaction_id: "fa1", type: "free_agent", status: "complete", adds: { "11000": 1 }, drops: { "4195": 1 }, settings: null }),
    });
    const { data, result } = await call("add_drop_player", { league_id: LEAGUE_ID, add: "Rookie Runner", drop: "Butker" });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(gql.last("league_create_transaction")!.vars).toEqual({ league_id: LEAGUE_ID, type: "free_agent", k_adds: ["11000"], v_adds: [1], k_drops: ["4195"], v_drops: [1] });
    expect(data).toMatchObject({ add: { name: "Rookie Runner" }, drop: { name: "Harrison Butker" } });
    expect((data!.transaction as { status: string }).status).toBe("complete");
  });

  it("refuses to add a rostered player and previews with dry_run", async () => {
    const { call, gql } = await connectWithAuth();
    const taken = await call("add_drop_player", { league_id: LEAGUE_ID, add: "Josh Allen" });
    expect(taken.result.isError).toBe(true);
    expect(taken.text).toContain("already rostered by");
    expect(taken.text).toContain("Bobby Tables");

    const preview = await call("add_drop_player", { league_id: LEAGUE_ID, add: "Handcuff Harry", dry_run: true });
    expect(preview.data).toMatchObject({ dry_run: true, add: { id: "11001" } });
    expect(gql.calls.filter((x) => x.op === "league_create_transaction")).toHaveLength(0);
  });

  it("requires a bid in FAAB leagues and submits the claim with settings", async () => {
    const { call, gql } = await connectWithAuth({ submit_waiver_claim: (v) => ({ ...pendingClaim, settings: { waiver_bid: (v.v_settings as number[])[0], seq: 1 } }) });
    const noBid = await call("submit_waiver_claim", { league_id: LEAGUE_ID, add: "Rookie Runner" });
    expect(noBid.result.isError).toBe(true);
    expect(noBid.text).toContain("FAAB");

    const { data, result } = await call("submit_waiver_claim", { league_id: LEAGUE_ID, add: "Rookie Runner", drop: "Harrison Butker", bid: 12 });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(gql.last("submit_waiver_claim")!.vars).toEqual({
      league_id: LEAGUE_ID,
      k_adds: ["11000"],
      v_adds: [1],
      k_drops: ["4195"],
      v_drops: [1],
      k_settings: ["waiver_bid"],
      v_settings: [12],
    });
    expect(data).toMatchObject({ bid: 12, waiver_position: 4 });
    expect(data!.transaction).toMatchObject({ transaction_id: "w7", status: "pending", pending: true, faab_bid: 12, sequence: 1 });
  });

  it("adds a roster room hint to Sleeper's invalid-roster refusal", async () => {
    const { call } = await connectWithAuth({
      submit_waiver_claim: () => raw(200, { data: { submit_waiver_claim: null }, errors: [{ message: "Your roster is either invalid or will be invalid after this move.", path: ["submit_waiver_claim"] }] }),
    });
    const { result, text } = await call("submit_waiver_claim", { league_id: LEAGUE_ID, add: "Rookie Runner", bid: 1 });
    expect(result.isError).toBe(true);
    expect(text).toContain("roster is either invalid");
    expect(text).toContain("name a drop");
  });

  it("cancels a claim using the week it was found in", async () => {
    const { call, gql } = await connectWithAuth({
      league_transactions_filtered: () => [pendingClaim, pendingTrade],
      cancel_waiver_claim: () => ({ ...pendingClaim, status: "cancelled" }),
    });
    const wrongKind = await call("cancel_waiver_claim", { league_id: LEAGUE_ID, transaction_id: "t9" });
    expect(wrongKind.result.isError).toBe(true);
    expect(wrongKind.text).toContain("not a waiver claim");

    const { data, result } = await call("cancel_waiver_claim", { league_id: LEAGUE_ID, transaction_id: "w7" });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(gql.last("cancel_waiver_claim")!.vars).toEqual({ league_id: LEAGUE_ID, transaction_id: "w7", leg: 5 });
    expect((data!.transaction as { status: string }).status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

describe("trades", () => {
  it("proposes a trade with adds/drops mapped to the receiving and giving rosters", async () => {
    const { call, gql } = await connectWithAuth({
      propose_trade: (v) => ({
        ...pendingTrade,
        transaction_id: "t10",
        creator: "111",
        consenter_ids: [1],
        adds: Object.fromEntries((v.k_adds as string[]).map((k, i) => [k, (v.v_adds as number[])[i]])),
        drops: Object.fromEntries((v.k_drops as string[]).map((k, i) => [k, (v.v_drops as number[])[i]])),
      }),
    });
    const { data, result } = await call("propose_trade", { league_id: LEAGUE_ID, partner: "bob", give: ["Travis Kelce"], receive: ["Josh Allen"] });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const sent = gql.last("propose_trade")!.vars as { k_adds: string[]; v_adds: number[]; k_drops: string[]; v_drops: number[]; reject_transaction_id: unknown; league_id: string };
    const zip = (k: string[], v: number[]) => Object.fromEntries(k.map((key, i) => [key, v[i]]));
    expect(sent.league_id).toBe(LEAGUE_ID);
    expect(sent.reject_transaction_id).toBeNull();
    expect(zip(sent.k_adds, sent.v_adds)).toEqual({ "5850": 2, "4984": 1 });
    expect(zip(sent.k_drops, sent.v_drops)).toEqual({ "5850": 1, "4984": 2 });
    expect(data).toMatchObject({ from: "Alice's Avengers (Alice)", to: "Team Bobby Tables (Bobby Tables)", deadline_week: 12 });
    expect(data!.transaction).toMatchObject({ transaction_id: "t10", direction: "sent", awaiting: ["Team Bobby Tables (Bobby Tables)"], pending: true });
    expect((data!.transaction as { trade_summary: Record<string, unknown> }).trade_summary).toEqual({
      "Alice's Avengers (Alice)": { gave: ["Travis Kelce (TE, KC)"], got: ["Josh Allen (QB, BUF)"] },
      "Team Bobby Tables (Bobby Tables)": { gave: ["Josh Allen (QB, BUF)"], got: ["Travis Kelce (TE, KC)"] },
    });
  });

  it("validates both sides of a trade", async () => {
    const { call, gql } = await connectWithAuth();
    let r = await call("propose_trade", { league_id: LEAGUE_ID, partner: "bob", give: ["Josh Allen"], receive: ["Travis Kelce"] });
    expect(r.result.isError).toBe(true);
    expect(r.text).toContain("is not on your roster");

    r = await call("propose_trade", { league_id: LEAGUE_ID, partner: "alice", give: ["Travis Kelce"], receive: [] });
    expect(r.result.isError).toBe(true);
    expect(r.text).toContain("your own team");

    r = await call("propose_trade", { league_id: LEAGUE_ID, partner: "nobody", give: ["Travis Kelce"] });
    expect(r.result.isError).toBe(true);

    r = await call("propose_trade", { league_id: LEAGUE_ID, partner: "bob", give: ["Travis Kelce"], receive: ["Josh Allen"], dry_run: true });
    expect(r.data).toMatchObject({ dry_run: true, give: [{ id: "5850" }], receive: [{ id: "4984" }] });
    expect(gql.calls.filter((x) => x.op === "propose_trade")).toHaveLength(0);
  });

  it("counters by rejecting the received offer in the same proposal", async () => {
    const { call, gql } = await connectWithAuth({
      league_transactions_filtered: () => [pendingTrade],
      propose_trade: () => ({ ...pendingTrade, transaction_id: "t11", creator: "111", consenter_ids: [1] }),
    });
    const { result } = await call("propose_trade", { league_id: LEAGUE_ID, partner: "2", give: ["Sam LaPorta"], receive: ["Josh Allen"], counter_transaction_id: "t9" });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(gql.last("propose_trade")!.vars).toMatchObject({ reject_transaction_id: "t9", reject_transaction_leg: 5 });
  });

  it("accepts, rejects and cancels offers", async () => {
    const { call, gql } = await connectWithAuth({
      league_transactions_filtered: () => [pendingTrade],
      accept_trade: () => ({ ...pendingTrade, status: "complete", consenter_ids: [2, 1] }),
      reject_trade: () => ({ ...pendingTrade, status: "rejected" }),
    });
    const accepted = await call("respond_to_trade", { league_id: LEAGUE_ID, transaction_id: "t9", action: "accept" });
    expect(accepted.result.isError, accepted.text).toBeFalsy();
    expect(gql.last("accept_trade")!.vars).toEqual({ league_id: LEAGUE_ID, transaction_id: "t9", leg: 5 });
    expect((accepted.data!.transaction as { status: string }).status).toBe("complete");

    const cancelled = await call("respond_to_trade", { league_id: LEAGUE_ID, transaction_id: "t9", action: "cancel", week: 5 });
    expect(cancelled.result.isError, cancelled.text).toBeFalsy();
    expect(gql.last("reject_trade")!.vars).toEqual({ league_id: LEAGUE_ID, transaction_id: "t9", leg: 5 });

    const preview = await call("respond_to_trade", { league_id: LEAGUE_ID, transaction_id: "t9", action: "reject", dry_run: true });
    expect(preview.data).toMatchObject({ dry_run: true, action: "reject" });
    expect(gql.calls.filter((x) => x.op === "reject_trade")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pending transactions & chat
// ---------------------------------------------------------------------------

describe("get_pending_transactions", () => {
  it("lists open trades and claims for the logged-in team with direction and resolved names", async () => {
    const { call, gql } = await connectWithAuth({
      league_transactions_filtered: () => [pendingTrade, pendingClaim, { ...transactionsWeek5[0]!, league_id: LEAGUE_ID }],
    });
    const { data, result } = await call("get_pending_transactions", { league_id: LEAGUE_ID });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(gql.last("league_transactions_filtered")!.vars).toMatchObject({ league_id: LEAGUE_ID, leg_filters: [5, 4], roster_id_filters: [1] });
    expect(data).toMatchObject({ week: 5, weeks_searched: [5, 4], team: "Alice's Avengers (Alice)" });
    const trades = data!.trades as Record<string, unknown>[];
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ transaction_id: "t9", direction: "received", awaiting: ["Alice's Avengers (Alice)"], pending: true });
    const claims = data!.waiver_claims as Record<string, unknown>[];
    expect(claims[0]).toMatchObject({ transaction_id: "w7", faab_bid: 12, sequence: 1 });
    expect((claims[0]!.adds as { player: string }[])[0]!.player).toBe("Rookie Runner (RB, GB)");

    const all = await call("get_pending_transactions", { league_id: LEAGUE_ID, all_teams: true, include_finished: true });
    expect(gql.last("league_transactions_filtered")!.vars.roster_id_filters).toBeNull();
    expect((all.data!.trades as unknown[]).length).toBe(2);
  });

  it("searches only the requested week when one is given", async () => {
    const { call, gql } = await connectWithAuth({
      league_transactions_filtered: () => [pendingClaim],
    });
    const { data, result } = await call("get_pending_transactions", { league_id: LEAGUE_ID, week: 4 });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(gql.last("league_transactions_filtered")!.vars.leg_filters).toEqual([4]);
    expect(data).toMatchObject({ week: 4, weeks_searched: [4] });
  });
});

describe("post_league_message", () => {
  it("posts to the league chat", async () => {
    const { call, gql } = await connectWithAuth({
      create_message: (v) => ({ message_id: "m1", parent_id: v.parent_id, parent_type: v.parent_type, text: v.text, created: 1_760_200_000_000, author_id: "111" }),
    });
    const { data, result } = await call("post_league_message", { league_id: LEAGUE_ID, text: "Kelce for Allen?" });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(gql.last("create_message")!.vars).toMatchObject({ parent_id: LEAGUE_ID, parent_type: "league", text: "Kelce for Allen?" });
    expect(data).toMatchObject({ message_id: "m1", league: "Test Dynasty" });
  });
});

// ---------------------------------------------------------------------------
// GraphQL client
// ---------------------------------------------------------------------------

describe("SleeperGraphqlClient", () => {
  it("decodes JWT claims and exposes the user id", () => {
    expect(decodeTokenClaims(fakeJwt())).toMatchObject({ user_id: 111, display_name: "Alice" });
    expect(decodeTokenClaims("not-a-jwt")).toBeNull();
    const client = new SleeperGraphqlClient({ token: fakeJwt(), fetch: fakeGraphql().fetch });
    expect(client.userId).toBe("111");
    expect(client.configured).toBe(true);
    expect(new SleeperGraphqlClient({ fetch: fakeGraphql().fetch }).configured).toBe(false);
  });

  it("logs in lazily with email/password and reuses the returned token", async () => {
    const gql = fakeGraphql({
      login: (v) => (v.password === "hunter2" ? { user_id: "111", username: "alice", display_name: "Alice", token: "tok-1", verification: null, email: "a@x.io" } : raw(200, { data: { login: null }, errors: [{ message: "Invalid password" }] })),
      me: () => ({ user_id: "111", username: "alice", display_name: "Alice", email: null }),
    });
    const client = new SleeperGraphqlClient({ email: "alice@x.io", password: "hunter2", fetch: gql.fetch });
    expect(client.hasToken).toBe(false);
    const me = await client.me();
    expect(me.user_id).toBe("111");
    expect(gql.calls.map((x) => x.op)).toEqual(["login", "me"]);
    expect(gql.calls[0]!.headers.authorization).toBeUndefined();
    expect(gql.calls[1]!.headers.authorization).toBe("tok-1");
    expect(client.userId).toBe("111");
    await client.me();
    expect(gql.calls.filter((x) => x.op === "login")).toHaveLength(1);

    const bad = new SleeperGraphqlClient({ email: "alice@x.io", password: "nope", fetch: gql.fetch });
    await expect(bad.me()).rejects.toMatchObject({ name: "SleeperGraphqlError", operation: "login", message: expect.stringContaining("Invalid password") });
  });

  it("maps GraphQL errors, 401s and missing sessions to SleeperGraphqlError", async () => {
    const gql = fakeGraphql({ me: () => raw(401, { errors: [{ message: "Your token is invalid." }] }) });
    const client = new SleeperGraphqlClient({ token: "expired", fetch: gql.fetch });
    const err = await client.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SleeperGraphqlError);
    expect((err as SleeperGraphqlError).unauthorized).toBe(true);
    expect((err as SleeperGraphqlError).status).toBe(401);

    const anon = fakeGraphql();
    const noSession = new SleeperGraphqlClient({ fetch: anon.fetch });
    await expect(noSession.me()).rejects.toMatchObject({ code: "unauthorized", message: expect.stringContaining("SLEEPER_TOKEN") });
    expect(anon.calls).toHaveLength(0);

    const unauth = new SleeperGraphqlClient({ token: "t", fetch: anon.fetch });
    const e2 = (await unauth.updateStarters(LEAGUE_ID, 1, ["0"]).catch((e: unknown) => e)) as SleeperGraphqlError;
    expect(e2.unauthorized).toBe(true);
    expect(e2.code).toBe("unauthorized");
  });

  it("encodes maps as parallel k_/v_ arrays and omits empty ones", async () => {
    const gql = fakeGraphql({ propose_trade: () => pendingTrade, league_create_transaction: () => pendingClaim, submit_waiver_claim: () => pendingClaim });
    const client = new SleeperGraphqlClient({ token: "t", fetch: gql.fetch });
    await client.createFreeAgentTransaction(LEAGUE_ID, { "11000": 1 }, {});
    expect(gql.last("league_create_transaction")!.vars).toEqual({ league_id: LEAGUE_ID, type: "free_agent", k_adds: ["11000"], v_adds: [1], k_drops: null, v_drops: null });
    await client.submitWaiverClaim(LEAGUE_ID, { "11000": 1 }, {}, { sequence: 2 });
    expect(gql.last("submit_waiver_claim")!.vars).toMatchObject({ k_settings: ["seq"], v_settings: [2] });
    await client.proposeTrade(LEAGUE_ID, { a: 2 }, { a: 1 }, { rejectTransactionId: "t9", rejectTransactionLeg: 5 });
    expect(gql.last("propose_trade")!.vars).toMatchObject({ k_adds: ["a"], v_adds: [2], k_drops: ["a"], v_drops: [1], reject_transaction_id: "t9", reject_transaction_leg: 5, draft_picks: null });
  });
});
