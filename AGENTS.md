# Project AGENTS.md

These rules apply to every file, commit, push, tag, release, pull request, and uploaded artifact in this repository. They are mandatory for humans and automated agents.

## Public-repository privacy and credential rules

- Treat this repository and every GitHub artifact as public.
- Never commit, push, tag, release, paste into an issue, or upload any real API key, access token, password, cookie, session identifier, private key, authorization header, webhook secret, or other credential.
- Never upload personal or machine-specific data, including real Obsidian Vault contents, Zotero libraries or databases, paper annotations, chat/session exports, absolute user-profile or OneDrive paths, usernames, personal email addresses, logs containing request headers, screenshots containing secrets, or local preference files populated with real values.
- Examples and tests must use unmistakably fake placeholders such as `YOUR_API_KEY`, `EXAMPLE_PROVIDER_KEY`, and `C:\\Users\\Example\\ObsidianVault`. A placeholder must never be usable as a real credential.
- API keys must remain in Zotero's secure credential storage at runtime. Do not add fallback code that writes credentials to `prefs.js`, Markdown, logs, crash reports, exported sessions, or the repository.
- Keep secret-bearing and machine-local files excluded through `.gitignore`. Do not force-add an ignored file without first proving that it contains no private data.

## Mandatory checks before GitHub operations

Before every commit and again before every push, tag, release, or artifact upload:

1. Review `git status --short` and the full staged diff with `git diff --cached --check` and `git diff --cached`.
2. Run `npm run security`. A failure blocks the GitHub operation; do not bypass, weaken, or skip the scanner to make it pass.
3. Confirm that generated XPI files contain no credentials, personal paths, personal email addresses, Vault runtime data, or local configuration.
4. For a release, run `npm test` and `npm run validate` in addition to the security scan. The release workflow must keep a security scan both before and after packaging.
5. Upload only the files intentionally listed for the release. Do not upload working directories, `.env` files, logs, temporary files, caches, databases, screenshots, or Vault folders.

## Stop conditions and incident handling

- If any staged file or artifact may contain private data, stop before the network operation, remove or sanitize it, and rerun every mandatory check.
- If a real credential may already have reached GitHub, do not merely delete it in a later commit. Stop publishing, inform the user, revoke or rotate the credential, and clean the Git history and release artifacts before continuing.
- Never print or quote a discovered secret in terminal output, commit messages, review comments, or chat. Refer to it only by file and secret type, with the value redacted.
- When uncertain whether data is private, treat it as private and ask the user before publishing.
