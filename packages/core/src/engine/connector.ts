export type WriteSpec = { system: string; op: string; args: Record<string, unknown> };

export type ConnectorCtx = { workspaceId: string; personId: string; userToken: string | null };

/** One external system. `perform` does the write; `undo` reverses it. */
export interface Connector {
  readonly system: string;
  perform(spec: WriteSpec, ctx: ConnectorCtx): Promise<{ externalId: string }>;
  undo(externalId: string, spec: WriteSpec, ctx: ConnectorCtx): Promise<void>;
}

/** Thrown by a connector to record a target as skipped (not failed) with a plain-words reason. */
export class SkipWrite extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SkipWrite";
  }
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();
  register(connector: Connector): this {
    this.connectors.set(connector.system, connector);
    return this;
  }
  get(system: string): Connector | undefined {
    return this.connectors.get(system);
  }
}
