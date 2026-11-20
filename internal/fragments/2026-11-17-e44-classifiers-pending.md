<!-- fold: pending -->
- **E44 follow-up (ADR-0363 slice 2): classifiers on the browser and endpoint rules, and redaction.** Customer
  classifiers run at every gateway guardrail site (block, warn, log). Sharing them with the browser extension (E16) and
  the endpoint hooks needs a signed distribution of the compiled set (regex, keyword and dictionary only: EDM digests
  stay server side). A `redact` verb would reuse the ADR-0140 span-union redactor once the guardrail engine gains one.
  The classifier editor and review screen are on #453.
