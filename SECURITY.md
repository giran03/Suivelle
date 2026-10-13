# Security Policy

Suivelle is a personal project maintained as time allows. Security reports are
welcome, but response times and fixes cannot be guaranteed.

## Supported versions

Security fixes are intended for the latest published release. Older releases
and development builds do not have a separate security maintenance commitment.
If a report concerns an older version, include whether it also affects the
latest release, if you can check safely.

## Reporting a vulnerability

Please report suspected vulnerabilities privately. Do not include exploit
details, sensitive data, or credentials in public issues, discussions, or pull
requests.

Use GitHub's **Report a vulnerability** option on the repository's
[Security tab](https://github.com/giran03/Suivelle/security), if available.
If no private reporting option is available, you may open a public issue asking
how to contact the maintainer privately. Keep that request general and omit
vulnerability details, sample files, and sensitive information.

Include the following where possible:

- The affected Suivelle version, operating system, and installation source.
- A description of the issue and its potential security impact.
- Steps to reproduce it, preferably with a minimal example using synthetic data.
- Relevant logs, screenshots, or sample files with personal information removed.
- Any suggested mitigation or fix.

Do not send your real workspace, backups, tokens, or other private information.
Test only on systems and data you own or have permission to use, and avoid
destructive testing.

## What happens after a report

Reports are reviewed as availability permits, and you may be asked for
additional information. Confirmed issues may result in a fix, a workaround, or
an advisory. Please coordinate public disclosure with the maintainer so users
have an opportunity to protect their data. Reporter credit can be discussed
privately.

There is no guaranteed response or resolution deadline, and no paid bug bounty
is offered.

## Scope

Reports are especially useful for issues involving:

- Unauthorized access to workspace data or local files.
- Imports, exports, archive extraction, or backup restoration that read or write
  outside their intended locations.
- Untrusted content that executes code or crosses the desktop app's permission
  boundaries.
- Update handling that allows an unauthorized application update.

For ordinary bugs or feature requests, use the repository's
[issue tracker](https://github.com/giran03/Suivelle/issues). If you are unsure
whether an issue has security implications, report it privately first.

## Protecting your data

Local-first storage does not by itself protect data from someone or software
with access to your computer. Protect your device and keep independent backups
of important work. Treat imported files and external content as untrusted.

Suivelle is provided "as is" under the [MIT License](LICENSE).
