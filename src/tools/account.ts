/**
 * Account tools: everything that needs a Sleeper session (SLEEPER_TOKEN or SLEEPER_EMAIL/PASSWORD).
 *
 * Read tools (pending trades/claims, who am I) are registered whenever a session is configured.
 * Write tools (lineup, IR, taxi, add/drop, waivers, trades, league chat) are registered unless the
 * server runs with --read-only. Every write accepts dry_run=true to preview the exact change.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadLeague, resolveRoster, resolveWeek, ToolError, type LeagueBundle, type ServerContext } from "../context.js";
import { SLOT_ELIGIBILITY, isoDate, startingSlots, teamLabel } from "../format.js";
import type { GqlRoster, GqlTransaction, SleeperGraphqlClient } from "../sleeper/graphql.js";
import { normalizeName, playerFullName } from "../sleeper/players.js";
import type { Roster, Transaction } from "../sleeper/types.js";
import { describeRoster } from "./rosters.js";
import { describeTransaction } from "./transactions.js";
import { guard, leagueIdSchema, weekSchema } from "./shared.js";

const WRITE_NOTE = "Changes the manager's real Sleeper account: confirm with them first. Use dry_run=true to preview without saving.";

const dryRunSchema = z.boolean().default(false).describe("Validate and show the resulting change without sending it to Sleeper.");
const ownRosterSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Roster to act on. Defaults to the logged-in account's own team in this league (commissioners may pass another roster_id).");
const playerSchema = z.string().trim().min(1).describe("Player name (e.g. \"Blake Corum\", \"Vikings\") or Sleeper player_id.");
const playerListSchema = z.array(playerSchema).describe("Player names or player_ids.");
const transactionIdSchema = z.string().trim().min(1).describe("Sleeper transaction_id (see get_pending_transactions).");
const OPEN_TRANSACTION_STATUSES = new Set(["proposed", "pending", "open"]);
const FINISHED_TRANSACTION_STATUSES = new Set(["complete", "failed", "rejected", "cancelled", "canceled", "vetoed", "expired"]);

export function registerAccountTools(server: McpServer, ctx: ServerContext): void {
  const auth = ctx.auth;
  if (!auth) return;

  // ---------------------------------------------------------------------------
  // Reads that need a session
  // ---------------------------------------------------------------------------

  server.registerTool(
    "get_auth_status",
    {
      title: "Sleeper session status",
      description: "Which Sleeper account this server is logged in as, whether the session token is valid/expiring, and whether write tools are enabled.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        const claims = auth.claims;
        const expires = typeof claims?.exp === "number" ? isoDate(claims.exp * (claims.exp < 1e12 ? 1000 : 1)) : null;
        const me = await auth.me();
        return {
          authenticated: true,
          user_id: me.user_id,
          username: me.username,
          display_name: me.display_name,
          token_expires: expires,
          writes_enabled: ctx.allowWrites,
          source: auth.hasToken ? "token" : "login",
          note: "Sleeper's GraphQL API is unofficial; automated changes are made at the account owner's own risk.",
        };
      }),
  );

  server.registerTool(
    "get_pending_transactions",
    {
      title: "Pending trades and waiver claims",
      description:
        "Open transactions the public API hides: trade offers waiting for a response (sent and received) and waiver claims queued for the next waiver run, with players and teams resolved. Defaults to the logged-in team's transactions for the current and previous week (claims filed before Sleeper rolls the week over stay filed under the old week until they process); pass week to look at one week only. Set all_teams=true for league-wide pending trades.",
      inputSchema: {
        league_id: leagueIdSchema,
        week: weekSchema,
        all_teams: z.boolean().default(false).describe("Include transactions that do not involve the logged-in team."),
        include_finished: z.boolean().default(false).describe("Also return completed/failed/rejected transactions from those weeks."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, week, all_teams, include_finished }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        await ctx.players.ensureLoaded();
        const { week: leg } = await resolveWeek(ctx, week);
        // Sleeper files a transaction under the week it was created in and leaves it there while it is
        // open, so right after the rollover the queued claims and offers still live under last week.
        const legs = week !== undefined ? [leg] : [...new Set([leg, Math.max(1, leg - 1)])];
        const roster = all_teams ? null : await resolveOwnRoster(ctx, bundle, undefined);
        const list = await auth.transactions(bundle.league.league_id, { legs, rosterIds: roster ? [roster.roster_id] : undefined, limit: 200 });
        const rows = list
          .filter((t) => include_finished || !FINISHED_TRANSACTION_STATUSES.has(t.status))
          .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
          .map((t) => describeOpenTransaction(ctx, bundle, t, roster?.roster_id ?? null));
        return {
          league_id: bundle.league.league_id,
          league: bundle.league.name,
          week: leg,
          weeks_searched: legs,
          team: roster ? teamLabel(bundle.teams, roster.roster_id) : "(all teams)",
          trades: rows.filter((r) => r.type === "trade"),
          waiver_claims: rows.filter((r) => r.type === "waiver"),
          other: rows.filter((r) => r.type !== "trade" && r.type !== "waiver"),
        };
      }),
  );

  if (!ctx.allowWrites) return;

  // ---------------------------------------------------------------------------
  // Lineup
  // ---------------------------------------------------------------------------

  server.registerTool(
    "set_lineup",
    {
      title: "Set starting lineup",
      description:
        `Change who starts. Either pass moves (start X for Y; Y omitted = first open eligible slot) or the complete starters list in league slot order. Slot eligibility (FLEX, SUPER_FLEX...), IR/taxi and duplicates are validated before anything is sent. ${WRITE_NOTE}`,
      inputSchema: {
        league_id: leagueIdSchema,
        roster_id: ownRosterSchema,
        moves: z
          .array(
            z.object({
              start: playerSchema.describe("Player to put in the lineup."),
              bench: playerSchema.optional().describe("Current starter to take out (swap if 'start' is already starting). Omit to fill an empty slot."),
              slot: z.string().trim().toUpperCase().optional().describe("Target slot label (QB, RB, WR, TE, FLEX, SUPER_FLEX, K, DEF...) when it matters."),
            }),
          )
          .optional()
          .describe("Incremental changes applied to the current lineup, in order."),
        starters: playerListSchema.optional().describe("Full lineup in roster_positions order (use \"0\" or \"empty\" for an empty slot). Alternative to moves."),
        dry_run: dryRunSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ league_id, roster_id, moves, starters, dry_run }) =>
      guard(async () => {
        if (!moves?.length && !starters) throw new ToolError("Pass either moves (e.g. [{start: \"Blake Corum\", bench: \"Josh Jacobs\"}]) or the full starters list.");
        const bundle = await loadLeague(ctx, league_id);
        await ctx.players.ensureLoaded();
        const roster = await resolveOwnRoster(ctx, bundle, roster_id);
        const plan = planLineup(ctx, bundle, roster, { moves, starters });
        if (!plan.changes.length) {
          return { league_id: bundle.league.league_id, team: teamLabel(bundle.teams, roster.roster_id), changed: false, note: "Lineup already matches; nothing sent.", roster: describeRoster(ctx, bundle, roster, true) };
        }
        const { week } = await resolveWeek(ctx, undefined);
        return commitRoster(ctx, bundle, roster, dry_run, plan.changes, { starters: plan.starters }, () =>
          auth.updateStarters(bundle.league.league_id, roster.roster_id, plan.starters, week).then(async (result) => {
            const actual = (await auth.matchupLegStarters(bundle.league.league_id, week))
              .find((leg) => leg.roster_id === roster.roster_id);
            if (!actual || JSON.stringify(actual.starters) !== JSON.stringify(plan.starters)) {
              throw new ToolError("Weekly matchup starters could not be verified; do not treat this change as saved.");
            }
            return { ...result, starters: actual.starters };
          }),
        );
      }),
  );

  // ---------------------------------------------------------------------------
  // IR / taxi
  // ---------------------------------------------------------------------------

  server.registerTool(
    "update_ir",
    {
      title: "Move players to / from IR",
      description: `Place players on injured reserve or activate them. A starter being moved is benched first. Sleeper enforces the league's IR eligibility rules (Out/IR/PUP/NA...) and slot count. ${WRITE_NOTE}`,
      inputSchema: {
        league_id: leagueIdSchema,
        roster_id: ownRosterSchema,
        add: playerListSchema.default([]).describe("Players to move onto IR."),
        remove: playerListSchema.default([]).describe("Players to activate from IR (they go to the bench)."),
        dry_run: dryRunSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ league_id, roster_id, add, remove, dry_run }) =>
      guard(async () => {
        if (!add.length && !remove.length) throw new ToolError("Pass players in add (to IR) and/or remove (activate).");
        const bundle = await loadLeague(ctx, league_id);
        await ctx.players.ensureLoaded();
        const roster = await resolveOwnRoster(ctx, bundle, roster_id);
        const capacity = num(bundle.league.settings?.reserve_slots) || (bundle.league.roster_positions ?? []).filter((s) => s === "IR").length;
        const plan = planListChange(ctx, roster, roster.reserve ?? [], { add, remove, capacity, label: "IR" });
        return commitRoster(ctx, bundle, roster, dry_run, plan.changes, { reserve: plan.list, starters: plan.starters }, async () => {
          if (plan.starters) await auth.updateStarters(bundle.league.league_id, roster.roster_id, plan.starters);
          return auth.updateReserve(bundle.league.league_id, roster.roster_id, plan.list);
        });
      }),
  );

  server.registerTool(
    "update_taxi",
    {
      title: "Move players to / from the taxi squad",
      description: `Stash players on the taxi squad or promote them to the active roster. A starter being stashed is benched first. Sleeper enforces the league's taxi rules (rookies/years, slots, deadline). ${WRITE_NOTE}`,
      inputSchema: {
        league_id: leagueIdSchema,
        roster_id: ownRosterSchema,
        add: playerListSchema.default([]).describe("Players to move onto the taxi squad."),
        remove: playerListSchema.default([]).describe("Players to promote to the active roster."),
        force: z.boolean().default(false).describe("Pass Sleeper's force flag (used by the app to confirm taxi warnings)."),
        dry_run: dryRunSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ league_id, roster_id, add, remove, force, dry_run }) =>
      guard(async () => {
        if (!add.length && !remove.length) throw new ToolError("Pass players in add (to taxi) and/or remove (promote).");
        const bundle = await loadLeague(ctx, league_id);
        await ctx.players.ensureLoaded();
        const roster = await resolveOwnRoster(ctx, bundle, roster_id);
        const capacity = num(bundle.league.settings?.taxi_slots);
        if (!capacity) throw new ToolError(`League "${bundle.league.name}" has no taxi squad.`);
        const plan = planListChange(ctx, roster, roster.taxi ?? [], { add, remove, capacity, label: "taxi" });
        return commitRoster(ctx, bundle, roster, dry_run, plan.changes, { taxi: plan.list, starters: plan.starters }, async () => {
          if (plan.starters) await auth.updateStarters(bundle.league.league_id, roster.roster_id, plan.starters);
          return auth.updateTaxi(bundle.league.league_id, roster.roster_id, plan.list, force);
        });
      }),
  );

  // ---------------------------------------------------------------------------
  // Free agents & waivers
  // ---------------------------------------------------------------------------

  server.registerTool(
    "add_drop_player",
    {
      title: "Add / drop a free agent",
      description: `Immediate free-agent pickup and/or drop (not a waiver claim). Fails if the player is still on waivers or the roster would be over the limit. ${WRITE_NOTE}`,
      inputSchema: {
        league_id: leagueIdSchema,
        roster_id: ownRosterSchema,
        add: playerSchema.optional().describe("Free agent to add."),
        drop: playerSchema.optional().describe("Rostered player to drop."),
        dry_run: dryRunSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ league_id, roster_id, add, drop, dry_run }) =>
      guard(async () => {
        if (!add && !drop) throw new ToolError("Pass add and/or drop.");
        const bundle = await loadLeague(ctx, league_id);
        await ctx.players.ensureLoaded();
        const roster = await resolveOwnRoster(ctx, bundle, roster_id);
        const addId = add ? await resolveFreeAgent(ctx, bundle, add) : null;
        const dropId = drop ? findOnRoster(ctx, roster, drop) : null;
        const preview = {
          league_id: bundle.league.league_id,
          team: teamLabel(bundle.teams, roster.roster_id),
          add: addId ? ctx.players.ref(addId) : null,
          drop: dropId ? ctx.players.ref(dropId) : null,
        };
        if (dry_run) return { ...preview, dry_run: true, note: "Nothing sent." };
        const tx = await auth.createFreeAgentTransaction(
          bundle.league.league_id,
          addId ? { [addId]: roster.roster_id } : {},
          dropId ? { [dropId]: roster.roster_id } : {},
        );
        invalidateLeague(ctx, bundle.league.league_id, tx.leg);
        return { ...preview, dry_run: false, transaction: describeTransaction(ctx, bundle, tx as unknown as Transaction) };
      }),
  );

  server.registerTool(
    "submit_waiver_claim",
    {
      title: "Submit a waiver claim",
      description: `Queue a claim for the next waiver run (FAAB bid or priority). Optional drop is executed only if the claim wins. ${WRITE_NOTE}`,
      inputSchema: {
        league_id: leagueIdSchema,
        roster_id: ownRosterSchema,
        add: playerSchema.describe("Player to claim."),
        drop: playerSchema.optional().describe("Player to drop if the claim succeeds."),
        bid: z.number().int().min(0).optional().describe("FAAB bid (required in FAAB leagues; ignored otherwise)."),
        sequence: z.number().int().min(1).optional().describe("Order among your own pending claims (1 = first)."),
        dry_run: dryRunSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ league_id, roster_id, add, drop, bid, sequence, dry_run }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        await ctx.players.ensureLoaded();
        const roster = await resolveOwnRoster(ctx, bundle, roster_id);
        const faab = bundle.league.settings?.waiver_type === 2;
        if (faab && bid === undefined) throw new ToolError(`League "${bundle.league.name}" uses FAAB: pass a bid.`);
        const addId = await resolveFreeAgent(ctx, bundle, add);
        const dropId = drop ? findOnRoster(ctx, roster, drop) : null;
        const preview: Record<string, unknown> = {
          league_id: bundle.league.league_id,
          team: teamLabel(bundle.teams, roster.roster_id),
          add: ctx.players.ref(addId),
          drop: dropId ? ctx.players.ref(dropId) : null,
          waiver_position: roster.settings?.waiver_position ?? null,
        };
        if (faab) preview.bid = bid;
        if (sequence !== undefined) preview.sequence = sequence;
        if (dry_run) return { ...preview, dry_run: true, note: "Nothing sent." };
        const tx = await auth.submitWaiverClaim(
          bundle.league.league_id,
          { [addId]: roster.roster_id },
          dropId ? { [dropId]: roster.roster_id } : {},
          { bid: faab ? bid : undefined, sequence },
        );
        return { ...preview, dry_run: false, transaction: describeOpenTransaction(ctx, bundle, tx, roster.roster_id) };
      }),
  );

  server.registerTool(
    "cancel_waiver_claim",
    {
      title: "Cancel a pending waiver claim",
      description: `Withdraw one of your queued waiver claims. ${WRITE_NOTE}`,
      inputSchema: { league_id: leagueIdSchema, transaction_id: transactionIdSchema, week: weekSchema.describe("Week the claim belongs to (default: looked up, else current week)."), dry_run: dryRunSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ league_id, transaction_id, week, dry_run }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        await ctx.players.ensureLoaded();
        const { tx, leg } = await locateTransaction(ctx, auth, bundle, transaction_id, week);
        if (tx && tx.type !== "waiver") throw new ToolError(`Transaction ${transaction_id} is a ${tx.type}, not a waiver claim.`);
        if (dry_run) return { dry_run: true, would_cancel: tx ? describeOpenTransaction(ctx, bundle, tx, null) : { transaction_id, week: leg }, note: "Nothing sent." };
        const result = await auth.cancelWaiverClaim(bundle.league.league_id, transaction_id, leg);
        return { dry_run: false, transaction: describeOpenTransaction(ctx, bundle, result, null) };
      }),
  );

  // ---------------------------------------------------------------------------
  // Trades
  // ---------------------------------------------------------------------------

  server.registerTool(
    "propose_trade",
    {
      title: "Propose a trade",
      description: `Send a trade offer to another team: give players from your roster, receive players from theirs. To counter an offer you received, pass counter_transaction_id (it is rejected and replaced in one step). Draft picks and FAAB are not supported yet. ${WRITE_NOTE}`,
      inputSchema: {
        league_id: leagueIdSchema,
        roster_id: ownRosterSchema,
        partner: z.string().trim().min(1).describe("The other manager: username, display name, team name, or roster_id."),
        give: playerListSchema.default([]).describe("Players you send."),
        receive: playerListSchema.default([]).describe("Players you get."),
        counter_transaction_id: transactionIdSchema.optional().describe("Offer you received that this proposal replaces."),
        dry_run: dryRunSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ league_id, roster_id, partner, give, receive, counter_transaction_id, dry_run }) =>
      guard(async () => {
        if (!give.length && !receive.length) throw new ToolError("A trade needs at least one player in give or receive.");
        const bundle = await loadLeague(ctx, league_id);
        await ctx.players.ensureLoaded();
        const mine = await resolveOwnRoster(ctx, bundle, roster_id);
        const theirs = await resolvePartner(ctx, bundle, partner);
        if (theirs.roster_id === mine.roster_id) throw new ToolError("The trade partner is your own team.");
        const giveIds = give.map((p) => findOnRoster(ctx, mine, p, "your roster"));
        const receiveIds = receive.map((p) => findOnRoster(ctx, theirs, p, `${teamLabel(bundle.teams, theirs.roster_id)}'s roster`));
        const adds: Record<string, number> = {};
        const drops: Record<string, number> = {};
        for (const id of giveIds) {
          adds[id] = theirs.roster_id;
          drops[id] = mine.roster_id;
        }
        for (const id of receiveIds) {
          adds[id] = mine.roster_id;
          drops[id] = theirs.roster_id;
        }
        const preview: Record<string, unknown> = {
          league_id: bundle.league.league_id,
          from: teamLabel(bundle.teams, mine.roster_id),
          to: teamLabel(bundle.teams, theirs.roster_id),
          give: ctx.players.refs(giveIds),
          receive: ctx.players.refs(receiveIds),
          deadline_week: bundle.league.settings?.trade_deadline ?? null,
        };
        let counter: { leg: number } | null = null;
        if (counter_transaction_id) {
          const found = await locateTransaction(ctx, auth, bundle, counter_transaction_id, undefined);
          if (found.tx && found.tx.type !== "trade") throw new ToolError(`Transaction ${counter_transaction_id} is not a trade offer.`);
          counter = { leg: found.leg };
          preview.counters = counter_transaction_id;
        }
        if (dry_run) return { ...preview, dry_run: true, note: "Nothing sent." };
        const tx = await auth.proposeTrade(bundle.league.league_id, adds, drops, counter ? { rejectTransactionId: counter_transaction_id, rejectTransactionLeg: counter.leg } : {});
        return { ...preview, dry_run: false, transaction: describeOpenTransaction(ctx, bundle, tx, mine.roster_id) };
      }),
  );

  server.registerTool(
    "respond_to_trade",
    {
      title: "Accept, reject or cancel a trade",
      description: `Accept or reject an offer you received, or cancel one you sent (Sleeper treats cancel as reject by the proposer). Accepted trades still go through the league's review/veto period. ${WRITE_NOTE}`,
      inputSchema: {
        league_id: leagueIdSchema,
        transaction_id: transactionIdSchema,
        action: z.enum(["accept", "reject", "cancel"]),
        week: weekSchema.describe("Week the offer belongs to (default: looked up, else current week)."),
        dry_run: dryRunSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ league_id, transaction_id, action, week, dry_run }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        await ctx.players.ensureLoaded();
        const { tx, leg } = await locateTransaction(ctx, auth, bundle, transaction_id, week);
        if (tx && tx.type !== "trade") throw new ToolError(`Transaction ${transaction_id} is a ${tx.type}, not a trade.`);
        if (tx && FINISHED_TRANSACTION_STATUSES.has(tx.status)) throw new ToolError(`Trade ${transaction_id} is already ${tx.status}.`);
        const target = tx ? describeOpenTransaction(ctx, bundle, tx, null) : { transaction_id, week: leg };
        if (dry_run) return { dry_run: true, action, trade: target, note: "Nothing sent." };
        const result = action === "accept" ? await auth.acceptTrade(bundle.league.league_id, transaction_id, leg) : await auth.rejectTrade(bundle.league.league_id, transaction_id, leg);
        invalidateLeague(ctx, bundle.league.league_id, leg);
        return { dry_run: false, action, transaction: describeOpenTransaction(ctx, bundle, result, null) };
      }),
  );

  // ---------------------------------------------------------------------------
  // League chat
  // ---------------------------------------------------------------------------

  server.registerTool(
    "post_league_message",
    {
      title: "Post in league chat",
      description: `Send a message to the league chat as the logged-in manager (e.g. a trade pitch). Visible to every manager. ${WRITE_NOTE}`,
      inputSchema: { league_id: leagueIdSchema, text: z.string().trim().min(1).max(2000), dry_run: dryRunSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ league_id, text, dry_run }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        if (dry_run) return { dry_run: true, league: bundle.league.name, text, note: "Nothing sent." };
        const message = await auth.postLeagueMessage(bundle.league.league_id, text);
        return { dry_run: false, league: bundle.league.name, message_id: message.message_id, text: message.text ?? text, posted: isoDate(message.created) };
      }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The roster the session user owns in this league (or an explicit roster_id, e.g. for commissioners),
 * refreshed from Sleeper's live store so a move made seconds ago is already reflected.
 */
