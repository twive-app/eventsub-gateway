import {Bean} from "@core/bean/BeanDecorators.ts";
import {
    AccessTokenScopes,
    EventSubSubscriptionType,
    type EventSubConduitTransport,
    type EventSubSubscription,
    type EventSubSubscriptionCondition,
    type EventSubSubscriptionVersion,
    type RESTPostEventSubSubscriptionRequestBody,
} from "twitch-dev-types";

/** Condition fields that take a user id. */
type ConditionField = "broadcaster_user_id" | "moderator_user_id" | "user_id";
/** Which id goes into a condition field: the authorizing user or the bot. */
type ConditionTemplate = Partial<Record<ConditionField, "user" | "bot">>;

/** A subscription to create, with its condition as template. */
interface SubscriptionTemplate {
    type: EventSubSubscriptionType;
    version: EventSubSubscriptionVersion;
    condition: ConditionTemplate;
}

/** The subscriptions a scope unlocks – `requiresBot`/`requiresScopes` add conditions. */
interface ScopeRule {
    scopes: AccessTokenScopes[];
    requiresBot?: true;
    requiresScopes?: AccessTokenScopes[];
    subscriptions: SubscriptionTemplate[];
}

// Condition templates used by the scope rules below.
const broadcaster: ConditionTemplate = {broadcaster_user_id: "user"};
const broadcasterAndModerator: ConditionTemplate = {broadcaster_user_id: "user", moderator_user_id: "user"};
const chatAsBot: ConditionTemplate = {broadcaster_user_id: "user", user_id: "bot"};
const chatAsUser: ConditionTemplate = {broadcaster_user_id: "user", user_id: "user"};
const user: ConditionTemplate = {user_id: "user"};

// Subscriptions every authorized user gets, without any scope.
const alwaysSubscribed: SubscriptionTemplate[] = [
    {type: EventSubSubscriptionType.StreamOnline, version: "1", condition: broadcaster},
    {type: EventSubSubscriptionType.StreamOffline, version: "1", condition: broadcaster},
];

/** A type anyone may subscribe to for any channel; `exactlyOne` = only one of the fields may be set. */
interface PublicSubscriptionRule {
    type: EventSubSubscriptionType;
    version: EventSubSubscriptionVersion;
    fields: string[];
    exactlyOne?: true;
}

// "No authorization required" in the Twitch EventSub reference – what POST /twitch/subscriptions accepts.
const publicSubscriptionRules: PublicSubscriptionRule[] = [
    {type: EventSubSubscriptionType.StreamOnline, version: "1", fields: ["broadcaster_user_id"]},
    {type: EventSubSubscriptionType.StreamOffline, version: "1", fields: ["broadcaster_user_id"]},
    {type: EventSubSubscriptionType.ChannelUpdate, version: "2", fields: ["broadcaster_user_id"]},
    {type: EventSubSubscriptionType.ChannelRaid, version: "1", fields: ["from_broadcaster_user_id", "to_broadcaster_user_id"], exactlyOne: true},
    {type: EventSubSubscriptionType.ChannelSharedChatBegin, version: "1", fields: ["broadcaster_user_id"]},
    {type: EventSubSubscriptionType.ChannelSharedChatUpdate, version: "1", fields: ["broadcaster_user_id"]},
    {type: EventSubSubscriptionType.ChannelSharedChatEnd, version: "1", fields: ["broadcaster_user_id"]},
    {type: EventSubSubscriptionType.UserUpdate, version: "1", fields: ["user_id"]},
];

// Twitch user ids are numeric.
const userIdPattern: RegExp = /^\d{1,20}$/;

/** A public subscription as requested: type, version and condition. */
export interface PublicSubscriptionRequest {
    type: string;
    version: string;
    condition: Record<string, string>;
}

/** The checked request, or why it was rejected. */
export type PublicSubscriptionCheck = {valid: true; subscription: PublicSubscriptionRequest} | {valid: false; message: string};

