/**
 * ADR-0188 slice S5 — the slice of `oidc-provider` 9.12.2 (MIT, untyped) the
 * token endpoint uses. Declared narrowly on purpose: everything else in the
 * provider is unused and switched off. `oauth/provider-contract.test.ts`
 * fails the build if these shapes or the pre-claim hook order change.
 */
declare module "oidc-provider" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  export interface KoaContextLike {
    method: string;
    status: number;
    body: unknown;
    get(name: string): string;
    set(name: string, value: string): void;
    oidc: {
      params: Record<string, string | string[] | undefined>;
      client: { clientId: string; clientAuthMethod: string };
      route: string;
    };
  }

  export interface AdapterPayload {
    [key: string]: unknown;
  }
  export interface Adapter {
    upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void>;
    find(id: string): Promise<AdapterPayload | undefined>;
    findByUserCode(userCode: string): Promise<AdapterPayload | undefined>;
    findByUid(uid: string): Promise<AdapterPayload | undefined>;
    consume(id: string): Promise<void>;
    destroy(id: string): Promise<void>;
    revokeByGrantId(grantId: string): Promise<void>;
  }
  export type AdapterFactory = new (name: string) => Adapter;

  export default class Provider {
    constructor(issuer: string, configuration: Record<string, unknown>);
    proxy: boolean;
    callback(): (req: IncomingMessage, res: ServerResponse) => void;
    registerGrantType(name: string, handler: (ctx: KoaContextLike) => Promise<void>, params?: readonly string[], dupes?: readonly string[]): void;
    use(middleware: (ctx: KoaContextLike, next: () => Promise<void>) => Promise<void>): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
  }
}

declare module "oidc-provider/lib/helpers/grants.js" {
  import type Provider from "oidc-provider";
  import type { KoaContextLike } from "oidc-provider";
  export function checkDpopReplay(
    provider: Provider,
    ctx: KoaContextLike,
    dPoP: { jti: string; thumbprint?: string; iat?: number },
    clientId: string,
    ErrorClass?: new (description?: string) => Error,
  ): Promise<void>;
  export function buildTokenResponse(
    provider: Provider,
    args: { accessToken: string; tokenType: string; issuedTokenType?: string; expiresIn?: number; parameters?: Record<string, unknown> },
  ): Record<string, unknown>;
}

declare module "oidc-provider/lib/helpers/errors.js" {
  export class OIDCProviderError extends Error {
    error: string;
    error_description?: string;
    error_detail?: string;
    statusCode: number;
  }
  export class InvalidClientAuth extends OIDCProviderError {
    constructor(detail?: string);
  }
  export class InvalidGrant extends OIDCProviderError {
    constructor(detail?: string);
  }
  export class InvalidRequest extends OIDCProviderError {
    constructor(description?: string);
  }
  export class InvalidTarget extends OIDCProviderError {
    constructor(description?: string);
  }
  export class InvalidAuthorizationDetails extends OIDCProviderError {
    constructor(description?: string);
  }
  export class InvalidDpopProof extends OIDCProviderError {
    constructor(description?: string);
  }
  export class UseDpopNonce extends OIDCProviderError {
    constructor(description?: string);
  }
}