export async function resolveOwnRoster(ctx: ServerContext, bundle: LeagueBundle, rosterId: number | undefined): Promise<Roster> {
  return freshenRoster(ctx, bundle, await pickOwnRoster(ctx, bundle, rosterId));
}

async function pickOwnRoster(ctx: ServerContext, bundle: LeagueBundle, rosterId: number | undefined): Promise<Roster> {
  if (rosterId !== undefined) return resolveRoster(ctx, bundle, { roster_id: rosterId });
  const userId = ctx.auth?.userId;
  if (userId) {
    const own = bundle.rosters.find((r) => r.owner_id === userId || r.co_owners?.includes(userId));
    if (own) return own;
    if (!ctx.defaultUser) throw new ToolError(`The logged-in Sleeper account (${userId}) does not own a team in league "${bundle.league.name}".`);
  }
  if (!ctx.defaultUser) throw new ToolError("Could not tell which team is yours: pass roster_id or start the server with --user / SLEEPER_USERNAME.");
  return resolveRoster(ctx, bundle, {});
}

/**
 * Overlay Sleeper's live view of a roster (players, starters, IR, taxi) on the public-API copy, which trails a
 * write by a minute or two. Best effort: without a session, or if the read fails, the public copy is used as is.
 */
export async function freshenRoster(ctx: ServerContext, bundle: LeagueBundle, roster: Roster): Promise<Roster> {
  if (!ctx.auth) return roster;
  let live: GqlRoster | undefined;
  try {
    live = (await ctx.auth.rosters(bundle.league.league_id)).find((r) => r.roster_id === roster.roster_id);
  } catch (err) {
    ctx.log(`live roster read failed, using the public copy: ${(err as Error).message}`);
    return roster;
  }
  if (!live) return roster;
  const fresh: Roster = {
    ...roster,
    players: live.players ?? roster.players,
    starters: live.starters ?? roster.starters,
    reserve: live.reserve ?? null,
    taxi: live.taxi ?? null,
  };
  const index = bundle.rosters.findIndex((r) => r.roster_id === roster.roster_id);
  if (index >= 0) bundle.rosters[index] = fresh;
  return fresh;
}

