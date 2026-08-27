import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRecipe, hasSolarChannel, readDraw } from "./index.js";

// ============================================================
// Fake RecipeContext harness
// ============================================================

interface ClaimReq {
  equipmentId: string;
  note?: string;
  onGranted: () => void;
  onRevoked: (reason: string) => void;
}

function makeCtx(opts?: {
  /** undefined => ctx.helpers.energy absent (no-arbiter core). */
  arbiterEnabled?: boolean;
  /** deniedReason to return from claimCapacity; otherwise a pending handle. */
  denied?: string;
  /** order bindings on the heater equipment (defaults to a solar channel). */
  orderBindings?: Array<{ alias: string; category?: string; type?: string }>;
  /** Issue #2 — expose a measured power channel on the heater. */
  metered?: boolean;
  /** Issue #2 — the initial measured draw in W. */
  draw?: number | null;
}) {
  const orders: Array<{ equipmentId: string; alias: string; value: unknown }> = [];
  const logs: string[] = [];
  const errors: Array<Record<string, unknown>> = [];
  let released = 0;
  let claimCount = 0;
  let lastClaim: ClaimReq | null = null;
  let granted = false;

  const orderBindings = opts?.orderBindings ?? [
    { alias: "solar", category: "solar_toggle", type: "boolean" },
  ];

  const energy =
    opts?.arbiterEnabled === undefined
      ? undefined
      : {
          getCapacityState: () => ({
            enabled: !!opts?.arbiterEnabled,
            availableSurplusW: 0,
            grants: [],
          }),
          claimCapacity: (req: ClaimReq) => {
            claimCount += 1;
            lastClaim = req;
            granted = false;
            return {
              id: "claim-1",
              // Track the granted state as the real arbiter does: a handle
              // stuck on "pending" after onGranted would let a test assert a
              // path the engine never takes.
              status: () =>
                opts?.denied ? "denied" : granted ? "granted" : "pending",
              deniedReason: opts?.denied,
              release: () => {
                released += 1;
                granted = false;
              },
            };
          },
        };

  // Issue #2 — the heater's own measured draw, driven by the test.
  let draw: number | null = opts?.draw ?? null;
  let drawAt: number | null = null;
  const ctx = {
    equipmentManager: {
      getByIdWithDetails: (_id: string) => ({ name: "Ballon", orderBindings }),
      // Absent when the test asks for a core (or a heater) with no measured
      // channel, which must keep the pre-issue-#2 behaviour exactly.
      ...(opts?.metered
        ? {
            getDataBindingsWithValues: (_id: string) =>
              draw === null
                ? []
                : [
                    {
                      alias: "power",
                      category: "power",
                      value: draw,
                      // Fresh by default; a test can age it with `setDrawAt`.
                      lastUpdated: new Date(drawAt ?? Date.now()).toISOString(),
                    },
                  ],
          }
        : {}),
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: (obj: Record<string, unknown>) => errors.push(obj),
      debug: () => {},
    },
    log: (message: string) => logs.push(message),
    helpers: { energy },
    dispatchOrder: (equipmentId: string, alias: string, value: unknown) => {
      orders.push({ equipmentId, alias, value });
      return Promise.resolve();
    },
  };

  return {
    ctx,
    orders,
    logs,
    errors,
    getReleased: () => released,
    getClaim: () => lastClaim,
    getClaimCount: () => claimCount,
    /** Issue #2 — move the measured draw under the recipe's feet. */
    setDraw: (w: number | null) => {
      draw = w;
      drawAt = null; // fresh again
    },
    /** Issue #2 — freeze the reading at a past instant, as a clamp that has
     *  dropped off the network does. */
    freezeDrawAt: (at: number) => {
      drawAt = at;
    },
    /** Grant the live claim the way the arbiter does: flip the handle's status
     *  AND fire the recipe's callback. */
    grant: () => {
      granted = true;
      lastClaim?.onGranted();
    },
    /** Revoke it the same way: the core returns the claim to "pending" and
     *  keeps the handle, so a test that only fires the callback would leave the
     *  handle reading "granted" and exercise a state the engine never has. */
    revoke: (reason: string) => {
      granted = false;
      lastClaim?.onRevoked(reason);
    },
  };
}

const HEATER = "wh-1";

describe("hasSolarChannel", () => {
  it("detects a solar channel by alias or category", () => {
    expect(hasSolarChannel([{ alias: "solar" }])).toBe(true);
    expect(hasSolarChannel([{ alias: "x", category: "solar_toggle" }])).toBe(true);
  });
  it("is false with only a main on/off", () => {
    expect(hasSolarChannel([{ alias: "state", category: "light_toggle" }])).toBe(false);
    expect(hasSolarChannel([])).toBe(false);
  });
});

describe("slots", () => {
  it("files instances under a room: first slot is a required zone slot", () => {
    const first = createRecipe().slots[0];
    expect(first.id).toBe("zone");
    expect(first.type).toBe("zone");
    expect(first.required).toBe(true);
  });
});

