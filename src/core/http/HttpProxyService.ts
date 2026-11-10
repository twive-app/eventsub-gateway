import net from "node:net";
import type {Server} from "bun";
import {Autowired, Bean} from "@core/bean/BeanDecorators.ts";
import type {ConfigManager} from "@core/config/ConfigManager.ts";

/** Client address (behind trusted proxies: from X-Forwarded-For) and the address of the socket itself. */
export interface HttpRemoteAddress {
    address: string;
    socketAddress: string;
}

// IPv4 written as hex in an IPv4-mapped IPv6 address, e.g. ::ffff:7f00:1.
const mappedIpv4Pattern: RegExp = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/** Resolves the real client address behind the trusted reverse proxies (TRUSTED_PROXIES). */
@Bean()
export class HttpProxyService {
    @Autowired()
    private configManager!: ConfigManager;

    private trustedProxies: net.BlockList | null = null;

    /** Client address of a request – X-Forwarded-For is only used when the socket is a trusted proxy. */
    public resolve<T>(request: Request, server: Server<T>): HttpRemoteAddress {
        const socketAddress: string = HttpProxyService.normalize(server.requestIP(request)?.address ?? "") ?? "unknown";
        if (!this.isTrusted(socketAddress)) return {address: socketAddress, socketAddress};

        // Walk X-Forwarded-For from the right: the first entry that is not a trusted proxy is the client.
        const forwarded: string[] = request.headers.get("x-forwarded-for")?.split(",") ?? [];
        let address: string = socketAddress;
        for (let i: number = forwarded.length - 1; i >= 0; i--) {
            const entry: string | null = HttpProxyService.normalize(forwarded[i].trim());
            if (!entry) continue;

            address = entry;
            if (!this.isTrusted(entry)) break;
        }
        return {address, socketAddress};
    }

    /** Key for the per-address limits: IPv4 as is, IPv6 cut to its prefix (e.g. 2001:db8:1:2::/64). */
    public toLimitKey(address: string, ipv6PrefixLength: number): string {
        const normalized: string | null = HttpProxyService.normalize(address);
        if (!normalized || net.isIP(normalized) === 4) return normalized ?? address;

        const groups: number[] = HttpProxyService.expandIpv6(normalized);
        for (let i: number = 0; i < groups.length; i++) {
            const bits: number = Math.min(Math.max(ipv6PrefixLength - i * 16, 0), 16);
            groups[i] &= (0xffff << (16 - bits)) & 0xffff;
        }

        const hex: string = groups.map((group: number): string => group.toString(16)).join(":");
        const canonical: string = new URL(`http://[${hex}]/`).hostname.slice(1, -1);
        return ipv6PrefixLength === 128 ? canonical : `${canonical}/${ipv6PrefixLength}`;
    }

    /** Whether an address belongs to TRUSTED_PROXIES. */
    private isTrusted(address: string): boolean {
        const family: number = net.isIP(address);
        if (family === 0) return false;
        return this.getTrustedProxies().check(address, family === 4 ? "ipv4" : "ipv6");
    }

    /** TRUSTED_PROXIES as a BlockList, built once on first use. */
    private getTrustedProxies(): net.BlockList {
        if (this.trustedProxies) return this.trustedProxies;

        const list: net.BlockList = new net.BlockList();
        for (const entry of this.configManager.get().server.trustedProxies) {
            const [rawAddress, prefix]: (string | undefined)[] = entry.split("/");
            const address: string | null = HttpProxyService.normalize(rawAddress ?? "");
            if (!address) continue;

            const type: "ipv4" | "ipv6" = net.isIP(address) === 4 ? "ipv4" : "ipv6";
            if (prefix === undefined) list.addAddress(address, type);
            else list.addSubnet(address, Number(prefix), type);
        }
        this.trustedProxies = list;
        return list;
    }

    /** IPv6 address as its eight 16-bit groups ("::" expanded). */
    private static expandIpv6(address: string): number[] {
        const [head, tail]: (string | undefined)[] = address.split("%")[0].split("::");
        const start: number[] = HttpProxyService.parseIpv6Groups(head);
        const end: number[] = HttpProxyService.parseIpv6Groups(tail);
        return [...start, ...new Array<number>(8 - start.length - end.length).fill(0), ...end];
    }

    /** 16-bit groups of one side of "::" – an embedded IPv4 counts as two groups. */
    private static parseIpv6Groups(part: string | undefined): number[] {
        if (!part) return [];
        return part.split(":").flatMap((group: string): number[] => {
            if (!group.includes(".")) return [parseInt(group, 16)];
            const [a, b, c, d]: number[] = group.split(".").map(Number);
            return [(a << 8) | b, (c << 8) | d];
        });
    }

    /** Lower-case address, IPv4-mapped IPv6 as plain IPv4, or null if it is no IP at all. */
    private static normalize(value: string): string | null {
        const family: number = net.isIP(value);
        if (family === 4) return value;
        if (family === 0) return null;

        const lower: string = value.toLowerCase();
        if (lower.startsWith("::ffff:") && net.isIPv4(lower.slice(7))) return lower.slice(7);

        const mapped: RegExpExecArray | null = mappedIpv4Pattern.exec(lower);
        if (!mapped) return lower;

        const high: number = parseInt(mapped[1], 16);
        const low: number = parseInt(mapped[2], 16);
        return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
}