async function resolvePartner(ctx: ServerContext, bundle: LeagueBundle, partner: string): Promise<Roster> {
  const trimmed = partner.trim();
  if (/^\d{1,3}$/.test(trimmed)) return resolveRoster(ctx, bundle, { roster_id: Number(trimmed) });
  try {
    return await resolveRoster(ctx, bundle, { username: trimmed });
  } catch {
    return resolveRoster(ctx, bundle, { team_name: trimmed });
  }
}

const DEF_SUFFIX = /\s+(def|dst|d\/st|defense)$/i;

/** Resolve a name or player_id to a player on the given roster (IR and taxi included). */
export function findOnRoster(ctx: ServerContext, roster: Roster, input: string, where = "this roster"): string {
  const ids = roster.players ?? [];
  const raw = input.trim();
  if (ids.includes(raw)) return raw;
  if (ids.includes(raw.toUpperCase())) return raw.toUpperCase();
  const q = normalizeName(raw.replace(DEF_SUFFIX, ""));
  if (!q) throw new ToolError(`Empty player name.`);
  const names = ids.map((id) => ({ id, name: normalizeName(ctx.players.ref(id).name) }));
  const exact = names.filter((n) => n.name === q);
  if (exact.length === 1) return exact[0]!.id;
  const partial = names.filter((n) => n.name.includes(q) || (ctx.players.raw(n.id)?.last_name && normalizeName(ctx.players.raw(n.id)!.last_name!) === q));
  if (partial.length === 1) return partial[0]!.id;
  if (partial.length > 1) throw new ToolError(`"${raw}" matches several players on ${where}: ${partial.map((p) => ctx.players.label(p.id)).join("; ")}. Use the player_id.`);
  throw new ToolError(`"${raw}" is not on ${where}. Players: ${ids.map((id) => ctx.players.label(id)).join("; ")}.`);
}