describe("validate", () => {
  const recipe = createRecipe();

  it("throws when no heater is selected", () => {
    const { ctx } = makeCtx({ arbiterEnabled: true });
    expect(() => recipe.validate({}, ctx as never)).toThrow(/select a water heater/i);
  });

  it("throws when the equipment has no solar channel", () => {
    const { ctx } = makeCtx({
      arbiterEnabled: true,
      orderBindings: [{ alias: "state", category: "light_toggle" }],
    });
    expect(() => recipe.validate({ heater: HEATER }, ctx as never)).toThrow(
      /no solar command channel/i,
    );
  });

  it("passes with a solar channel bound", () => {
    const { ctx } = makeCtx({ arbiterEnabled: true });
    expect(() => recipe.validate({ heater: HEATER }, ctx as never)).not.toThrow();
  });
});

describe("createInstance — surplus lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("claims on start when the arbiter is enabled, and heats on grant", () => {
    const h = makeCtx({ arbiterEnabled: true });
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);

    expect(h.getClaim()).not.toBeNull();
    expect(h.getClaim()!.equipmentId).toBe(HEATER);
    expect(h.orders).toHaveLength(0); // nothing until a grant

    h.getClaim()!.onGranted();
    expect(h.orders).toEqual([{ equipmentId: HEATER, alias: "solar", value: "ON" }]);

    inst.stop();
  });

  it("opens the contact on a surplus-deficit revoke", () => {
    const h = makeCtx({ arbiterEnabled: true });
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);

    h.getClaim()!.onGranted();
    h.getClaim()!.onRevoked("surplus-deficit");

    expect(h.orders.map((o) => o.value)).toEqual(["ON", "OFF"]);
    inst.stop();
  });

  it("does NOT fight a manual override (human wins)", () => {
    const h = makeCtx({ arbiterEnabled: true });
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);

    h.getClaim()!.onGranted();
    h.orders.length = 0;
    h.getClaim()!.onRevoked("manual-override");

    expect(h.orders).toHaveLength(0); // no OFF dispatched
    inst.stop();
  });

  it("releases the claim and opens the contact on stop", () => {
    const h = makeCtx({ arbiterEnabled: true });
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);
    h.orders.length = 0;

    inst.stop();

    expect(h.getReleased()).toBe(1);
    expect(h.orders).toEqual([{ equipmentId: HEATER, alias: "solar", value: "OFF" }]);
  });

  it("stays inert with no arbiter (no claim, no order, logs the fallback)", () => {
    const h = makeCtx({}); // energy helper absent
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);

    expect(h.getClaim()).toBeNull();
    expect(h.orders).toHaveLength(0);
    expect(h.logs.some((l) => /inert/i.test(l))).toBe(true);
    inst.stop();
  });

  it("does not keep a denied claim, and retries on the next tick", () => {
    const h = makeCtx({ arbiterEnabled: true, denied: "not-profiled" });
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);

    // Denied at start: warned once, no ON order, claimed once.
    expect(h.logs.some((l) => /not-profiled/i.test(l))).toBe(true);
    expect(h.orders).toHaveLength(0);
    expect(h.getClaimCount()).toBe(1);

    // A denied claim is not retained; the 60s tick re-attempts.
    const before = h.logs.length;
    vi.advanceTimersByTime(60_000);
    expect(h.getClaimCount()).toBe(2); // re-attempted
    // Same denial reason is not re-logged (no spam).
    expect(h.logs.length).toBe(before);

    inst.stop();
  });
});

// ============================================================
// Issue #2 — release the claim once the tank is hot
// ============================================================

