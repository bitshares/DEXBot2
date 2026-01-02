#!/bin/bash

##############################################################################
# DEXBot2 Development Environment Setup
#
# This script installs Jest and development dependencies for contributors
# who want to use the Jest testing framework.
#
# Usage:
#   ./scripts/dev-install.sh
#
# NOTE: This is OPTIONAL and only needed for development/testing
#       End users running the bot do NOT need this
#
# By default, package.json only includes production dependencies:
#   - bs58check (BitShares address encoding)
#   - btsdex (BitShares DEX library)
#   - readline-sync (CLI input)
#
# This script adds development testing infrastructure on top of that.
##############################################################################

set -e  # Exit on any error

echo "=========================================="
echo "DEXBot2 - Development Setup"
echo "=========================================="
echo ""
echo "This script will install Jest and development dependencies."
echo "Installation will be isolated to node_modules/ only."
echo ""

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "ERROR: npm is not installed. Please install Node.js and npm first."
    echo "Visit: https://nodejs.org/"
    exit 1
fi

echo "Current Node.js version: $(node --version)"
echo "Current npm version: $(npm --version)"
echo ""

# Install Jest as a local dev dependency
echo "Installing Jest testing framework..."
npm install --save-dev jest@latest

echo ""
echo "=========================================="
echo "✓ Development environment setup complete!"
echo "=========================================="
echo ""
echo "You can now run:"
echo "  npm run test         - Run all unit tests using Node.js"
echo "  npm run test:unit    - Run Jest tests (unit tests only)"
echo ""
echo "To remove development dependencies later, run:"
echo "  npm prune --production"
echo ""
