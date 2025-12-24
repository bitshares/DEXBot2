#!/bin/bash
# Clear all persisted order files from profiles/orders directory
#
# This script safely removes all bot order state files while preserving the orders directory.
# Use this to reset bot order grids and start fresh (clears cached order data).
# WARNING: This will lose all persisted grid information. Bots will regenerate grids on next run.
# Usage: ./scripts/clear-orders.sh or bash scripts/clear-orders.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ORDERS_DIR="${PROJECT_ROOT}/profiles/orders"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_info "=========================================="
log_info "DEXBot2 Clear Orders Script"
log_info "=========================================="
log_info "Orders Directory: $ORDERS_DIR"
log_info ""
log_warning "WARNING: This will delete all persisted order state files!"
log_warning "Bots will regenerate their grids on the next run."
log_info ""

# Check if orders directory exists
if [ ! -d "$ORDERS_DIR" ]; then
    log_warning "Orders directory does not exist: $ORDERS_DIR"
    log_info "Nothing to clean"
    exit 0
fi

# Count order files
FILE_COUNT=$(find "$ORDERS_DIR" -type f 2>/dev/null | wc -l)

if [ "$FILE_COUNT" -eq 0 ]; then
    log_info "No order files found in $ORDERS_DIR"
    exit 0
fi

log_info "Found $FILE_COUNT file(s) to delete"
log_info ""

# Show what will be deleted
log_info "Files to be deleted:"
find "$ORDERS_DIR" -type f 2>/dev/null | while read file; do
    SIZE=$(du -h "$file" | cut -f1)
    echo -e "${BLUE}  -${NC} $(basename "$file") ($SIZE)"
done

log_info ""

# Ask for confirmation
read -p "Delete these order files? (y/n): " -r CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    log_warning "Cancelled"
    exit 0
fi

# Delete order files
log_info "Deleting files..."
find "$ORDERS_DIR" -type f 2>/dev/null -delete
DELETE_STATUS=$?

if [ $DELETE_STATUS -eq 0 ]; then
    log_success "Delete operation completed"
else
    log_warning "Delete operation encountered issues (exit code: $DELETE_STATUS)"
fi

# Re-count to confirm
REMAINING=$(find "$ORDERS_DIR" -type f 2>/dev/null | wc -l)

log_info "=========================================="
if [ "$REMAINING" -eq 0 ]; then
    log_success "All order files cleared!"
    log_info "Total deleted: $FILE_COUNT"
    log_info ""
    log_info "Next steps:"
    log_info "- Bots will regenerate their grids on next run"
    log_info "- Start bots normally: pm2 start all (or specific bot name)"
    log_info "- Monitor the startup with: pm2 logs"
else
    log_warning "Cleanup incomplete. Remaining files: $REMAINING"
fi
log_info "=========================================="

exit 0
