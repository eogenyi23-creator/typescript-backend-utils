# Contributing to typescript-backend-utils

First off, thank you for taking the time to contribute! 🎉 

This project aims to provide production-ready, highly isolated TypeScript utilities for Stellar and Soroban backend development. Because this is a toolkit rather than a monolithic framework, we maintain strict architectural standards around modularity, low overhead, and comprehensive test coverage.

Please take a moment to review this document before submitting your first Pull Request.

---

## 🛠️ Local Development Setup

### Prerequisites
- **Node.js** v20 or higher
- **npm** or **pnpm**
- **Redis** running locally (required to run the full integration test suites for `contractCache` and `rpcRateLimiter`)

### Installation & Build
1. Fork the repository on GitHub and clone your fork locally:
   ```bash
   git clone https://github.com
   cd typescript-backend-utils
   ```
2. Install the necessary dependencies:
   ```bash
   npm install
   ```
3. Verify the build pipeline works correctly:
   ```bash
   npm run build
   ```

---

## 🧪 Code Quality Standards

We enforce strict linting, formatting, and unit testing guidelines to keep the codebase stable and reliable.

### Linting & Formatting
Before committing, ensure your code matches our style rules:
```bash
npm run lint
```
*Note: Ensure your editor uses the project's configuration rules (e.g., Prettier/ESLint configs) to prevent formatting conflicts.*

### Automated Testing
Every utility module must be accompanied by robust unit tests. We use **Jest** for our testing framework.
- **Run all tests:**
  ```bash
  npm test
  ```
- **Guidelines for writing tests:**
  - Mock external Stellar RPC or Horizon API endpoints rather than triggering live net calls.
  - Include edge cases for network failures, timeouts, and rate limits (especially for `transactionBatcher` and `rpcRateLimiter`).
  - Maintain a high percentage of test coverage for all new utility code.

---

## 📐 Project Architecture Principles

When adding features or fixing bugs, keep these design boundaries in mind:

1. **Standalone Modularity:** Each module inside `src/` (e.g., `contractCache.ts`, `wasmPipeline.ts`) should operate with minimal dependency on other modules in the SDK. 
2. **Strict Peer Dependencies:** Heavy external libraries (like `ioredis` or `@stellar/stellar-sdk`) must remain as `peerDependencies` rather than core dependencies. The toolkit should not bloat a developer's production bundle if they only use a single module.
3. **No Hidden State:** Ensure components are highly configurable via constructor options or initialization payloads, allowing developers to supply their own server instances or configurations easily.

---

## 🚀 The Pull Request Process

1. **Check Existing Issues:** Before writing code, browse open issues or open a new one to discuss your proposed changes. Look for the `good first issue` label if you are looking for a place to start!
2. **Branch Naming:** Create a focused feature branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```
3. **Keep Commit Messages Clean:** Write clear, concise, and descriptive commit messages.
4. **Submit for Review:** 
   - Open a Pull Request targeting the `main` branch.
   - Describe the problem your PR solves and your implementation strategy.
   - Link the relevant issue number in your description.
5. **CI Pipeline Pass:** Ensure the GitHub Actions automated CI build and test check passes successfully on your PR branch.

---

## 🛡️ Security Vulnerabilities

Please do not report security vulnerabilities via public GitHub issues. Review our [SECURITY.md](SECURITY.md) guidelines for how to securely report vulnerabilities to the maintainers.