/** Resolve a free agent by name or id and make sure nobody in the league rosters them. */
async function resolveFreeAgent(ctx: ServerContext, bundle: LeagueBundle, input: string): Promise<string> {
  const id = resolveAnyPlayer(ctx, input);
  const owner = bundle.rosters.find((r) => r.players?.includes(id));
  if (owner) throw new ToolError(`${ctx.players.label(id)} is already rostered by ${teamLabel(bundle.teams, owner.roster_id)}.`);
  return id;
}

export function resolveAnyPlayer(ctx: ServerContext, input: string): string {
  const raw = input.trim();
  if (ctx.players.raw(raw)) return raw;
  if (/^[a-z]{2,3}$/i.test(raw) && ctx.players.raw(raw.toUpperCase())) return raw.toUpperCase();
  const query = raw.replace(DEF_SUFFIX, "");
  const results = ctx.players.search(query, { activeOnly: true, limit: 6 });
  if (!results.length) throw new ToolError(`No active player matches "${raw}". Use search_players to find the exact name or player_id.`);
  const q = normalizeName(query);
  const exact = results.filter((p) => normalizeName(playerFullName(p)) === q);
  if (exact.length === 1) return exact[0]!.player_id;
  if (results.length === 1) return results[0]!.player_id;
  throw new ToolError(`"${raw}" is ambiguous: ${results.map((p) => ctx.players.label(p.player_id)).join("; ")}. Pass the player_id.`);
}

