# Contributing to Strumm

Thank you for your interest in contributing to Strumm! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating, you agree to maintain a respectful, inclusive environment for everyone.

## How to Contribute

### Reporting Bugs

1. Check the [existing issues](https://github.com/strumm/strumm/issues) first
2. If not found, [open a new issue](https://github.com/strumm/strumm/issues/new)
3. Include steps to reproduce, expected behavior, actual behavior, and environment details
4. For security vulnerabilities, see [SECURITY.md](SECURITY.md)

### Suggesting Features

1. Check the [Roadmap](https://strumm.me/roadmap) to see if it is already planned
2. Open a feature request issue on GitHub or email feedback@strumm.me
3. Describe the feature, use case, and any implementation ideas

### Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes following the code style
4. Run typechecks and linting
5. Commit with clear, descriptive messages
6. Push and open a pull request to `master`

## Development Setup

See [Getting Started Guide](https://strumm.me/docs) or `README.md` for setup instructions.

## Code Style

- **TypeScript**: Strict mode, no `any` types where possible
- **Python**: Follow PEP 8, type annotations for all functions
- **React**: Use functional components with hooks, avoid class components
- **CSS**: Use Tailwind utility classes, avoid custom CSS where possible
- **Imports**: Group by external → internal, sort alphabetically within groups

## Architecture

- **Monorepo**: Turborepo with pnpm workspaces
- **Frontend**: Next.js 15 (App Router, React 19)
- **Backend**: FastAPI (Python 3.11)
- **Database**: MongoDB (Motor async driver)
- **Auth**: JWT tokens + Google OAuth

## Testing

- Run TypeScript typecheck: `cd apps/web && npx tsc --noEmit`
- Run linting: `pnpm lint`
- Test backend: `cd apps/api && python -m pytest`

## Release Process

1. Changes accumulate on `master`
2. When ready, a maintainer creates a release with version bump
3. Changelog is updated
4. CI builds and deploys to production
