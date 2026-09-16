#!/bin/bash
# Sync local database migrations
# Usage: ./scripts/sync_localdb.sh [--run]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Database Migration Sync ===${NC}"
echo ""

if [[ "$1" == "--run" ]]; then
    echo -e "${YELLOW}Applying migrations...${NC}"
    echo ""
    supabase migration up

    echo ""
    echo -e "${GREEN}Migrations applied successfully.${NC}"
    echo ""
    echo -e "${YELLOW}Regenerating TypeScript types...${NC}"
    supabase gen types typescript --local > src/integrations/supabase/types.ts
    echo -e "${GREEN}Types regenerated.${NC}"
else
    echo -e "${YELLOW}DRY RUN - Showing pending migrations:${NC}"
    echo ""
    supabase migration list

    echo ""
    echo -e "${YELLOW}To apply migrations, run:${NC}"
    echo -e "  ${GREEN}./scripts/sync_localdb.sh --run${NC}"
fi
