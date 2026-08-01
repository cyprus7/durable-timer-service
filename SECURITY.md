# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's **Security** tab by opening a private vulnerability report. Do not disclose exploitable details in a public issue.

Include the affected version or commit, reproduction steps, expected impact, and any suggested mitigation. You can expect an acknowledgement after the report is reviewed.

## Deployment guidance

- Use a long, randomly generated `API_TOKEN` and rotate it through your secret manager.
- Keep PostgreSQL and callback targets on trusted networks.
- Restrict the health and metrics endpoints at the network perimeter when necessary.
- Treat `TIMER_TARGETS` as trusted operator configuration because it controls outbound requests.
- Do not enable `ALLOW_INSECURE_NO_AUTH` outside an isolated local environment.
