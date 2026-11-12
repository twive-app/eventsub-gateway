# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions or pull requests.**

Use GitHub's private vulnerability reporting instead:
[**Report a vulnerability**](https://github.com/twive-app/eventsub-gateway/security/advisories/new) (Security tab →
Advisories → Report a vulnerability). Only the maintainers can see your report.

Please include as much of the following as you can:

- the affected version (image tag or `gateway --version`) and how you run it (Docker image, compose, release binary,
  from source)
- a description of the issue and its impact
- steps to reproduce or a proof of concept
- any logs – with client secrets, access tokens and `TWITCH_WEBHOOK_SECRET` removed

## Supported versions

| Version | Supported |
|---|---|
| latest release (`vX.Y.Z`) and the `latest` image | ✅ |
| prereleases (`vX.Y.Z-alpha.N`, `-beta.N`, `-rc.N`) | best effort |
| `dev` image and branch (development builds) | best effort |
| older releases | ❌ – please update to the latest release |

## Scope

Examples of what we consider a vulnerability:

- bypassing the verification of Twitch webhook signatures (HMAC) or the replay protection
- bypassing the authentication of IDENTIFY or RESUME (client id + secret), or the connection and authentication
  limits
- spoofing the client address through `X-Forwarded-For` without a matching `TRUSTED_PROXIES` entry
- using the gateway to send requests to Twitch on a scale that gets the server throttled (e.g. token requests with
  wrong credentials)
- receiving sessions, events or other data of another application
- client secrets, access tokens or the webhook secret leaking into logs, Redis or responses
- denial of service through the gateway (e.g. a single client that exhausts memory or CPU)

Not in scope:

- issues in Twitch itself (EventSub, Helix, OAuth) – report them to
  [Twitch](https://www.twitch.tv/p/legal/security/)
- missing hardening of your own deployment (Redis without password or exposed to the internet, no TLS in front of the
  gateway, leaked `.env` files, …)
- vulnerabilities in dependencies without a way to exploit them through the gateway

## What happens next

This is a small project maintained in our spare time, so we can't promise fixed response times. On a best-effort basis
we will:

1. confirm that we received your report,
2. investigate it and work on a fix (we may ask you for more details),
3. release the fix and publish a [security advisory](https://github.com/twive-app/eventsub-gateway/security/advisories),
4. credit you in the advisory – unless you prefer to stay anonymous.

Please give us a reasonable amount of time to release a fix before you disclose the issue publicly.
