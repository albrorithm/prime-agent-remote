# Security

This project is an authenticated HTTPS gateway in front of a local coding agent with real local capabilities. If you have found a problem with how it protects that boundary, please report it privately.

## Scope

In scope:

- the web gateway and its session/authentication handling;
- the WebSocket and HTTP APIs exposed to the browser;
- the trust boundary between the browser and the daemon clients the gateway owns;
- push subscription storage, payload content, and revocation;
- CSP, origin, rate-limit, and input-validation controls.

Out of scope:

- Prime Agent itself, including its daemon, model, extensions, prompts, skills, and local capabilities;
- Tailscale, your reverse proxy, operating system, or browser;
- deployments that disable or bypass the documented authentication requirements.

## How to report

Use GitHub private vulnerability reporting at [github.com/albrorithm/prime-agent-remote](https://github.com/albrorithm/prime-agent-remote/security/advisories/new) rather than opening a public issue.

Include:

- a short description of the vulnerability;
- the component it affects (gateway, authentication, push, etc.);
- steps to reproduce, or enough detail for us to reproduce it;
- the impact you believe it has;
- any suggested mitigation, if you have one.

## Response

We will acknowledge receipt within 5 business days. After we validate the report we will work with you on a coordinated disclosure timeline, typically after a fix is released. We will not take legal action against researchers who follow this process in good faith.
