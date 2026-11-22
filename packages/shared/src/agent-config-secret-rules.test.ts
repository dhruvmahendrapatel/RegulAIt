/**
 * ADR-0336 slice 4 (#1130 R9 [1], S9 [2]): the vendored rules reported as plaintext credentials in an agent's
 * configuration, pinned. A refresh of the vendored pack that adds, removes or renames a rule fails this test until
 * someone decides whether the rule is a credential (keep it here) or personal data / a public identifier (add it to
 * AGENT_CONFIG_SECRET_RULES_EXCLUDED).
 */
import { describe, expect, it } from "vitest";
import { AGENT_CONFIG_SECRET_RULES_EXCLUDED, VENDORED_SECRET_RULES, agentConfigSecretRuleAllowed, agentConfigSecretRuleIds } from "./index.js";

const CREDENTIAL_RULES = ["answer_engine_api_key","anthropic_api_key","aws_secret_key","azure_sas_token","azure_storage_account_key","databricks_token","digitalocean_token","discord_bot_token","environment_variable_secret","ethereum_private_key","extended_private_key","fireworks_api_key","gcp_service_account_key","gcp_service_account_private_key_id","github_fine_grained_pat","github_token","gitlab_ci_job_token","gitlab_deploy_token","gitlab_oauth_application_secret","gitlab_pat","gitlab_pipeline_trigger_token","gitlab_runner_token","gitlab_scim_token","gitlab_service_token","google_api_key","google_oauth_client_secret","google_oauth_token","groq_api_key","hashicorp_vault_token","hugging_face_token","jwt_token","linear_api_key","llm_router_api_key","mailgun_api_key","mongodb_connection_string","mysql_connection_string","new_relic_api_key","notion_api_key","npm_token","openai_api_key","openai_service_key","pinecone_api_key","postgresql_connection_string","private_key_header","pypi_token","redis_connection_string","replicate_api_token","sendgrid_api_key","sentry_auth_token","slack_app_token","slack_token","stripe_key","stripe_webhook_secret","supabase_service_key","together_ai_key","twilio_api_key","vercel_token","web_research_api_key","xai_api_key"];

describe("ADR-0336 slice 4: the credential rules for agent configurations", () => {
  it("are exactly the pinned credential rules", () => {
    expect(agentConfigSecretRuleIds()).toEqual(CREDENTIAL_RULES.map((r) => `pipelock.secrets.${r}`));
  });

  it("every vendored rule is either a pinned credential rule or explicitly excluded", () => {
    for (const r of VENDORED_SECRET_RULES) {
      expect(agentConfigSecretRuleAllowed(r.id) || AGENT_CONFIG_SECRET_RULES_EXCLUDED.includes(r.id), r.id).toBe(true);
    }
  });

  it("personal, financial and public-identifier rules are never credentials", () => {
    for (const id of ["social_security_number", "google_oauth_client_id", "credit_card_number", "iban", "ethereum_address"]) {
      expect(agentConfigSecretRuleAllowed(`pipelock.secrets.${id}`), id).toBe(false);
      expect(AGENT_CONFIG_SECRET_RULES_EXCLUDED).toContain(`pipelock.secrets.${id}`);
    }
  });
});