function positionsOf(ctx: ServerContext, id: string): string[] {
  const ref = ctx.players.ref(id);
  const raw = ctx.players.raw(id);
  const set = new Set<string>([...(raw?.fantasy_positions ?? []), ...(ref.pos ? [ref.pos] : [])]);
  return [...set];
}

function eligible(ctx: ServerContext, id: string, slot: string): boolean {
  const allowed = SLOT_ELIGIBILITY[slot];
  if (!allowed) return true;
  return positionsOf(ctx, id).some((p) => allowed.includes(p));
}

interface LineupPlan {
  starters: string[];
  changes: string[];
}

interface LineupInput {
  moves?: { start: string; bench?: string; slot?: string }[];
  starters?: string[];
}

/** Compute the new starters array from moves or a full list, validating eligibility and roster membership. */
export function planLineup(ctx: ServerContext, bundle: LeagueBundle, roster: Roster, input: LineupInput): LineupPlan {
  const slots = startingSlots(bundle.league);
  const current = Array.from({ length: slots.length }, (_, i) => roster.starters?.[i] || "0");
  const next = [...current];
  const label = (id: string) => (id === "0" ? "(empty)" : ctx.players.label(id));

  if (input.starters) {
    if (input.starters.length !== slots.length) {
      throw new ToolError(`This league has ${slots.length} starting slots (${slots.join(", ")}) but ${input.starters.length} starters were given.`);
    }
    input.starters.forEach((p, i) => {
      next[i] = /^(0|empty|none|-)?$/i.test(p.trim()) ? "0" : findOnRoster(ctx, roster, p);
    });
  }

  for (const move of input.moves ?? []) {
    const inId = findOnRoster(ctx, roster, move.start);
    const inIdx = next.indexOf(inId);
    let outIdx: number;
    if (move.bench) {
      const outId = findOnRoster(ctx, roster, move.bench);
      outIdx = next.indexOf(outId);
      if (outIdx < 0) throw new ToolError(`${label(outId)} is not currently starting, so there is nothing to swap. Current starters: ${next.map((id, i) => `${slots[i]}: ${label(id)}`).join("; ")}.`);
    } else {
      const wanted = move.slot?.toUpperCase();
      outIdx = next.findIndex((id, i) => id === "0" && (wanted ? slots[i] === wanted : eligible(ctx, inId, slots[i]!)));
      if (outIdx < 0) {
        throw new ToolError(
          wanted
            ? `No empty ${wanted} slot. Say who to bench (bench: \"...\").`
            : `No empty slot ${label(inId)} can fill. Say who to bench (bench: \"...\"). Current starters: ${next.map((id, i) => `${slots[i]}: ${label(id)}`).join("; ")}.`,
        );
      }
    }
    if (inIdx === outIdx) continue;
    const displaced = next[outIdx]!;
    next[outIdx] = inId;
    if (inIdx >= 0) next[inIdx] = displaced; // swap slots when both were starting
  }

  const problems: string[] = [];
  const players = new Set(roster.players ?? []);
  const reserve = new Set(roster.reserve ?? []);
  const taxi = new Set(roster.taxi ?? []);
  const seen = new Map<string, number>();
  next.forEach((id, i) => {
    const slot = slots[i]!;
    if (id === "0") return;
    if (!players.has(id)) problems.push(`${label(id)} is not on this roster`);
    if (reserve.has(id)) problems.push(`${label(id)} is on IR (activate first with update_ir)`);
    if (taxi.has(id)) problems.push(`${label(id)} is on the taxi squad (promote first with update_taxi)`);
    if (!eligible(ctx, id, slot)) problems.push(`${label(id)} cannot start at ${slot} (eligible: ${SLOT_ELIGIBILITY[slot]?.join("/") ?? "any"})`);
    const dupe = seen.get(id);
    if (dupe !== undefined) problems.push(`${label(id)} appears twice (${slots[dupe]} and ${slot})`);
    seen.set(id, i);
  });
  if (problems.length) throw new ToolError(`Invalid lineup: ${problems.join("; ")}.`);

  const changes: string[] = [];
  next.forEach((id, i) => {
    if (id !== current[i]) changes.push(`${slots[i]}: ${label(current[i]!)} → ${label(id)}`);
  });
  return { starters: next, changes };
}

