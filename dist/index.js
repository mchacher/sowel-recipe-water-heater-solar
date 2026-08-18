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
// ============================================================
// Constants + pure helpers (exported for tests)
// ============================================================
const SOLAR_ALIAS = "solar";
/** Cadence at which the recipe re-attempts a claim while it holds none (e.g.
 * the arbiter was disabled at start, or the equipment had no energy profile
 * yet). Cheap: it only reads arbiter state, never the grid meter. */
const RECLAIM_INTERVAL_MS = 60_000;
/** True when the equipment exposes a solar command channel (spec 152): an order
 * binding aliased `solar` or tagged `solar_toggle`. */
export function hasSolarChannel(orderBindings) {
    return orderBindings.some((ob) => ob.alias === SOLAR_ALIAS || ob.category === "solar_toggle");
}
// ============================================================
// Recipe factory
// ============================================================
export function createRecipe() {
    return {
        id: "water-heater-solar",
        name: "Water Heater on Solar Surplus",
        description: "Heats your water heater on solar surplus through its dedicated solar contact, coordinated by the energy arbiter.",
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
                description: "The water heater (or switch) whose dedicated solar contact is closed on surplus.",
                type: "equipment",
                required: true,
                constraints: { equipmentType: ["water_heater", "switch"], crossZone: true },
            },
        ],
        i18n: {
            fr: {
                name: "Chauffe-eau sur surplus solaire",
                description: "Chauffe le chauffe-eau sur le surplus solaire via son contact solaire dédié, coordonné par l'arbitre d'énergie.",
                slots: {
                    zone: {
                        name: "Pièce",
                        description: "La pièce sous laquelle l'automatisation est classée.",
                    },
                    heater: {
                        name: "Chauffe-eau",
                        description: "Le chauffe-eau (ou l'interrupteur) dont le contact solaire dédié est fermé sur le surplus.",
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
                throw new Error('This equipment has no solar command channel. Bind a solar contact (alias "solar") on it first.');
            }
        },
        createInstance(params, ctx) {
            const heaterId = params.heater;
            const heaterName = ctx.equipmentManager.getByIdWithDetails(heaterId)?.name ?? heaterId;
            let stopped = false;
            let claim = null;
            let lastDenied = null;
            const dispatchSolar = (on) => {
                ctx.dispatchOrder(heaterId, SOLAR_ALIAS, on ? "ON" : "OFF").catch((err) => {
                    ctx.log(`Solar order failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
                });
            };
            const arbiterEnabled = () => {
                try {
                    return !!ctx.helpers.energy && ctx.helpers.energy.getCapacityState().enabled;
                }
                catch {
                    return false;
                }
            };
            // Hold a single, persistent claim: the water heater always wants free
            // surplus. The arbiter grants when surplus is available at this load's
            // priority and revokes when it is not; the claim stays pending in between
            // and is re-granted on the next surplus. We only (re)claim while holding
            // none — never spamming the arbiter with duplicate claims.
            const ensureClaim = () => {
                if (stopped || claim)
                    return;
                const energy = ctx.helpers.energy;
                if (!energy || !arbiterEnabled())
                    return; // inert — the appliance's own programming assures
                try {
                    const handle = energy.claimCapacity({
                        equipmentId: heaterId,
                        note: "water heater on solar surplus",
                        onGranted: () => {
                            if (stopped)
                                return;
                            ctx.log(`Solar surplus granted -> heating ${heaterName}`);
                            dispatchSolar(true);
                        },
                        onRevoked: (reason) => {
                            if (stopped)
                                return;
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
                }
                catch (err) {
                    ctx.logger.error({ err }, "water-heater-solar: claimCapacity failed");
                    claim = null;
                }
            };
            // Start.
            ensureClaim();
            if (!arbiterEnabled()) {
                ctx.log("Energy arbiter unavailable or disabled -> solar heating inert; the water heater's own off-peak programming keeps water hot.");
            }
            const timer = setInterval(() => {
                try {
                    if (!stopped)
                        ensureClaim();
                }
                catch (err) {
                    ctx.logger.error({ err }, "water-heater-solar: tick failed");
                }
            }, RECLAIM_INTERVAL_MS);
            return {
                stop() {
                    stopped = true;
                    clearInterval(timer);
                    try {
                        claim?.release();
                    }
                    catch {
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