// Scope → subscriptions, following the authorization requirements of the Twitch EventSub reference.
const scopeRules: ScopeRule[] = [
    {
        scopes: [AccessTokenScopes.BitsRead],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelBitsUse, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelCheer, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelCustomPowerUpsRedemptionAdd, version: "1", condition: broadcaster},
        ],
    },
    {
        scopes: [AccessTokenScopes.ChannelBot],
        requiresBot: true,
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelChatClear, version: "1", condition: chatAsBot},
            {type: EventSubSubscriptionType.ChannelChatClearUserMessages, version: "1", condition: chatAsBot},
            {type: EventSubSubscriptionType.ChannelChatMessage, version: "1", condition: chatAsBot},
            {type: EventSubSubscriptionType.ChannelChatMessageDelete, version: "1", condition: chatAsBot},
            {type: EventSubSubscriptionType.ChannelChatNotification, version: "1", condition: chatAsBot},
            {type: EventSubSubscriptionType.ChannelChatSettingsUpdate, version: "1", condition: chatAsBot},
        ],
    },
    {
        scopes: [AccessTokenScopes.ChannelReadAds],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelAdBreakBegin, version: "1", condition: broadcaster},
        ],
    },
    {
        scopes: [AccessTokenScopes.ChannelReadCharity],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelCharityCampaignDonate, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelCharityCampaignStart, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelCharityCampaignProgress, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelCharityCampaignStop, version: "1", condition: broadcaster},
        ],
    },
    {
        scopes: [AccessTokenScopes.ChannelReadGoals],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelGoalBegin, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelGoalProgress, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelGoalEnd, version: "1", condition: broadcaster},
        ],
    },
    {
        scopes: [AccessTokenScopes.ChannelReadGuestStar, AccessTokenScopes.ChannelManageGuestStar, AccessTokenScopes.ModeratorReadGuestStar, AccessTokenScopes.ModeratorManageGuestStar],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelGuestStarSessionBegin, version: "beta", condition: broadcasterAndModerator},
            {type: EventSubSubscriptionType.ChannelGuestStarSessionEnd, version: "beta", condition: broadcasterAndModerator},
            {type: EventSubSubscriptionType.ChannelGuestStarGuestUpdate, version: "beta", condition: broadcasterAndModerator},
            {type: EventSubSubscriptionType.ChannelGuestStartSettingsUpdate, version: "beta", condition: broadcasterAndModerator},
        ],
    },
    {
        scopes: [AccessTokenScopes.ChannelReadHypeTrain],
        subscriptions: [
            {type: EventSubSubscriptionType.HypeTrainBegin, version: "2", condition: broadcaster},
            {type: EventSubSubscriptionType.HypeTrainProgress, version: "2", condition: broadcaster},
            {type: EventSubSubscriptionType.HypeTrainEnd, version: "2", condition: broadcaster},
        ],
    },
    {
        scopes: [AccessTokenScopes.ChannelReadPolls, AccessTokenScopes.ChannelManagePolls],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelPollBegin, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelPollProgress, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelPollEnd, version: "1", condition: broadcaster},
        ],
    },
    {
        scopes: [AccessTokenScopes.ChannelReadPredictions, AccessTokenScopes.ChannelManagePredictions],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelPredictionBegin, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelPredictionProgress, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelPredictionLook, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelPredictionEnd, version: "1", condition: broadcaster},
        ],
    },
    {
        scopes: [AccessTokenScopes.ChannelReadRedemptions, AccessTokenScopes.ChannelManageRedemptions],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelPointsAutomaticRewardRedemptionAdd, version: "2", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelPointsCustomRewardAdd, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelPointsCustomRewardUpdate, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelPointsCustomRewardRemove, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelPointsCustomRewardRedemptionAdd, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelPointsCustomRewardRedemptionUpdate, version: "1", condition: broadcaster},
        ],
    },
    {
        scopes: [AccessTokenScopes.ChannelReadSubscriptions],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelSubscribe, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelSubscriptionEnd, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelSubscriptionGift, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelSubscriptionMessage, version: "1", condition: broadcaster},
        ],
    },
    {
        scopes: [AccessTokenScopes.ChannelReadVIPs, AccessTokenScopes.ChannelManageVIPs],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelVIPAdd, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelVIPRemove, version: "1", condition: broadcaster},
        ],
    },
    {
        scopes: [AccessTokenScopes.ChannelModerate],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelBan, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelUnban, version: "1", condition: broadcaster},
        ],
    },
    {
        scopes: [AccessTokenScopes.ModerationRead],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelModeratorAdd, version: "1", condition: broadcaster},
            {type: EventSubSubscriptionType.ChannelModeratorRemove, version: "1", condition: broadcaster},
        ],
    },
    {
        scopes: [AccessTokenScopes.ModeratorManageAutomod],
        subscriptions: [
            {type: EventSubSubscriptionType.AutomodMessageHold, version: "2", condition: broadcasterAndModerator},
            {type: EventSubSubscriptionType.AutomodMessageUpdate, version: "2", condition: broadcasterAndModerator},
            {type: EventSubSubscriptionType.AutomodTermsUpdate, version: "1", condition: broadcasterAndModerator},
        ],
    },
    {
        scopes: [AccessTokenScopes.ModeratorReadAutomodSettings, AccessTokenScopes.ModeratorManageAutomodSettings],
        subscriptions: [
            {type: EventSubSubscriptionType.AutomodSettingsUpdate, version: "1", condition: broadcasterAndModerator},
        ],
    },
    {
        scopes: [AccessTokenScopes.ModeratorReadFollowers],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelFollow, version: "2", condition: broadcasterAndModerator},
        ],
    },
    {
        scopes: [AccessTokenScopes.ModeratorReadShieldMode, AccessTokenScopes.ModeratorManageShieldMode],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelShieldModeBegin, version: "1", condition: broadcasterAndModerator},
            {type: EventSubSubscriptionType.ChannelShieldModeEnd, version: "1", condition: broadcasterAndModerator},
        ],
    },
    {
        scopes: [AccessTokenScopes.ModeratorReadShoutouts, AccessTokenScopes.ModeratorManageShoutouts],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelShoutoutCreate, version: "1", condition: broadcasterAndModerator},
            {type: EventSubSubscriptionType.ChannelShoutoutReceive, version: "1", condition: broadcasterAndModerator},
        ],
    },
    {
        scopes: [AccessTokenScopes.ModeratorReadSuspiciousUsers],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelSuspiciousUserMessage, version: "1", condition: broadcasterAndModerator},
            {type: EventSubSubscriptionType.ChannelSuspiciousUserUpdate, version: "1", condition: broadcasterAndModerator},
        ],
    },
    {
        scopes: [AccessTokenScopes.ModeratorReadUnbanRequests, AccessTokenScopes.ModeratorManageUnbanRequests],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelUnbanRequestCreate, version: "1", condition: broadcasterAndModerator},
            {type: EventSubSubscriptionType.ChannelUnbanRequestResolve, version: "1", condition: broadcasterAndModerator},
        ],
    },
    {
        scopes: [AccessTokenScopes.ModeratorReadWarnings, AccessTokenScopes.ModeratorManageWarnings],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelWarningAcknowledge, version: "1", condition: broadcasterAndModerator},
            {type: EventSubSubscriptionType.ChannelWarningSend, version: "1", condition: broadcasterAndModerator},
        ],
    },
    {
        scopes: [AccessTokenScopes.UserReadChat],
        requiresScopes: [AccessTokenScopes.UserBot],
        subscriptions: [
            {type: EventSubSubscriptionType.ChannelChatClear, version: "1", condition: chatAsUser},
            {type: EventSubSubscriptionType.ChannelChatClearUserMessages, version: "1", condition: chatAsUser},
            {type: EventSubSubscriptionType.ChannelChatMessage, version: "1", condition: chatAsUser},
            {type: EventSubSubscriptionType.ChannelChatMessageDelete, version: "1", condition: chatAsUser},
            {type: EventSubSubscriptionType.ChannelChatNotification, version: "1", condition: chatAsUser},
            {type: EventSubSubscriptionType.ChannelChatSettingsUpdate, version: "1", condition: chatAsUser},
            {type: EventSubSubscriptionType.ChannelChatUserMessageHold, version: "1", condition: chatAsUser},
            {type: EventSubSubscriptionType.ChannelChatUserMessageUpdate, version: "1", condition: chatAsUser},
        ],
    },
    {
        scopes: [AccessTokenScopes.UserReadEmail],
        subscriptions: [
            {type: EventSubSubscriptionType.UserUpdate, version: "1", condition: user},
        ],
    },
    {
        scopes: [AccessTokenScopes.UserReadWhispers, AccessTokenScopes.UserManageWhispers],
        subscriptions: [
            {type: EventSubSubscriptionType.WhisperMessage, version: "1", condition: user},
        ],
    },
];

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
        const subs: RESTPostEventSubSubscriptionRequestBody[] = alwaysSubscribed.map(
            (template: SubscriptionTemplate): RESTPostEventSubSubscriptionRequestBody => this.toSubscription(template, userId, botUserId, transport),
        );

        for (const scope of granted) {
            const rule: ScopeRule | undefined = scopeRules.find((candidate: ScopeRule): boolean => (candidate.scopes as string[]).includes(scope));
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
            subs.push(this.toSubscription({type: EventSubSubscriptionType.ChannelModerate, version: channelModerateVersion, condition: broadcasterAndModerator}, userId, botUserId, transport));
        }

        return this.filterExisting(subs, existingSubs);
    }

    /** Checks a request body for POST/DELETE /twitch/subscriptions: a public type, its version and an exact condition. */
    public checkPublicSubscription(body: unknown): PublicSubscriptionCheck {
        if (typeof body !== "object" || body === null) return {valid: false, message: "The body must be a JSON object with type and condition"};
        const {type, version, condition}: Record<string, unknown> = body as Record<string, unknown>;

        const rule: PublicSubscriptionRule | undefined = publicSubscriptionRules.find((candidate: PublicSubscriptionRule): boolean => candidate.type === type);
        if (!rule) {
            const types: string = publicSubscriptionRules.map((candidate: PublicSubscriptionRule): string => candidate.type).join(", ");
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
        return alwaysSubscribed.some((template: SubscriptionTemplate): boolean => template.type === type)
            || scopeRules.some((rule: ScopeRule): boolean => rule.subscriptions.some((template: SubscriptionTemplate): boolean => template.type === type));
    }

    /** The bot user id of a bot chat subscription, or null if it isn't one. */
    public getBotUserId(sub: Pick<EventSubSubscription, "type" | "version" | "condition">): string | null {
        const condition: Record<string, string | undefined> = sub.condition as Record<string, string | undefined>;

        for (const rule of scopeRules) {
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

    /** Identity of a subscription (type, version, set condition fields in a fixed order) – never compare by type alone. */
    public subscriptionKey(sub: {type: string; version: string; condition: object}): string {
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
