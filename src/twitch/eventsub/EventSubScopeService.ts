import {Bean} from "@core/bean/BeanDecorators.ts";
import {
    AccessTokenScopes,
    EventSubSubscriptionType,
    EventSubTransportMethod,
    type EventSubConduitTransport,
    type EventSubSubscription,
    type EventSubSubscriptionCondition,
    type EventSubSubscriptionVersion,
    type RESTPostEventSubSubscriptionRequestBody,
} from "twitch-dev-types";
import {
    EventSubScopeRules,
    type PublicSubscriptionRule,
    type ScopeRule,
    type SubscriptionTemplate,
} from "@twitch/eventsub/EventSubScopeRules.ts";

// Twitch user ids are numeric.
const userIdPattern: RegExp = /^\d{1,20}$/;

// Condition fields that name the user a subscription belongs to.
const userConditionFields: string[] = ["broadcaster_user_id", "to_broadcaster_user_id", "user_id"];

/** The shape of a subscription the helpers below need – a Twitch subscription or a request body. */
interface SubscriptionShape {
    type: string;
    version: string;
    condition: object;
}

/** A public subscription as requested: type, version and condition. */
export interface PublicSubscriptionRequest {
    type: string;
    version: string;
    condition: Record<string, string>;
}

/** The checked request, or why it was rejected. */
export type PublicSubscriptionCheck = {valid: true; subscription: PublicSubscriptionRequest} | {valid: false; message: string};

/** Maps granted scopes to EventSub subscriptions (incl. bot chat subscriptions) without duplicates. */
@Bean()
export class EventSubScopeService {
    /** Version of channel.moderate the scopes allow (v2 with the warning scopes), or null. */
    private getChannelModerateVersion(scopes: string[]): EventSubSubscriptionVersion | null {
        const granted: (...options: AccessTokenScopes[]) => boolean = (...options: AccessTokenScopes[]): boolean => options.some((scope: AccessTokenScopes): boolean => scopes.includes(scope));

        const v1: boolean = granted(AccessTokenScopes.ModeratorReadBlockedTerms, AccessTokenScopes.ModeratorManageBlockedTerms)
            && granted(AccessTokenScopes.ModeratorReadChatSettings, AccessTokenScopes.ModeratorManageChatSettings)
            && granted(AccessTokenScopes.ModeratorReadUnbanRequests, AccessTokenScopes.ModeratorManageUnbanRequests)
            && granted(AccessTokenScopes.ModeratorReadBannedUsers, AccessTokenScopes.ModeratorManageBannedUsers)
            && granted(AccessTokenScopes.ModeratorReadChatMessages, AccessTokenScopes.ModeratorManageChatMessages)
            && granted(AccessTokenScopes.ModeratorReadModerators)
            && granted(AccessTokenScopes.ModeratorReadVIPs);

        if (!v1) return null;
        return granted(AccessTokenScopes.ModeratorReadWarnings, AccessTokenScopes.ModeratorManageWarnings) ? "2" : "1";
    }

    /** A subscription body from a template, with user or bot id filled in. */
    private toSubscription(template: SubscriptionTemplate, userId: string, botUserId: string | null, transport: EventSubConduitTransport): RESTPostEventSubSubscriptionRequestBody {
        const condition: Record<string, string> = {};
        for (const [field, source] of Object.entries(template.condition)) {
            condition[field] = source === "bot" ? botUserId as string : userId;
        }

        return {
            type: template.type,
            version: template.version,
            condition: condition as EventSubSubscriptionCondition,
            transport,
        } as RESTPostEventSubSubscriptionRequestBody;
    }

