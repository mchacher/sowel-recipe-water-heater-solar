import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRecipe, hasSolarChannel } from "./index.js";

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
}) {
  const orders: Array<{ equipmentId: string; alias: string; value: unknown }> = [];
  const logs: string[] = [];
  const errors: Array<Record<string, unknown>> = [];
  let released = 0;
  let claimCount = 0;
  let lastClaim: ClaimReq | null = null;

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
            return {
              id: "claim-1",
              status: () => (opts?.denied ? "denied" : "pending"),
              deniedReason: opts?.denied,
              release: () => {
                released += 1;
              },
            };
          },
        };

  const ctx = {
    equipmentManager: {
      getByIdWithDetails: (_id: string) => ({ name: "Ballon", orderBindings }),
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
