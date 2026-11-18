import {
    AccessTokenScopes,
    EventSubSubscriptionType,
    type EventSubSubscriptionVersion,
} from "twitch-dev-types";

/** Condition fields that take a user id. */
export type ConditionField = "broadcaster_user_id" | "moderator_user_id" | "user_id";
/** Which id goes into a condition field: the authorizing user or the bot. */
export type ConditionTemplate = Partial<Record<ConditionField, "user" | "bot">>;

/** A subscription to create, with its condition as template. */
export interface SubscriptionTemplate {
    type: EventSubSubscriptionType;
    version: EventSubSubscriptionVersion;
    condition: ConditionTemplate;
}

/** The subscriptions a scope unlocks – `requiresBot`/`requiresScopes` add conditions. */
export interface ScopeRule {
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
export interface PublicSubscriptionRule {
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

/** The rules of EventSubScopeService: what every user gets, what each scope unlocks, what anyone may subscribe to. */
export const EventSubScopeRules = {
    // channel.moderate depends on a combination of scopes – EventSubScopeService decides its version.
    channelModerateCondition: broadcasterAndModerator,
    alwaysSubscribed,
    scopeRules,
    publicSubscriptionRules,
} as const;
