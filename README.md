# Sowel recipe: Water Heater Solar

Heats a water heater on **solar surplus** through its dedicated **solar command channel** (Sowel spec 152), coordinated by the **energy capacity arbiter** (spec 140).

One responsibility, on purpose:

- arbiter **grants** capacity to the heater  ->  close the solar contact (heat on free solar)
- arbiter **revokes** it  ->  open the contact
- a **manual override** on the contact is never fought (the human wins)

## Why surplus-only

The off-peak / guaranteed hot-water baseline stays owned by the **appliance's own internal programming** (e.g. an Atlantic Calypso Connecté's ECO plage de chauffe on the HC window). This recipe only adds free daytime solar on top.

Sowel is deliberately **blind to the tank temperature** here: a thermodynamic water heater like the Calypso is driven through a dry contact (a SONOFF MINI-ZBD on its photovoltaic input) and does not report its temperature to Sowel. "Do not heat if the tank is already hot" is guaranteed by the **appliance's own thermostat** (the Calypso forces 62 C in PV mode and stops when reached), not by a Sowel condition.

**Fallback:** with no arbiter, the arbiter disabled, or a home with no PV production, the recipe stays inert and the appliance's own programming keeps the water hot. A surplus claim is a bonus, never the plan.

## Requirements

- Sowel **>= 1.52.0** (the solar command channel, spec 152).
- The energy **arbiter enabled**, and the water heater added to its priority list.
- An **energy profile** on the water heater: class `deferrable`, `nominalPowerW` ~650 (heat pump only at 62 C on the Calypso; the electric booster does not run in PV mode), and `minOnS` raised to cover the appliance's own ~30 min release tail.
- A **solar command channel** bound on the equipment: an on/off order under the alias `solar` (spec 152), wired to the heater's photovoltaic dry-contact input.

## Slots

| Slot          | Type      | Notes                                                        |
| ------------- | --------- | ----------------------------------------------------------- |
| Water heater  | equipment | `water_heater` or `switch`, must expose a `solar` channel   |

Tolerated grid import and nominal watts are **not** recipe slots: they live on the equipment's energy profile (set once, read by the arbiter).

## Install (personal source)

1. Publish this repo and a GitHub release with the `sowel-recipe-water-heater-solar-<version>.tar.gz` asset.
2. On your Sowel instance: **Plugins -> Store -> Personal sources**, add `mchacher/sowel-recipe-water-heater-solar`.
3. Install through the TOFU confirmation modal, then create an instance and pick your water heater.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # vitest
```

## Giving the surplus back once the tank is hot (v0.2.0, #2)

The claim used to be permanent: the water heater always wants free surplus. That is right while the tank heats, and once its thermostat has cut off it leaves the load sitting under a grant it is not using.

Be precise about what that costs, because it is less than it looks. The arbiter sizes a granted claim's reservation from the **live measured draw**, so a metered heater that has stopped drawing already reserves close to nothing and lower-priority loads are served normally. The reservation only re-inflates, to the learned watts, when the measurement goes **stale** — which is exactly what was observed on the reference installation, where the clamp was on Zigbee's default reporting interval and its reading was sixteen minutes old.

So this buys a truthful surface, and a floor under the stale case rather than a day of freed surplus.

The recipe stays blind to the tank temperature, as it always has: the appliance is driven through a dry contact and reports nothing back. It watches the load's own **measured draw** instead, which is a different question and the one a reservation should follow. Once that draw has sat at essentially zero for **30 minutes** under a grant with the contact closed, the claim is released and the contact opened; the appliance falls back to its own programming, exactly as it does on a revoke. A cooling-off period then keeps the next tick from taking the surplus straight back, and it **doubles on each consecutive release** (capped at four hours, reset the moment the heater draws again): a flat one would settle into a permanent 60-min-free / 30-min-reserved cycle on a tank that is hot for the afternoon, each re-claim preempting whatever load took the freed surplus only to hand it back half an hour later.

Only a **live numeric** reading counts. A binding whose device has never published carries `null`, a cloud-API load reports its on/off state under the alias `power`, and a clamp that drops off the network freezes its last value: read as zero, any of those would open the contact on a cold tank and lock the recipe out. Anything that is not a number, or is older than two minutes, reads as unknown.

A heater with **no power channel** keeps the previous behaviour exactly: no measurement, no release. Silence is never read as "the tank is hot".

The trade-off is deliberate and worth knowing: releasing means losing your place in the priority queue, so a load that takes the freed surplus may hold it under its own anti-short-cycle window when the tank cools. This trades a certain, permanent waste against an occasional delay.
