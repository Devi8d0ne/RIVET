# Security policy

RIVET handles private stream keys, signed upload URLs, local recordings, cameras, and microphones. Do not post those values or private media in a public issue.

For a suspected vulnerability, use GitHub's private vulnerability reporting for this repository. Include affected versions, reproduction steps, impact, and a minimal test case that contains no real credentials or private recordings.

The local service is intentionally bound to `127.0.0.1`. Changes that expose it to a LAN or the internet require a separate authentication and threat-model review.
