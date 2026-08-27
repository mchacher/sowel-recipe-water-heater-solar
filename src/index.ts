// ============================================================
// Water Heater Solar — external recipe package
//
// Drives a water heater's DEDICATED solar contact (the "solar" command
// channel, spec 152) from solar surplus, coordinated by the energy capacity
// arbiter (spec 140). Single responsibility:
//
//   arbiter grants capacity  → close the solar contact (heat on free solar)
//   arbiter revokes it       → open it (except on a manual override: the human wins)
//
// It is surplus-ONLY on purpose. The off-peak / guaranteed hot-water baseline
// is owned by the appliance's own internal programming (e.g. an Atlantic
// Calypso's ECO plage de chauffe), not by this recipe. Sowel is deliberately
// blind to the tank temperature here (the Calypso is driven through a dry
// contact, not reported to Sowel): "don't heat if already hot" is guaranteed by
// the appliance's own thermostat, not by a Sowel condition.
//
// Fallback (arbiter author rule 1): with no arbiter, arbiter disabled, or no PV
// production, the recipe stays inert — the appliance's own programming keeps
// the water hot. Surplus is a bonus, never the plan.
// ============================================================

// Minimal types, mirrored from src/shared/types.ts (recipes never import core).
interface OrderBindingLite {
  alias: string;
  category?: string;
  type?: string;
}

// Spec 140 capacity-arbiter helpers, mirrored from core. Optional at the call
// site: absent on cores < the arbiter, or when the home has no production.
interface CapacityClaimReq {
  equipmentId: string;
  watts?: number;
  toleratedImportW?: number;
  slack?: "none" | "some" | "high";
  note?: string;
  onGranted: () => void;
  onRevoked: (reason: string) => void;
}
interface CapacityHandle {
  id: string;
  status(): "pending" | "granted" | "denied" | "released";
  deniedReason?: string;
  release(): void;
}
interface EnergyHelpers {
  claimCapacity(req: CapacityClaimReq): CapacityHandle;
  getCapacityState(): {
    enabled: boolean;
    availableSurplusW: number | null;
    grants: Array<{ equipmentId: string; watts: number; sinceIso: string }>;
  };
}

interface RecipeContext {
  equipmentManager: {
    getByIdWithDetails(id: string): {
      name: string;
      orderBindings: OrderBindingLite[];
    } | null;
    /** Issue #2 — the load's own measured channels. Optional: a core without
     *  it, or a heater with no power binding, simply never releases early.
     *  `category` and `lastUpdated` are mirrored too and both matter: the core
     *  resolves a measurement by category first, and a reading with no freshness
     *  is a reading you cannot call idle. */
    getDataBindingsWithValues?(id: string): {
      alias: string;
      category?: string;
      value: unknown;
      lastUpdated?: string | null;
    }[];
  };
  logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
    debug(obj: Record<string, unknown>, msg?: string): void;
  };
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: {
    // Spec 140. Absent on older cores / no-production homes — the recipe then
    // stays inert (the appliance's own programming keeps the water hot).
    energy?: EnergyHelpers;
  };
  dispatchOrder(equipmentId: string, alias: string, value: unknown): Promise<void>;
}

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type:
    | "zone"
    | "equipment"
    | "number"
    | "duration"
    | "time"
    | "boolean"
    | "text"
    | "data-key";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
    crossZone?: boolean;
  };
  group?: string;
}
interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, { name: string; description: string }>;
}
interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(params: Record<string, unknown>, ctx: RecipeContext): { stop(): void };
}

// ============================================================
// Constants + pure helpers (exported for tests)
// ============================================================

const SOLAR_ALIAS = "solar";
/** Cadence at which the recipe re-attempts a claim while it holds none (e.g.
 * the arbiter was disabled at start, or the equipment had no energy profile
 * yet). Cheap: it only reads arbiter state, never the grid meter. */
const RECLAIM_INTERVAL_MS = 60_000;

