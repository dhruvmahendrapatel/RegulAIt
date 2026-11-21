<!-- fold: state-recap -->

**2026-11-21 - ADR-0322 slice 4c: AWS principal mode and Parquet for the vendor usage pull (builder lane E7).**
The `aws_cur` connector gains a third credential mode: RegulAIt's own AWS principal assumes the customer's role with
a RegulAIt-generated external id, which is shown to the admin, kept across changes and never accepted from a request.
CUR 2.0 Parquet exports (Snappy, as AWS writes them) are now read in-process with `hyparquet` 1.33.1 (MIT), bounded
by the file footer before any decoding, through the same normaliser as CSV. No route or migration added. Built on
a pushed branch based on the slice 4b branch; its PR opens after #1116 merges (owner rule, 2026-11-21).
