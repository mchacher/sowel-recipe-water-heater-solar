interface OrderBindingLite {
    alias: string;
    category?: string;
    type?: string;
}
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
        grants: Array<{
            equipmentId: string;
            watts: number;
            sinceIso: string;
        }>;
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
        energy?: EnergyHelpers;
    };
    dispatchOrder(equipmentId: string, alias: string, value: unknown): Promise<void>;
}
interface RecipeSlotDef {
    id: string;
    name: string;
    description: string;
    type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text" | "data-key";
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
    slots?: Record<string, {
        name: string;
        description: string;
    }>;
}
interface RecipeDefinition {
    id: string;
    name: string;
    description: string;
    slots: RecipeSlotDef[];
    i18n?: Record<string, RecipeLangPack>;
    validate(params: Record<string, unknown>, ctx: RecipeContext): void;
    createInstance(params: Record<string, unknown>, ctx: RecipeContext): {
        stop(): void;
    };
}
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
export declare function readDraw(bindings: readonly {
    alias: string;
    category?: string;
    value: unknown;
    lastUpdated?: string | null;
}[] | undefined, now?: number): number | null;
/** True when the equipment exposes a solar command channel (spec 152): an order
 * binding aliased `solar` or tagged `solar_toggle`. */
export declare function hasSolarChannel(orderBindings: readonly OrderBindingLite[]): boolean;
export declare function createRecipe(): RecipeDefinition;
export {};