/** Issue #2 — how long the heater's own measurement must sit at essentially
 *  zero, under a grant with the contact closed, before the claim is released.
 *  Long enough not to trip on a thermostat cycling mid-heat, short enough to
 *  free most of an afternoon. */
const IDLE_RELEASE_MS = 30 * 60_000;
/** Below this draw the appliance is taken as not heating. A resistive tank
 *  draws its full rating or nothing, so this only has to clear meter noise. */
const IDLE_POWER_W = 20;
/** After releasing because the tank is hot, wait before claiming again.
 *  Without it the next tick re-claims, the contact closes, the thermostat is
 *  still satisfied, and the grant churns every half hour.
 *
 *  It DOUBLES on each consecutive hot release, capped, and resets the moment
 *  the heater is observed drawing again. A flat cooldown would settle into a
 *  permanent 60-min-free / 30-min-reserved cycle on a tank that is hot for the
 *  afternoon, and each re-claim can preempt whatever lower-priority load took
 *  the freed surplus, only to hand it back half an hour later. Doubling
 *  converges to about one probe per afternoon; the reset means a tank drained
 *  by a shower is back to a one-hour wait, not a four-hour one. */
const HOT_RECLAIM_COOLDOWN_MS = 60 * 60_000;
const HOT_RECLAIM_COOLDOWN_MAX_MS = 4 * 60 * 60_000;

/** How old a reading may be and still count as a measurement. Mirrors the
 *  core's own `LIVE_DRAW_FRESH_MS`: past it the value is the last thing the
 *  device said, not what it is doing. */
const DRAW_FRESH_MS = 120_000;

/**
 * The heater's own measured draw in W, or `null` for "unknown".
 *
 * Null is the important half. Anything that is not a live number has to read
 * unknown, never idle, because idle is what makes this recipe give the surplus
 * back and open the contact:
 *
 * - a binding whose device has never published carries `value: null`, and
 *   `Number(null)` is 0. A freshly paired clamp would read as a hot tank;
 * - a cloud-API load reports its on/off state under the alias `power`, so a
 *   boolean would read 0 or 1, both below the idle threshold;
 * - a clamp that drops off the network freezes its last value. This
 *   installation's clamps needed a 60 s reporting interval precisely because
 *   they go quiet on a stable load.
 *
 * Category is preferred over alias, as the core does: a wattmeter aliased
 * `puissance` but categorised `power` is still a measurement.
 */
export function readDraw(
  bindings:
    | readonly {
        alias: string;
        category?: string;
        value: unknown;
        lastUpdated?: string | null;
      }[]
    | undefined,
  now: number = Date.now(),
): number | null {
  const b =
    bindings?.find((x) => x.category === "power") ??
    bindings?.find((x) => x.alias === "power");
  if (!b) return null;
  if (typeof b.value !== "number" || !Number.isFinite(b.value)) return null;
  if (!b.lastUpdated) return null;
  const at = Date.parse(b.lastUpdated);
  if (!Number.isFinite(at) || now - at > DRAW_FRESH_MS) return null;
  return b.value;
}

/** True when the equipment exposes a solar command channel (spec 152): an order
 * binding aliased `solar` or tagged `solar_toggle`. */
export function hasSolarChannel(orderBindings: readonly OrderBindingLite[]): boolean {
  return orderBindings.some(
    (ob) => ob.alias === SOLAR_ALIAS || ob.category === "solar_toggle",
  );
}

