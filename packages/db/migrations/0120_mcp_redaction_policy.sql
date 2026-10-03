alter table mcp_tools add column input_schema jsonb;

-- Extend the admission generation to the sources of the PII policy snapshot.
create trigger org_settings_policy_epoch
  after insert or update or delete on org_settings
  for each statement execute function advance_governance_policy_epoch();
create trigger compliance_profiles_policy_epoch
  after insert or update or delete on compliance_profiles
  for each statement execute function advance_governance_policy_epoch();
create trigger projects_policy_epoch
  after insert or update or delete on projects
  for each statement execute function advance_governance_policy_epoch();

-- These restrictions govern BOTH the original and transformed argument bags.
-- Do not allow their direct-table writes to race the final admission check.
do $$
declare policy_table text;
begin
  foreach policy_table in array array[
    'data_scope_rules', 'rate_limits', 'guardrail_configs', 'tool_grants',
    'server_grants', 'role_tool_grants', 'role_server_grants',
    'role_assignments', 'team_members', 'revocations'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on %I for each statement execute function advance_governance_policy_epoch()',
      policy_table || '_policy_epoch', policy_table
    );
  end loop;
end;
$$;

-- An unchanged manifest refresh must not invalidate an in-flight admission.
create trigger mcp_tools_update_policy_epoch
  after update on mcp_tools
  for each row when (
    old.input_schema is distinct from new.input_schema or
    old.kind is distinct from new.kind or
    old.halted_at is distinct from new.halted_at
  ) execute function advance_governance_policy_epoch();
create trigger mcp_tools_lifecycle_policy_epoch
  after insert or delete on mcp_tools
  for each row execute function advance_governance_policy_epoch();
