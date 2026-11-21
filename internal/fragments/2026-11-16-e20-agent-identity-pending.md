<!-- fold: pending -->

- **Agent identity follow-ups (ADR-0339 slice 2, lane E20).**
  - Once the vendor registry import (PR #855) merges: write `vendor_record` authorship with the vendor creator's
    pseudonym, and stage the vendor identity it read (Entra Agent ID object id, AgentCore runtime ARN, Gemini agent
    resource name) as an `importer` link.
  - Owner question: make the 90-day inactive-owner window an org setting (strict default kept).
