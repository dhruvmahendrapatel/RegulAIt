-- Direct SQL and API changes invalidate the same connector admission snapshot.
do $$
declare policy_table text;
begin
  foreach policy_table in array array[
    'connectors', 'connector_credentials', 'connector_grants',
    'role_connector_grants', 'connector_revocations', 'project_members',
    'egress_allow_hosts'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on %I for each statement execute function advance_governance_policy_epoch()',
      policy_table || '_policy_epoch', policy_table
    );
  end loop;
end;
$$;
