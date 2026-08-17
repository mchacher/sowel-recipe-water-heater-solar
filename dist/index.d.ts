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
/** True when the equipment exposes a solar command channel (spec 152): an order
 * binding aliased `solar` or tagged `solar_toggle`. */
export declare function hasSolarChannel(orderBindings: readonly OrderBindingLite[]): boolean;
export declare function createRecipe(): RecipeDefinition;
export {};
