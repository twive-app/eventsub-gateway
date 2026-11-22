/** Responses every route shares – no bean, so importing it doesn't change the startup order of HttpServer. */
export class HttpErrorResponse {
    /** JSON error body every route answers with: `{error, statusCode, message?}`. */
    public static format(status: number, error: string, message?: string, headers?: Record<string, string>): Response {
        return Response.json({
            error,
            statusCode: status,
            message,
        }, {
            status,
            headers,
        });
    }
}
