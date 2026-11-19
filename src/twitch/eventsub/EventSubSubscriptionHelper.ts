import {
    EventSubSubscriptionType,
    EventSubTransportMethod,
    type EventSubConduitTransport,
    type RESTPostEventSubSubscriptionRequestBody,
} from "twitch-dev-types";

// Condition fields that name the user a subscription belongs to.
const userConditionFields: string[] = ["broadcaster_user_id", "to_broadcaster_user_id", "user_id"];

/** The shape of a subscription the helpers need – a Twitch subscription, a stored one or a request body. */
export interface SubscriptionShape {
    type: string;
    version: string;
    condition: object;
}

/** Pure functions on the shape of a subscription: its identity, its user and its conduit – no state, no Twitch. */
export class EventSubSubscriptionHelper {
    /** The transport of every subscription the gateway creates: the app's conduit. */
    public static conduitTransport(conduitId: string): EventSubConduitTransport {
        return {method: EventSubTransportMethod.Conduit, conduit_id: conduitId};
    }

    /** A subscription (stored, requested or listed) as the body to create it on the conduit. */
    public static conduitRequest(sub: SubscriptionShape, conduitId: string): RESTPostEventSubSubscriptionRequestBody {
        return {type: sub.type, version: sub.version, condition: sub.condition, transport: EventSubSubscriptionHelper.conduitTransport(conduitId)} as RESTPostEventSubSubscriptionRequestBody;
    }

    /** Whether a subscription is on the given conduit (and not on a transport of the developer). */
    public static isOnConduit(sub: {transport: object}, conduitId: string | null): boolean {
        const transport: {method?: string; conduit_id?: string} = sub.transport as {method?: string; conduit_id?: string};
        return conduitId !== null && transport.method === EventSubTransportMethod.Conduit && transport.conduit_id === conduitId;
    }

    /** The user a subscription belongs to – null for the app-wide authorization subscriptions. */
    public static getConditionUserId(sub: {type: string; condition: object}): string | null {
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
    public static subscriptionKey(sub: SubscriptionShape): string {
        const condition: [string, unknown][] = Object.entries(sub.condition)
            .filter(([, value]: [string, unknown]): boolean => value !== "" && value !== null && value !== undefined)
            .sort(([a]: [string, unknown], [b]: [string, unknown]): number => a.localeCompare(b));

        return `${sub.type}:${sub.version}:${JSON.stringify(condition)}`;
    }
}
