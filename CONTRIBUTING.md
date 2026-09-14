# Contributing to typescript-backend-utils

Thank you for taking the time to contribute! This project provides production-ready TypeScript building blocks for Stellar and Soroban backend development. We welcome bug fixes, documentation improvements, test coverage expansions, and new utility modules.

---

## 🛠️ Local Development Setup

### Prerequisites
* **Node.js:** Version 20 or higher.
* **Redis (Optional):** Required locally if you want to run the full test suite for the `contractCache` and `rpcRateLimiter` modules.

### Installation
1. Fork the repository on GitHub, then clone your fork locally:
   ```bash
   git clone https://github.com
   cd typescript-backend-utils
   ```
2. Install the workspace dependencies:
   ```bash
   npm install
   ```

---

## 🚀 Development Workflow

Before submitting a pull request, ensure your code passes our compilation, testing, and styling checks:

### 1. Build Verification
Confirm that your TypeScript changes compile successfully without any configuration errors:
```bash
npm run build
```

### 2. Running Tests
We require high test coverage for all standalone modules. Run the existing Jest test suite to verify your changes haven't introduced regressions:
```bash
npm test
```

### 3. Code Linting & Formatting
Enforce codebase uniformity by running the linter before staging your commits:
```bash
npm run lint
```

---

## 📥 Pull Request (PR) Guidelines

To help us review and merge your changes efficiently, please follow these steps:

* **Branching Strategy:** Always base your feature or fix branch off the `main` branch. Use clear, descriptive branch names (e.g., `fix/rate-limiter-leak` or `feat/new-horizon-filter`).
* **Atomic Submissions:** Keep pull requests focused on a single issue or feature. Avoid mixing unrelated bug fixes, dependency updates, or major refactors into one PR.
* **Testing Requirements:** If you are adding a new utility module to `src/` or modifying existing logic, you must include matching unit tests in the `tests/` directory.
* **Documentation:** Update the root `README.md` file if your changes alter a module's public API configuration or installation steps.
* **Link the Issue:** Include `Closes #XYZ` in your PR description (replacing XYZ with the issue number) so the tracking issue closes automatically when your code is merged.

---
