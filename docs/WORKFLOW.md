# Branch Workflow: test → dev → main

This document describes the branch strategy for DEXBot2 development.

## Branch Hierarchy

```
feature branches
       ↓
    test (testing/staging branch)
       ↓
    dev (active development integration)
       ↓
    main (stable/production releases)
```

## Branch Purposes

- **test**: Staging branch for feature testing before integration
- **dev**: Active development branch where features are integrated
- **main**: Stable, production-ready branch
- **feature/\***: Feature branches for specific features/fixes

## Workflow

### 1. Creating a Feature

```bash
# Start from test (latest testing branch)
git checkout test
git pull origin test

# Create feature branch
git checkout -b feature/my-feature test
```

### 2. Working on a Feature

```bash
# Make your changes, commit as normal
git add .
git commit -m "feat: describe your feature"

# Push to remote when ready for review
git push -u origin feature/my-feature
```

### 3. Testing & Integration

```bash
# When ready for testing, create PR: feature/my-feature → test
# After review and testing passes:
git checkout test
git pull origin test
git merge --no-ff feature/my-feature
git push origin test

# Delete feature branch after merging
git branch -D feature/my-feature
git push origin --delete feature/my-feature
```

### 4. Merging to Dev

```bash
# After test branch is validated and tested
git checkout dev
git pull origin dev
git merge --no-ff test
git push origin dev
```

### 5. Releasing to Main

```bash
# When code is stable and ready for production
git checkout main
git pull origin main
git merge --no-ff dev
git push origin main

# Tag releases
git tag -a v0.X.Y -m "Release version 0.X.Y"
git push origin v0.X.Y
```

## Current Branch Status

| Branch | Commit | Remote Sync |
|--------|--------|-------------|
| test | 739e6d1 | ✓ (synced with origin/test) |
| dev | 739e6d1 | ✓ (synced with origin/dev) |
| main | 739e6d1 | Local is ahead of origin/main |

**Note**: Local main is ahead because it was synced with dev. When ready to release, push main to origin.

## Key Rules

- Always pull before creating a feature branch
- Use `--no-ff` flag for merge commits to maintain history
- Never force push to test, dev, or main
- Always use feature branches for new work
- Code review should happen on feature → test PRs
- Integration testing happens on test branch
- Only merge to dev after test validation
- Only merge to main for releases

## Commands Summary

```bash
# Setup
git checkout test
git pull origin test

# Feature work
git checkout -b feature/xyz test
# ... make changes ...
git push -u origin feature/xyz
# ... create PR, get review ...

# Merge to test
git checkout test && git pull && git merge --no-ff feature/xyz && git push origin test

# Merge test to dev
git checkout dev && git pull && git merge --no-ff test && git push origin dev

# Merge dev to main (releases only)
git checkout main && git pull && git merge --no-ff dev && git push origin main
```
