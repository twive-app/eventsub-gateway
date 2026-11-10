import {Autowired, Bean, Route} from "@core/bean/BeanDecorators.ts";
import type {HealthCheck, HealthCheckService} from "@health/HealthCheckService.ts";

/** GET /health – 200 when every check passes, otherwise 503. */
@Bean()
export class HealthController {
    @Autowired()
    private healthCheckService!: HealthCheckService;

    /** Answers with the health status as JSON. */
    @Route("GET", "/health")
    public async health(): Promise<Response> {
        const health: HealthCheck = await this.healthCheckService.check();
        return Response.json(health.status, {status: health.healthy ? 200 : 503});
    }
}
