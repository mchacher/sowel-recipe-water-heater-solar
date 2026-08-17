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