// ============================================================
// Recipe factory
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "water-heater-solar",
    name: "Water Heater on Solar Surplus",
    description:
      "Heats your water heater on solar surplus through its dedicated solar contact, coordinated by the energy arbiter.",
    slots: [
      {
        // Convention: the room the automation is filed under. The UI files each
        // instance in this zone; without it the instance is shown in no room.
        id: "zone",
        name: "Room",
        description: "The room this automation is filed under.",
        type: "zone",
        required: true,
      },
      {
        id: "heater",
        name: "Water heater",
        description:
          "The water heater (or switch) whose dedicated solar contact is closed on surplus.",
        type: "equipment",
        required: true,
        constraints: { equipmentType: ["water_heater", "switch"], crossZone: true },
      },
    ],
    i18n: {
      fr: {
        name: "Chauffe-eau sur surplus solaire",
        description:
          "Chauffe le chauffe-eau sur le surplus solaire via son contact solaire dédié, coordonné par l'arbitre d'énergie.",
        slots: {
          zone: {
            name: "Pièce",
            description: "La pièce sous laquelle l'automatisation est classée.",
          },
          heater: {
            name: "Chauffe-eau",
            description:
              "Le chauffe-eau (ou l'interrupteur) dont le contact solaire dédié est fermé sur le surplus.",
          },
        },
      },
    },

    validate(params, ctx) {
      const id = params.heater;
      if (typeof id !== "string" || !id) {
        throw new Error("Select a water heater.");
      }
      const eq = ctx.equipmentManager.getByIdWithDetails(id);
      if (!eq) {
        throw new Error("The selected water heater does not exist.");
      }
      if (!hasSolarChannel(eq.orderBindings)) {
        throw new Error(
          'This equipment has no solar command channel. Bind a solar contact (alias "solar") on it first.',
        );
      }
    },

    createInstance(params, ctx) {
      const heaterId = params.heater as string;
      const heaterName = ctx.equipmentManager.getByIdWithDetails(heaterId)?.name ?? heaterId;

      let stopped = false;
      let claim: CapacityHandle | null = null;
      let lastDenied: string | null = null;
      /** Issue #2 — since when the heater has been measured idle under a grant
       *  with the contact closed. Null = drawing, or nothing measured yet. */
      let idleSince: number | null = null;
      /** Issue #2 — do not claim again before this instant, after a release
       *  for a hot tank. */
      let holdOffUntil = 0;
      /** Issue #2 — the cooldown to apply on the next hot release; doubles per
       *  consecutive release, resets as soon as the heater draws again. */
      let hotCooldownMs = HOT_RECLAIM_COOLDOWN_MS;
      /** Whether the recipe currently has the solar contact closed. */
      let contactClosed = false;

      const dispatchSolar = (on: boolean): void => {
        const previous = contactClosed;
        contactClosed = on;
        if (!on) idleSince = null;
        ctx.dispatchOrder(heaterId, SOLAR_ALIAS, on ? "ON" : "OFF").catch((err: unknown) => {
          // The order never left: put the belief back rather than carry a
          // contact we think is open while it is closed, which after a release
          // leaves no claim behind to notice the load still drawing.
          contactClosed = previous;
          ctx.log(
            `Solar order failed: ${err instanceof Error ? err.message : String(err)}`,
            "warn",
          );
        });
      };

      const arbiterEnabled = (): boolean => {
        try {
          return !!ctx.helpers.energy && ctx.helpers.energy.getCapacityState().enabled;
        } catch {
          return false;
        }
      };

      // Hold a single, persistent claim: the water heater always wants free
      // surplus. The arbiter grants when surplus is available at this load's
      // priority and revokes when it is not; the claim stays pending in between
      // and is re-granted on the next surplus. We only (re)claim while holding
      // none — never spamming the arbiter with duplicate claims.
      const ensureClaim = (): void => {
        if (stopped || claim) return;
        // Issue #2 — cooling-off after a release for a hot tank.
        if (Date.now() < holdOffUntil) return;
        const energy = ctx.helpers.energy;
        if (!energy || !arbiterEnabled()) return; // inert — the appliance's own programming assures
        try {
          const handle = energy.claimCapacity({
            equipmentId: heaterId,
            note: "water heater on solar surplus",
            onGranted: () => {
              if (stopped) return;
              ctx.log(`Solar surplus granted -> heating ${heaterName}`);
              dispatchSolar(true);
            },
            onRevoked: (reason: string) => {
              if (stopped) return;
              // Manual override: the human touched the contact. Do not fight it.
              if (reason === "manual-override") {
                ctx.log(`Manual override on ${heaterName} -> leaving the solar contact as set`);
                return;
              }
              ctx.log(`Solar surplus revoked (${reason}) -> releasing ${heaterName}`);
              dispatchSolar(false);
            },
          });
          if (handle && handle.status() === "denied") {
            const reason = handle.deniedReason ?? "denied";
            // Log a denial only when the reason changes, so a misconfiguration
            // (e.g. no energy profile yet) does not spam the log every tick.
            if (reason !== lastDenied) {
              ctx.log(`Cannot claim solar capacity for ${heaterName}: ${reason}`, "warn");
              lastDenied = reason;
            }
            claim = null; // retry next tick (recovers once the profile is set / arbiter enabled)
            return;
          }
          lastDenied = null;
          claim = handle ?? null;
        } catch (err) {
          ctx.logger.error({ err }, "water-heater-solar: claimCapacity failed");
          claim = null;
        }
      };

      // Start.
      ensureClaim();
      if (!arbiterEnabled()) {
        ctx.log(
          "Energy arbiter unavailable or disabled -> solar heating inert; the water heater's own off-peak programming keeps water hot.",
        );
      }
      /**
       * Issue #2 — stop reserving surplus the appliance is not taking.
       *
       * The claim was permanent by design, which is right while the tank heats
       * and wrong once its thermostat has cut off: the arbiter keeps reserving
       * the heater's watts, and that surplus goes neither to the water heater
       * nor to any lower-priority load. On a sunny afternoon the tank is hot
       * early and the reservation stands for the rest of the day.
       *
       * The recipe stays blind to the tank temperature, as the header says: the
       * appliance is driven through a dry contact and reports nothing. It reads
       * the load's own MEASURED draw instead, which is a different question and
       * the one the reservation should actually follow. Reserving watts for a
       * load that is not taking them is the waste, whatever the reason.
       *
       * A heater with no power channel keeps today's behaviour exactly: no
       * measurement, no release. Silence is never read as "hot".
       */
      const watchIdle = (): void => {
        if (!claim || claim.status() !== "granted" || !contactClosed) {
          idleSince = null;
          return;
        }
        const draw = readDraw(
          ctx.equipmentManager.getDataBindingsWithValues?.(heaterId),
        );
        if (draw === null) return; // unknown, never idle
        if (draw >= IDLE_POWER_W) {
          idleSince = null;
          hotCooldownMs = HOT_RECLAIM_COOLDOWN_MS; // it heats again: start over
          return;
        }
        const now = Date.now();
        if (idleSince === null) {
          idleSince = now;
          return;
        }
        if (now - idleSince < IDLE_RELEASE_MS) return;

        ctx.log(
          `${heaterName} ne consomme plus depuis ${Math.round(IDLE_RELEASE_MS / 60_000)} min -> surplus rendu à l'arbitre`,
        );
        try {
          claim.release();
        } catch {
          /* a broken handle must not break the tick */
        }
        claim = null;
        idleSince = null;
        holdOffUntil = Date.now() + hotCooldownMs;
        hotCooldownMs = Math.min(hotCooldownMs * 2, HOT_RECLAIM_COOLDOWN_MAX_MS);
        // Open the contact with the claim: leaving it closed would let the tank
        // draw on its own later with no grant behind it, which the arbiter
        // would rightly read as an unmanaged run.
        dispatchSolar(false);
      };

      const timer = setInterval(() => {
        try {
          if (stopped) return;
          watchIdle();
          ensureClaim();
        } catch (err) {
          ctx.logger.error({ err }, "water-heater-solar: tick failed");
        }
      }, RECLAIM_INTERVAL_MS);

      return {
        stop() {
          stopped = true;
          clearInterval(timer);
          try {
            claim?.release();
          } catch {
            /* a broken handle must not break stop() */
          }
          claim = null;
          // Open the contact on shutdown: the appliance falls back to its own
          // internal programming rather than staying forced on solar.
          dispatchSolar(false);
        },
      };
    },
  };
}
