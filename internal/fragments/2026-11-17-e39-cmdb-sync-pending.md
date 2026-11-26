<!-- fold: pending -->
- **E39 CMDB sync follow-ups (ADR-0358).** (a) The CMDB connector screen for the nine `/v1/cmdb/*` routes (#453); remove
  the affordance-census exemption for the credential DELETE when it lands. (b) Apply a CMDB-reported owner to a RegulAIt
  agent as an explicit, audited admin act per item (today it is recorded only). (c) OAuth client-credentials auth for
  ServiceNow. (d) A live test against a ServiceNow developer instance (owner-gated, lane E11). (e) A second adapter
  (NetBox, Apache-2.0) if a customer asks.
