# Third-party components — `@regulait/cloud-discovery`

Open-source components this package ships or uses in its tests (ADR-0176 admission rules: MIT, Apache-2.0, BSD or
ISC, or a public-domain dedication; maintained; pinned; works air-gapped). Every npm dependency is pinned exactly in
`package.json` and through `pnpm-lock.yaml`. Licences were checked on 2026-10-17 with
`pnpm licenses list --filter @regulait/cloud-discovery --prod`: the whole production tree is Apache-2.0, MIT,
BSD-3-Clause, ISC or 0BSD, with no GPL, AGPL, EPL, SSPL or BSL entry.

ADR-0195 decision 11 names the official cloud SDKs; they are used as published. None of them downloads anything at
runtime. They reach only the cloud API hosts an admin allow-lists, through the guarded transport (decision 8).

## Direct dependencies

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `@aws-sdk/client-account` (github.com/aws/aws-sdk-js-v3) | `3.1152.0` | Apache-2.0 | `ListRegions`: the regions an AWS account has enabled. |
| `@aws-sdk/client-bedrock` | `3.1152.0` | Apache-2.0 | Bedrock custom and imported models, provisioned throughput, guardrails, invocation-logging setting. |
| `@aws-sdk/client-bedrock-agent` | `3.1152.0` | Apache-2.0 | Bedrock agents and knowledge bases. |
| `@aws-sdk/client-cloudtrail` | `3.1152.0` | Apache-2.0 | `LookupEvents` for Bedrock invocation events. |
| `@aws-sdk/client-s3` | `3.1152.0` | Apache-2.0 | Optional read of the customer's CloudTrail bucket for Bedrock data events. |
| `@aws-sdk/client-sagemaker` | `3.1152.0` | Apache-2.0 | SageMaker endpoints and models. |
| `@aws-sdk/credential-providers` | `3.1152.0` | Apache-2.0 | `fromWebToken` (AssumeRoleWithWebIdentity) and `fromTemporaryCredentials` (AssumeRole with external id), each given the guarded request handler. |
| `@smithy/fetch-http-handler` (github.com/smithy-lang/smithy-typescript) | `5.8.0` | Apache-2.0 | The AWS SDK's own fetch handler; its `customFetch` option is how every AWS call goes through the guarded fetch. |
| `@smithy/types` | `4.19.0` | Apache-2.0 | AWS credential identity types. |
| `@azure/identity` (github.com/Azure/azure-sdk-for-js) | `4.14.0` | MIT | `ClientAssertionCredential` (federated) and `ClientSecretCredential` (static relaxation), built with the guarded `HttpClient`. |
| `@azure/core-rest-pipeline` | `1.25.0` | MIT | The `HttpClient` interface our guarded adapter implements. |
| `@azure/core-auth` | `1.11.0` | MIT | `TokenCredential` type. |
| `@azure/arm-resourcegraph` | `5.0.0` | MIT | Resource Graph queries for Cognitive Services accounts, deployments and ML workspaces. |
| `@azure/arm-cognitiveservices` | `8.1.0` | MIT | ARM list-deployments when Resource Graph has no deployment rows. |
| `@azure/arm-monitor` | `8.0.0` | MIT | Activity log (`eventtypes/management/values`). |
| `@azure/monitor-query-logs` | `1.0.0` | MIT | Log Analytics query for routed Cognitive Services diagnostic logs (counts only). Replaces the deprecated `@azure/monitor-query`. |
| `@google-cloud/service-usage` (github.com/googleapis/google-cloud-node) | `5.2.0` | Apache-2.0 | `batchGetServices`: is the Vertex AI or Generative Language API enabled. REST fallback mode. |
| `@google-cloud/asset` | `7.2.0` | Apache-2.0 | `searchAllResources` for Vertex endpoints, models and index endpoints. REST fallback mode. |
| `@google-cloud/resource-manager` | `7.2.0` | Apache-2.0 | `getIamPolicy`, read only for its audit configuration (are Data Access logs on). REST fallback mode. |
| `google-auth-library` (github.com/googleapis/google-auth-library-nodejs) | `11.3.1` | Apache-2.0 | `IdentityPoolClient` (workload identity federation with a programmatic subject token) and `JWT` (service-account key relaxation); its Gaxios transporter carries the guarded fetch. Also used directly for the Logging `entries:list` REST call. |
| `zod` (github.com/colinhacks/zod) | `4.6.5` | MIT | Credential input schemas. |

## Notable transitive dependencies

| Component | Version | Licence | Note |
|---|---|---|---|
| `google-gax` | `6.12.1` | Apache-2.0 | The GAPIC runtime. Used only in REST fallback mode; its gRPC transport is never selected. |
| `@grpc/grpc-js` | `1.14.5` | Apache-2.0 | Installed as a dependency of `google-gax`; never used as a transport by this package. |
| `gaxios` | `8.3.1` | Apache-2.0 | Google's HTTP client; constructed through `google-auth-library`'s own re-export with `fetchImplementation` set to the guarded fetch. |
| `@azure/msal-node`, `@azure/msal-common` | `6.0.1`, `16.14.1` | MIT | Entra token acquisition inside `@azure/identity`; its network client is the guarded `HttpClient`. |
| `protobufjs` | `7.6.6` | BSD-3-Clause | Message encoding for the Google clients' REST fallback. |

## Dev dependencies

| Component | Version | Licence | Used for |
|---|---|---|---|
| `@types/node` | `26.1.1` | MIT | Node.js type definitions; build-only. |
| `vitest` | `4.1.11` | MIT | Test runner; test-only. |

## What we wrote instead of reusing (ADR-0176 rule 4)

- **`GuardedAzureHttpClient`** (`src/transport.ts`): `@azure/core-rest-pipeline` exports no
  fetch-based `HttpClient` for Node that accepts a custom fetch (`createDefaultHttpClient` is node:https on Node),
  so no published module meets the "every call through `guardedFetch`" requirement.
- **Credential memoisation for AWS** (`memoizeCredentials`, `src/aws.ts`): smithy's `memoize` lives
  under an internal, legacy export path that has moved between minor versions; a stable public equivalent does not
  exist.
- **The STS transporter fix** (`gcpAuthClient`, `src/gcp.ts`): `google-auth-library` 11.3.1 builds the external
  account client's `StsCredentials` without the transporter it was given, so the token exchange would bypass the
  guard. We re-point it and fail closed if the internal shape changes. To be reported upstream.