    /** Every subscription the scopes of a user allow that isn't in existingSubs yet. */
    public forUser(
        scopes: AccessTokenScopes[] | string[],
        botUserId: string | null,
        userId: string,
        transport: EventSubConduitTransport,
        existingSubs: Pick<EventSubSubscription, "type" | "version" | "condition">[],
    ): RESTPostEventSubSubscriptionRequestBody[] {
        const granted: string[] = scopes as string[];
        const subs: RESTPostEventSubSubscriptionRequestBody[] = EventSubScopeRules.alwaysSubscribed.map(
            (template: SubscriptionTemplate): RESTPostEventSubSubscriptionRequestBody => this.toSubscription(template, userId, botUserId, transport),
        );

        for (const scope of granted) {
            const rule: ScopeRule | undefined = EventSubScopeRules.scopeRules.find((candidate: ScopeRule): boolean => (candidate.scopes as string[]).includes(scope));
            if (!rule) continue;
            // Chat as bot needs a bot user (botUserId of IDENTIFY).
            if (rule.requiresBot && !botUserId) continue;
            if (rule.requiresScopes && !rule.requiresScopes.every((required: AccessTokenScopes): boolean => granted.includes(required))) continue;

            for (const template of rule.subscriptions) {
                // Two scopes may unlock the same type – create it only once.
                if (subs.some((sub: RESTPostEventSubSubscriptionRequestBody): boolean => sub.type === template.type)) continue;
                subs.push(this.toSubscription(template, userId, botUserId, transport));
            }
        }

        const channelModerateVersion: EventSubSubscriptionVersion | null = this.getChannelModerateVersion(granted);
        if (channelModerateVersion) {
            subs.push(this.toSubscription({type: EventSubSubscriptionType.ChannelModerate, version: channelModerateVersion, condition: EventSubScopeRules.channelModerateCondition}, userId, botUserId, transport));
        }

        return this.filterExisting(subs, existingSubs);
    }

    /** Checks a request body for POST/DELETE /twitch/subscriptions: a public type, its version and an exact condition. */
    public checkPublicSubscription(body: unknown): PublicSubscriptionCheck {
        if (typeof body !== "object" || body === null) return {valid: false, message: "The body must be a JSON object with type and condition"};
        const {type, version, condition}: Record<string, unknown> = body as Record<string, unknown>;

        const rule: PublicSubscriptionRule | undefined = EventSubScopeRules.publicSubscriptionRules.find((candidate: PublicSubscriptionRule): boolean => candidate.type === type);
        if (!rule) {
            const types: string = EventSubScopeRules.publicSubscriptionRules.map((candidate: PublicSubscriptionRule): string => candidate.type).join(", ");
            return {valid: false, message: `type must be one of the types without authorization: ${types}`};
        }
        if (version !== undefined && version !== rule.version) return {valid: false, message: `${rule.type} is supported in version ${rule.version}`};
        if (typeof condition !== "object" || condition === null || Array.isArray(condition)) return {valid: false, message: "condition must be an object"};

        const entries: [string, unknown][] = Object.entries(condition);
        const unknown: string | undefined = entries.map(([field]: [string, unknown]): string => field).find((field: string): boolean => !rule.fields.includes(field));
        if (unknown) return {valid: false, message: `Unknown condition field ${unknown} – ${rule.type} takes ${rule.fields.join(" or ")}`};
        if (entries.some(([, value]: [string, unknown]): boolean => typeof value !== "string" || !userIdPattern.test(value))) {
            return {valid: false, message: "Every condition value must be a Twitch user id (a string of digits)"};
        }

        const expected: number = rule.exactlyOne ? 1 : rule.fields.length;
        if (entries.length !== expected) {
            return {valid: false, message: rule.exactlyOne ? `Set exactly one of ${rule.fields.join(", ")}` : `condition needs ${rule.fields.join(", ")}`};
        }

        return {valid: true, subscription: {type: rule.type, version: rule.version, condition: condition as Record<string, string>}};
    }

    /** Whether the gateway itself may create this type for an authorized user (e.g. stream.online) – then it stays. */
    public isCreatedForAuthorizedUsers(type: string): boolean {
        return EventSubScopeRules.alwaysSubscribed.some((template: SubscriptionTemplate): boolean => template.type === type)
            || EventSubScopeRules.scopeRules.some((rule: ScopeRule): boolean => rule.subscriptions.some((template: SubscriptionTemplate): boolean => template.type === type));
    }

