/** Options of SET. */
export interface SetOptions {
    expiration?: {type: "EX" | "PX"; value: number};
    condition?: "NX" | "XX";
}

/** One queued command: its name, keys and arguments. */
export interface RedisCommand {
    name: string;
    keys: string[];
    args: string[];
}

/** Collects commands for transaction() or pipeline(). */
export class RedisClientTransaction {
    public readonly commands: RedisCommand[] = [];

    /** SET with optional expiration (EX/PX) and condition (NX/XX). */
    public set(key: string, value: string, options?: SetOptions): this {
        const args: string[] = [value];
        if (options?.expiration) args.push(options.expiration.type, String(Math.ceil(options.expiration.value)));
        if (options?.condition) args.push(options.condition);
        return this.add("SET", [key], args);
    }

    /** GET – returns the raw string. */
    public get(key: string): this {
        return this.add("GET", [key]);
    }

    /** DEL of one or more keys. */
    public del(keys: string | string[]): this {
        return this.add("DEL", this.list(keys));
    }

    /** EXISTS – 1 or 0. */
    public exists(key: string): this {
        return this.add("EXISTS", [key]);
    }

    /** PEXPIRE in milliseconds, optionally only under a condition (NX, XX, GT, LT). */
    public pExpire(key: string, milliseconds: number, mode?: "NX" | "XX" | "GT" | "LT"): this {
        const args: string[] = [String(Math.ceil(milliseconds))];
        if (mode) args.push(mode);
        return this.add("PEXPIRE", [key], args);
    }

    /** SADD of one or more members. */
    public sAdd(key: string, members: string | string[]): this {
        return this.add("SADD", [key], this.list(members));
    }

    /** SREM of one or more members. */
    public sRem(key: string, members: string | string[]): this {
        return this.add("SREM", [key], this.list(members));
    }

    /** SCARD – number of members. */
    public sCard(key: string): this {
        return this.add("SCARD", [key]);
    }

    /** LRANGE of a list. */
    public lRange(key: string, start: number, stop: number): this {
        return this.add("LRANGE", [key], [String(start), String(stop)]);
    }

    /** Queues a command with its keys and arguments. */
    private add(name: string, keys: string[], args: string[] = []): this {
        this.commands.push({name, keys, args});
        return this;
    }

    /** A single value as a list. */
    private list(values: string | string[]): string[] {
        return Array.isArray(values) ? values : [values];
    }
}