interface ListPlan {
  list: string[];
  /** New starters array when a moved player had to be benched first. */
  starters: string[] | null;
  changes: string[];
}

/** Shared add/remove logic for IR and taxi lists. */
export function planListChange(
  ctx: ServerContext,
  roster: Roster,
  currentList: string[],
  opts: { add: string[]; remove: string[]; capacity: number; label: string },
): ListPlan {
  const list = [...currentList];
  const changes: string[] = [];
  const startersNow = roster.starters ?? [];
  let starters: string[] | null = null;

  for (const p of opts.remove) {
    const id = findOnRoster(ctx, roster, p);
    const idx = list.indexOf(id);
    if (idx < 0) throw new ToolError(`${ctx.players.label(id)} is not on ${opts.label}.`);
    list.splice(idx, 1);
    changes.push(`${ctx.players.label(id)}: ${opts.label} → bench`);
  }
  for (const p of opts.add) {
    const id = findOnRoster(ctx, roster, p);
    if (list.includes(id)) throw new ToolError(`${ctx.players.label(id)} is already on ${opts.label}.`);
    const other = opts.label === "IR" ? roster.taxi ?? [] : roster.reserve ?? [];
    if (other.includes(id)) throw new ToolError(`${ctx.players.label(id)} is on ${opts.label === "IR" ? "the taxi squad" : "IR"}; remove them from there first.`);
    list.push(id);
    const slotIdx = startersNow.indexOf(id);
    if (slotIdx >= 0) {
      starters ??= [...startersNow];
      starters[slotIdx] = "0";
      changes.push(`${ctx.players.label(id)}: starter → ${opts.label} (slot left empty, fill it with set_lineup)`);
    } else {
      changes.push(`${ctx.players.label(id)}: bench → ${opts.label}`);
    }
  }
  if (opts.capacity && list.length > opts.capacity) {
    throw new ToolError(`${opts.label} holds ${opts.capacity} player(s); this would need ${list.length}: ${list.map((id) => ctx.players.label(id)).join("; ")}.`);
  }
  if (!changes.length) throw new ToolError("Nothing to change.");
  return { list, starters, changes };
}