    /** The bot user id of a bot chat subscription, or null if it isn't one. */
    public getBotUserId(sub: Pick<EventSubSubscription, "type" | "version" | "condition">): string | null {
        const condition: Record<string, string | undefined> = sub.condition as Record<string, string | undefined>;

        for (const rule of EventSubScopeRules.scopeRules) {
            for (const template of rule.subscriptions) {
                if (template.type !== sub.type || template.version !== sub.version) continue;

                const fields: [string, "user" | "bot"][] = Object.entries(template.condition) as [string, "user" | "bot"][];
                const botValues: (string | undefined)[] = fields.filter(([, source]: [string, "user" | "bot"]): boolean => source === "bot")
                    .map(([field]: [string, "user" | "bot"]): string | undefined => condition[field]);
                const userValues: (string | undefined)[] = fields.filter(([, source]: [string, "user" | "bot"]): boolean => source === "user")
                    .map(([field]: [string, "user" | "bot"]): string | undefined => condition[field]);

                const botUserId: string | undefined = botValues[0];
                // Only a subscription with the bot in the bot fields and not in the user fields is a bot subscription.
                if (!botUserId || botValues.some((value: string | undefined): boolean => value !== botUserId) || userValues.includes(botUserId)) continue;
                return botUserId;
            }
        }
        return null;
    }

    /** The app-wide subscriptions: user.authorization.grant and .revoke for this client id. */
    public appSubscriptions(clientId: string, transport: EventSubConduitTransport): RESTPostEventSubSubscriptionRequestBody[] {
        return [{
            type: EventSubSubscriptionType.UserAuthorizationGrant,
            version: "1",
            condition: {
                client_id: clientId,
            },
            transport: transport,
        }, {
            type: EventSubSubscriptionType.UserAuthorizationRevoke,
            version: "1",
            condition: {
                client_id: clientId,
            },
            transport: transport,
        }];
    }

    /** The transport of every subscription the gateway creates: the app's conduit. */
    public conduitTransport(conduitId: string): EventSubConduitTransport {
        return {method: EventSubTransportMethod.Conduit, conduit_id: conduitId};
    }

    /** A subscription (stored, requested or listed) as the body to create it on the conduit. */
    public conduitRequest(sub: SubscriptionShape, conduitId: string): RESTPostEventSubSubscriptionRequestBody {
        return {type: sub.type, version: sub.version, condition: sub.condition, transport: this.conduitTransport(conduitId)} as RESTPostEventSubSubscriptionRequestBody;
    }

    /** Whether a subscription is on the given conduit (and not on a transport of the developer). */
    public isOnConduit(sub: {transport: object}, conduitId: string | null): boolean {
        const transport: {method?: string; conduit_id?: string} = sub.transport as {method?: string; conduit_id?: string};
        return conduitId !== null && transport.method === EventSubTransportMethod.Conduit && transport.conduit_id === conduitId;
    }

    /** The user a subscription belongs to – null for the app-wide authorization subscriptions. */
    public getConditionUserId(sub: {type: string; condition: object}): string | null {
        if (
            sub.type === EventSubSubscriptionType.UserAuthorizationGrant ||
            sub.type === EventSubSubscriptionType.UserAuthorizationRevoke
        ) return null;

        const condition: Record<string, string | undefined> = sub.condition as Record<string, string | undefined>;
        for (const field of userConditionFields) {
            if (condition[field]) return condition[field];
        }
        return null;
    }

    /** Identity of a subscription (type, version, set condition fields in a fixed order) – never compare by type alone. */
    public subscriptionKey(sub: SubscriptionShape): string {
        const condition: [string, unknown][] = Object.entries(sub.condition)
            .filter(([, value]: [string, unknown]): boolean => value !== "" && value !== null && value !== undefined)
            .sort(([a]: [string, unknown], [b]: [string, unknown]): number => a.localeCompare(b));

        return `${sub.type}:${sub.version}:${JSON.stringify(condition)}`;
    }

    /** Drops the subscriptions that already exist. */
    private filterExisting(
        subs: RESTPostEventSubSubscriptionRequestBody[],
        existingSubs: Pick<EventSubSubscription, "type" | "version" | "condition">[],
    ): RESTPostEventSubSubscriptionRequestBody[] {
        const existingKeys: Set<string> = new Set<string>(existingSubs.map((sub: Pick<EventSubSubscription, "type" | "version" | "condition">): string => this.subscriptionKey(sub)));
        return subs.filter((sub: RESTPostEventSubSubscriptionRequestBody): boolean => !existingKeys.has(this.subscriptionKey(sub)));
    }
}
