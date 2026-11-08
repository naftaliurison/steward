import { createApp } from "./app";
import { depsFromEnv } from "./deps";
import type { Env } from "./env";
import { runTick } from "./tick";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return createApp(depsFromEnv(env, ctx)).fetch(request, env, ctx);
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runTick(depsFromEnv(env, ctx)));
  },
} satisfies ExportedHandler<Env>;
