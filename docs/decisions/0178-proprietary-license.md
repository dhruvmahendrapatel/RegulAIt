# ADR-0178: RegulAIt is proprietary: all rights reserved

- **Status**: Accepted (owner, 2026-10-05: "add the most restrictive license on our public github repository, so that no
  one can just copy regulAIt and start using it")
- **Date**: 2026-10-05

## Context

The repository is public on GitHub and had no licence file. With no licence, copyright law already reserves every right to
the author, but nothing in the repository said so. Package manifests said only `"private": true`, which stops accidental
npm publishing and grants nothing.

## Decision

1. **The most restrictive licence is no grant at all.** RegulAIt is proprietary, all rights reserved. A root `LICENSE`
   states that the repository is published for viewing only. Without prior written permission, nobody may:
   - copy, modify, run or deploy RegulAIt;
   - offer it as a service;
   - distribute it;
   - use it to build or train a competing product.
   It also covers trademarks, contributions and the status of third-party material. Any open-source licence, even a
   restrictive one such as AGPL, or a source-available one such as BSL or ELv2, would grant rights we don't want to grant,
   so none was chosen.
2. **Every package manifest says `"license": "UNLICENSED"`.** This is npm's term for "not licensed for use by others".
   It is not the public-domain Unlicense.
3. **Third-party code keeps its own licences.** Our licence covers only our own work. The dependencies we ship stay under
   their own licences and are listed in the `THIRD_PARTY.md` files, the manifests and the lockfile. Those licences
   (MIT, Apache-2.0 and the like) are compatible with a proprietary product, which is why ADR-0176 admits only permissive
   licences.

## Limits (stated plainly)

- A licence is a legal right, not a technical barrier. While the repository is public, anyone can still read it.
  GitHub's Terms of Service also let GitHub users view and fork public repositories on GitHub. What the licence does is
  remove any permission to use, copy or build on the code, which makes copying enforceable.
- **Making the repository private is the only thing that actually stops copying.** That is the owner's call (a GitHub
  setting). It would also affect public CI minutes and the GHCR image visibility.
- The copyright holder is named by GitHub account. Replace that with the owner's legal name or company once one exists.
  Have a lawyer review the text before any commercial use.