describe("createInstance — releasing a reservation nothing consumes (#2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const HOUR = 3600_000;
  const MIN = 60_000;

  it("releases and opens the contact after 30 min of measured idle", () => {
    const h = makeCtx({ arbiterEnabled: true, metered: true, draw: 2000 });
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);
    h.grant();
    expect(h.orders.map((o) => o.value)).toEqual(["ON"]);

    // Heating for a while: the reservation is earning its keep.
    vi.advanceTimersByTime(20 * MIN);
    expect(h.getReleased()).toBe(0);

    // The thermostat cuts off.
    h.setDraw(0);
    vi.advanceTimersByTime(29 * MIN);
    expect(h.getReleased()).toBe(0); // not yet: the window has not elapsed

    vi.advanceTimersByTime(2 * MIN);
    expect(h.getReleased()).toBe(1);
    expect(h.orders.map((o) => o.value)).toEqual(["ON", "OFF"]);
    inst.stop();
  });

  it("does not release on a thermostat blip shorter than the window", () => {
    const h = makeCtx({ arbiterEnabled: true, metered: true, draw: 2000 });
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);
    h.grant();

    h.setDraw(0);
    vi.advanceTimersByTime(10 * MIN);
    h.setDraw(2000); // back on: the clock restarts from zero
    vi.advanceTimersByTime(10 * MIN);
    h.setDraw(0);
    vi.advanceTimersByTime(25 * MIN);

    expect(h.getReleased()).toBe(0);
    inst.stop();
  });

  it("waits out the cooldown before claiming again", () => {
    const h = makeCtx({ arbiterEnabled: true, metered: true, draw: 0 });
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);
    h.grant();
    const claimsBefore = h.getClaimCount();

    vi.advanceTimersByTime(31 * MIN);
    expect(h.getReleased()).toBe(1);

    // The 60 s reclaim tick must not immediately take the surplus back.
    vi.advanceTimersByTime(30 * MIN);
    expect(h.getClaimCount()).toBe(claimsBefore);

    // Once the cooling-off has passed, it claims again.
    vi.advanceTimersByTime(31 * MIN);
    expect(h.getClaimCount()).toBeGreaterThan(claimsBefore);
    inst.stop();
  });

  it("never releases a heater with no measured power channel", () => {
    // The pre-#2 behaviour, and the reason silence is not read as "hot": a
    // permanent claim on a load the recipe cannot observe.
    const h = makeCtx({ arbiterEnabled: true });
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);
    h.grant();

    vi.advanceTimersByTime(4 * HOUR);

    expect(h.getReleased()).toBe(0);
    expect(h.orders.map((o) => o.value)).toEqual(["ON"]);
    inst.stop();
  });

  it("never releases on a claim that was never granted", () => {
    const h = makeCtx({ arbiterEnabled: true, metered: true, draw: 0 });
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);
    // Nothing is reserved on our account to give back, and a load that was
    // never asked to heat is not "hot".
    vi.advanceTimersByTime(2 * HOUR);

    expect(h.getReleased()).toBe(0);
    inst.stop();
  });

  it("restarts the countdown after a revoke and a re-grant", () => {
    // Idle time accumulated under a previous grant must not carry over: the
    // tank may well have been drawn down in between, and the arbiter drops its
    // own view of the load on every revoke too.
    const h = makeCtx({ arbiterEnabled: true, metered: true, draw: 0 });
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);
    h.grant();
    vi.advanceTimersByTime(20 * MIN);
    expect(h.getReleased()).toBe(0);

    h.revoke("surplus-deficit");
    h.grant();

    // 20 more minutes: 40 in total, but only 20 under this grant.
    vi.advanceTimersByTime(20 * MIN);
    expect(h.getReleased()).toBe(0);

    vi.advanceTimersByTime(12 * MIN);
    expect(h.getReleased()).toBe(1);
    inst.stop();
  });

  it("does not start a countdown after a manual-override revoke", () => {
    // That path deliberately leaves the contact as the human set it and never
    // dispatches, so the guard that clears the countdown is the claim status.
    const h = makeCtx({ arbiterEnabled: true, metered: true, draw: 0 });
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);
    h.grant();
    h.revoke("manual-override");

    vi.advanceTimersByTime(2 * HOUR);
    expect(h.getReleased()).toBe(0);
    inst.stop();
  });

  it("treats a reading that has gone quiet as unknown, not as idle", () => {
    // A clamp that drops off the network freezes its last value. Reading that
    // frozen zero as "hot" would open the contact on a cold tank and lock the
    // recipe out for an hour.
    const h = makeCtx({ arbiterEnabled: true, metered: true, draw: 0 });
    const inst = createRecipe().createInstance({ heater: HEATER }, h.ctx as never);
    h.grant();
    h.freezeDrawAt(Date.now() - 10 * MIN);

    vi.advanceTimersByTime(2 * HOUR);

    expect(h.getReleased()).toBe(0);
    inst.stop();
  });
});

describe("readDraw (#2)", () => {
  const fresh = (value: unknown, alias = "power", category = "power") => [
    { alias, category, value, lastUpdated: new Date().toISOString() },
  ];

  it("returns a live numeric reading", () => {
    expect(readDraw(fresh(2000))).toBe(2000);
    expect(readDraw(fresh(0))).toBe(0);
  });

  it("reads a category `power` channel whatever it is aliased", () => {
    expect(readDraw(fresh(2000, "puissance"))).toBe(2000);
  });

  it("falls back to the alias when no category says power", () => {
    expect(readDraw(fresh(2000, "power", "generic"))).toBe(2000);
  });

  it("returns null for anything that is not a number", () => {
    // Each of these is a real shape: a binding whose device never published
    // carries null, and a cloud switch reports its on/off state under `power`.
    for (const v of [null, undefined, "", "2000", false, true, [], {}, NaN]) {
      expect(readDraw(fresh(v))).toBeNull();
    }
  });

  it("returns null with no power channel at all", () => {
    expect(readDraw([{ alias: "state", category: "light_state", value: 1 }])).toBeNull();
    expect(readDraw([])).toBeNull();
    expect(readDraw(undefined)).toBeNull();
  });

  it("returns null for a reading with no timestamp or a stale one", () => {
    expect(readDraw([{ alias: "power", category: "power", value: 0 }])).toBeNull();
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(
      readDraw([{ alias: "power", category: "power", value: 0, lastUpdated: old }]),
    ).toBeNull();
  });

  it("keeps a negative reading (a bidirectional clamp) rather than dropping it", () => {
    expect(readDraw(fresh(-30))).toBe(-30);
  });
});
