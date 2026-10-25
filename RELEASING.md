# Release and verification

Repository: `c9-ventures-ltd/n8n-nodes-quietpass`. Package: `n8n-nodes-quietpass`. Owner: C9 Ventures Ltd. No customer or supplier credentials belong in this repository.

## Release checks

1. Review the source, workflows, examples, documentation, and npm file list. Never publish the private QuietPass backend.
2. Update `package.json` and `CHANGELOG.md` together. Commit the reviewed release to `main`.
3. Require a successful CI run: official n8n lint, build, contract tests, and package packing.
4. Run **Publish QuietPass node** manually from `main`, specifying the exact reviewed version. Leave Publish false for a validation-only run.
5. For the first authorized release, run the same workflow with Publish true and release mode **stage**. It runs the official n8n lint/build checks, contract tests, and package inspection, then uses npm's staged publishing command with provenance. The owner approves that exact staged version in npm using 2FA. A new package may show npm's `0.0.0-stage` placeholder until approval. It never connects to a QuietPass account or runs a live lookup.
6. After configuring and confirming the GitHub Trusted Publisher, release mode **trusted** uses the official n8n release command with provenance. This mode receives no bootstrap token.
7. Verify the published npm version, integrity, repository, maintainer, and provenance. Download and inspect the published package before submitting it to n8n.

## Publishing access

For the first release, use a short-lived granular token without bypass-2FA permission. The owner creates/saves the credential and stores it as encrypted `NPM_TOKEN` in this connector repository only. Give it the minimum permissions and expiry needed. The workflow stages the version; the owner must enable 2FA and approve it on npm. Never read the token or recovery codes into chat or source. The pinned npm version supports staged publishing; the n8n prerelease guard is run in release mode after the official checks pass.

After the first release, configure npm Trusted Publishing:

- Organization/user: `c9-ventures-ltd`
- Repository: `n8n-nodes-quietpass`
- Workflow filename: `publish.yml`
- Hosted GitHub Actions runners only; no environment unless one is explicitly configured.
- Permit the intended publish action; new configurations may default to staged publishing only.

Verify the trust configuration, then revoke the bootstrap npm token and remove its GitHub secret. Do not claim Trusted Publishing is active until npm confirms it. No publishing token belongs in the main QuietPass repository.

## n8n verification

1. Use C9's publisher identity in the [n8n Creator Portal](https://creators.n8n.io/).
2. Submit the actual npm package name and public source URL after publication.
3. Identify QuietPass as the single service integrated. The node calls only `quietpass.com`; it does not expose independent supplier connectors.
4. Provide installation/credential instructions, the five operations, spending/retry behavior, no-runtime-dependency statement, and test evidence. Offer a scoped review credential through a secure channel only if n8n requires it and the account owner authorizes it.
5. Record the submission ID, timestamp, automated findings, and review status. Availability on npm is not approval for n8n Cloud.
6. Submit the inactive workflow templates separately, accurately describing setup, live charges, and destination mapping.

Official requirements checked October 25, 2026:

- https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/
- https://docs.n8n.io/integrations/creating-nodes/build/n8n-node/
- https://docs.npmjs.com/trusted-publishers/

## Rehearsal boundary

Automated tests use the real n8n workflow SDK and controlled HTTP responses. Local engine rehearsals use fictional inputs and a test-only credential with all non-loopback outbound networking blocked. They prove registration, parameter expressions, item linking, quote/execute sequencing, and output mapping without real supplier calls or customer credit use. A paid live rehearsal needs a separately authorized number and spending cap.
