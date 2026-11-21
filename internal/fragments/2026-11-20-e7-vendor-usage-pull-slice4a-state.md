<!-- fold: state-recap -->

**2026-11-20 - ADR-0322 slice 4a: AWS Bedrock spend from CUR 2.0 for the vendor usage pull (builder lane E7).**
A new `aws_cur` connector reads a Data Exports (CUR 2.0) gzip-CSV export from S3, read-only, through the guarded
fetch, keeps Bedrock lines (unblended cost, every line type) and sums them per day, account and IAM principal.
Credentials are the federated role (RegulAIt's federation token, refused while federation is off) or a static key
with its own acknowledgement; both need the unverified-scope attestation. Each pull replaces the months it re-reads,
withdrawing lines AWS removed. Principals resolve through admin aliases only. Owner decisions 2026-11-20 in the ADR;
no route, migration or dependency added. Codex analytics is slice 4b.
