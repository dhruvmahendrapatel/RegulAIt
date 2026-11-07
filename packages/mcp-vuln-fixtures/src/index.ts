/**
 * @regulait/mcp-vuln-fixtures — TEST ONLY (ADR-0246). Deliberately vulnerable MCP servers for CI. Never shipped:
 * `.dockerignore` keeps the package out of the image and every consumer takes it as a devDependency.
 */
export {
  fakeAwsAccessKeyId,
  fakePrivateKeyBlock,
  listedTools,
  manifestFor,
  MCP_ATTACK_CLASSES,
  MCP_VULN_FIXTURES,
  vulnFixture,
  type FixtureManifest,
  type FixturePrompt,
  type FixtureResource,
  type FixtureTool,
  type McpAttackClass,
  type VulnerableMcpFixture,
} from "./fixtures.js";
export { createFixtureServer, fixtureState, pull, serveFixtureOverHttp, type FixtureState, type ServedFixture } from "./server.js";