/** Apply a roster change (or preview it) and answer with the resulting roster. */
async function commitRoster(
  ctx: ServerContext,
  bundle: LeagueBundle,
  roster: Roster,
  dryRun: boolean,
  changes: string[],
  patch: Partial<Pick<Roster, "starters" | "reserve" | "taxi" | "players">>,
  send: () => Promise<GqlRoster>,
) {
  const base = { league_id: bundle.league.league_id, team: teamLabel(bundle.teams, roster.roster_id), changes };
  if (dryRun) {
    const preview: Roster = { ...roster, ...stripUndefined(patch) };
    return { ...base, dry_run: true, note: "Nothing sent.", roster: describeRoster(ctx, bundle, preview, true) };
  }
  const updated = await send();
  invalidateLeague(ctx, bundle.league.league_id);
  const merged: Roster = {
    ...roster,
    players: updated.players ?? roster.players,
    starters: updated.starters ?? patch.starters ?? roster.starters,
    reserve: updated.reserve ?? patch.reserve ?? roster.reserve,
    taxi: updated.taxi ?? patch.taxi ?? roster.taxi,
  };
  return { ...base, dry_run: false, roster: describeRoster(ctx, bundle, merged, true) };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Drop cached public data that a write just made stale. */
function invalidateLeague(ctx: ServerContext, leagueId: string, week?: number | null): void {
  const id = encodeURIComponent(leagueId);
  ctx.client.cache.delete(`GET /league/${id}/rosters`);
  if (week) ctx.client.cache.delete(`GET /league/${id}/transactions/${week}`);
}

/** Find a transaction by id among the league's recent transactions to learn its week (leg). */
async function locateTransaction(
  ctx: ServerContext,
  auth: SleeperGraphqlClient,
  bundle: LeagueBundle,
  transactionId: string,
  week: number | undefined,
): Promise<{ tx: GqlTransaction | null; leg: number }> {
  const { week: current } = await resolveWeek(ctx, week);
  const legs = week !== undefined ? [week] : [current, Math.max(1, current - 1)];
  const list = await auth.transactions(bundle.league.league_id, { legs, limit: 300 });
  const tx = list.find((t) => t.transaction_id === transactionId) ?? null;
  return { tx, leg: tx?.leg ?? week ?? current };
}

function describeOpenTransaction(ctx: ServerContext, bundle: LeagueBundle, t: GqlTransaction, myRosterId: number | null) {
  const out = describeTransaction(ctx, bundle, t as unknown as Transaction) as Record<string, unknown>;
  out.created = isoDate(t.created);
  if (OPEN_TRANSACTION_STATUSES.has(t.status)) out.pending = true;
  if (t.type === "trade" && myRosterId !== null) {
    const creatorRoster = bundle.rosters.find((r) => r.owner_id === t.creator || r.co_owners?.includes(t.creator ?? ""));
    if (creatorRoster) out.direction = creatorRoster.roster_id === myRosterId ? "sent" : "received";
    const awaiting = (t.roster_ids ?? []).filter((id) => !(t.consenter_ids ?? []).includes(id));
    if (awaiting.length && OPEN_TRANSACTION_STATUSES.has(t.status)) out.awaiting = awaiting.map((id) => teamLabel(bundle.teams, id));
  }
  if (t.type === "waiver" && t.settings) {
    if (t.settings.seq !== undefined) out.sequence = t.settings.seq;
    if (t.settings.priority !== undefined) out.priority = t.settings.priority;
  }
  return out;
}
