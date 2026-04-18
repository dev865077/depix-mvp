# Security Policy

## Supported Versions

This project is an MVP under active development. Security fixes are provided only for the current `main` branch and active deployment environments maintained by the project owner.

| Version / Branch | Supported |
| --- | --- |
| `main` | Yes |
| Active production deployment | Yes |
| Active test deployment | Yes |
| Old branches, forks, local copies, archived releases | No |

## Reporting a Vulnerability

Do not open a public issue, pull request, discussion, or public comment for suspected vulnerabilities.

Report vulnerabilities privately through GitHub Security Advisories:

- https://github.com/dev865077/depix-mvp/security/advisories/new

Reports may be written in Portuguese or English.

Please include:

- affected component, endpoint, workflow, or file
- clear reproduction steps
- expected impact
- proof of concept, if safe to share
- whether any data, token, secret, wallet address, transaction data, or personal data may have been exposed
- your preferred contact for follow-up

## Response Targets

These are targets, not legal guarantees:

| Step | Target |
| --- | --- |
| Initial acknowledgement | up to 3 business days |
| Initial triage | up to 7 business days |
| Status updates for accepted reports | at least every 14 business days |
| Critical fix target | as soon as reasonably possible |

If a report is accepted, we may create a private fix branch, request more details, coordinate disclosure, and publish a security advisory when appropriate.

If a report is declined, we will try to explain why, for example when the issue is out of scope, not reproducible, already known, or not a security vulnerability.

## Responsible Disclosure Rules

To qualify for coordinated disclosure and safe harbor consideration, you must:

- act in good faith
- avoid privacy violations and unnecessary data access
- stop testing immediately if you encounter secrets, tokens, personal data, financial data, wallet data, or transaction data
- report the issue privately as soon as possible
- give us reasonable time to investigate and remediate before public disclosure
- avoid service disruption, degradation, spam, fraud, extortion, persistence, lateral movement, or destructive testing
- avoid social engineering, phishing, physical attacks, employee targeting, or third-party account abuse

## Safe Harbor

We will not intentionally pursue legal action against good-faith security researchers who comply with this policy and do not harm users, systems, data, funds, infrastructure, or third parties.

This safe harbor does not apply to activity involving:

- data theft, data exposure, or unnecessary data access
- unauthorized access beyond what is strictly needed to demonstrate the vulnerability
- modification, deletion, encryption, or exfiltration of data
- malware, backdoors, persistence, credential harvesting, or token abuse
- denial of service or resource exhaustion
- fraud, extortion, threats, or public disclosure before coordination
- violation of applicable law

This policy is not a contract, bounty promise, employment offer, or waiver of rights. It is a coordinated vulnerability disclosure policy intended to guide good-faith reporting.

## Brazil and Global Compliance

Researchers and contributors must follow applicable laws and regulations in their jurisdiction and in Brazil when Brazil is relevant to the system, users, operators, data, or infrastructure.

For Brazil, this includes respecting privacy, confidentiality, and computer misuse rules, including where applicable:

- LGPD, Lei Geral de Protecao de Dados Pessoais, Law No. 13.709/2018
- Marco Civil da Internet, Law No. 12.965/2014
- Brazilian criminal law provisions related to unauthorized access, misuse, fraud, or damage

Do not collect, process, retain, transfer, publish, or expose personal data unless strictly necessary to demonstrate the vulnerability safely. If personal data is encountered, stop testing and report immediately.

## Scope

In scope:

- this repository
- project GitHub Actions and automation code
- Cloudflare Worker application code in this repository
- D1 schema and repository logic
- webhook handling paths for Telegram and Eulen
- documented operational scripts and workflows maintained in this repository

Out of scope:

- third-party services not controlled by this project
- GitHub, Cloudflare, Telegram, Eulen, OpenAI, or other vendor platform vulnerabilities
- social engineering
- physical attacks
- denial of service
- spam, phishing, fraud, or financial abuse simulations
- vulnerabilities requiring leaked credentials, compromised accounts, or prior unauthorized access
- findings only affecting unsupported branches, forks, or local developer machines

## Secrets and Sensitive Data

Never include real secrets, tokens, private keys, credentials, wallet seeds, production customer data, or unnecessary personal data in reports, issues, commits, screenshots, logs, or pull requests.

If a secret is exposed:

- report privately immediately
- do not use it
- do not test it further
- do not share it publicly

The project may rotate secrets, revoke tokens, invalidate sessions, notify affected parties, or take other containment actions.

## Disclosure

Public disclosure must be coordinated with the project owner. We may delay disclosure when required to protect users, rotate secrets, patch infrastructure, comply with legal obligations, or coordinate with affected vendors.

Credit may be provided when requested and when doing so is safe and lawful.

## No Bug Bounty

This project does not currently operate a paid bug bounty program. Submitting a report does not create any right to compensation.

