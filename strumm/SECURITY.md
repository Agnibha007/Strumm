# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.0.x   | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

We take the security of Strumm seriously. If you believe you have found a security vulnerability, please report it to us as described below.

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, please send details to **security@strumm.me**.

You should receive a response within 24 hours. If you do not receive a response, please follow up to ensure we received your original message.

### What to Include

To help us understand and reproduce the issue, please include:

- Type of vulnerability
- Full paths of source files related to the issue
- Steps to reproduce
- Proof-of-concept or exploit code (if applicable)
- Impact of the vulnerability

### What to Expect

- We will acknowledge receipt within 24 hours
- We will investigate and provide an estimated timeline for a fix
- We will release a patch as soon as possible (typically within 7 days for critical issues)
- We will credit the reporter in release notes (if desired)

## Security Measures

- **Authentication**: JWT tokens with bcrypt-hashed passwords, optional Google OAuth
- **Session Management**: httpOnly, Secure, SameSite=None cookies for tokens
- **Data Storage**: Passwords hashed with bcrypt, never stored in plaintext
- **Transport**: All traffic served over HTTPS
- **API Security**: CORS restricted to trusted origins, rate limiting enforced
- **Input Validation**: All user inputs sanitized, YouTube IDs validated against strict patterns
- **Dependencies**: Regular updates via Dependabot, security patches applied promptly
- **Monitoring**: Request logging with rate limit tracking

## Responsible Disclosure

We believe in responsible disclosure. We request that you:

1. Notify us privately before disclosing any vulnerability publicly
2. Give us reasonable time to address the issue before disclosure
3. Do not exploit the vulnerability beyond what is necessary to demonstrate it

Thank you for helping keep Strumm and its users safe.
