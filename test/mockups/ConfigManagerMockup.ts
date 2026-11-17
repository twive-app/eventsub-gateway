import type {ConfigValues} from "@core/config/ConfigManager.ts";
import {loadConfig} from "../helpers.ts";

/** A ConfigManager stand-in that returns the given configuration – set() swaps it for beans that already hold it. */
export class ConfigManagerMockup {
    private config: ConfigValues;

    public constructor(config: ConfigValues = loadConfig()) {
        this.config = config;
    }

    public get(): ConfigValues {
        return this.config;
    }

    public set(config: ConfigValues): void {
        this.config = config;
    }
}
