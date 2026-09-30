-- ADR-0130 / AER-004. Approval consumption must observe policy activation
-- atomically. Statement triggers catch both API writes and direct SQL changes.
create table governance_policy_epoch (
  id boolean primary key default true check (id),
  epoch bigint not null default 0
);

insert into governance_policy_epoch (id, epoch) values (true, 0);

create function advance_governance_policy_epoch() returns trigger
language plpgsql as $$
begin
  update governance_policy_epoch set epoch = epoch + 1 where id = true;
  return null;
end;
$$;

create trigger approval_rules_policy_epoch
  after insert or update or delete on approval_rules
  for each statement execute function advance_governance_policy_epoch();

create trigger config_versions_policy_epoch
  after insert or update or delete on config_versions
  for each statement execute function advance_governance_policy_epoch();

create trigger abac_policies_policy_epoch
  after insert or update or delete on abac_policies
  for each statement execute function advance_governance_policy_epoch();

create trigger abac_policy_versions_policy_epoch
  after insert or update or delete on abac_policy_versions
  for each statement execute function advance_governance_policy_epoch();
