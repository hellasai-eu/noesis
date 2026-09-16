#!/bin/bash

# Local development startup script
# Starts Supabase, Edge Functions, and Vite dev server

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting local development environment...${NC}"

# Function to cleanup background processes on exit
cleanup() {
    echo -e "\n${YELLOW}Shutting down...${NC}"
    kill $(jobs -p) 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

# Check if Supabase is already running
if ! supabase status > /dev/null 2>&1; then
    echo -e "${YELLOW}Starting Supabase...${NC}"
    supabase start
    # Seed file (supabase/seed.sql) runs automatically on first start
else
    echo -e "${GREEN}Supabase already running${NC}"
fi

# Start edge functions in background (--no-verify-jwt for local dev)
echo -e "${YELLOW}Starting Edge Functions...${NC}"
supabase functions serve --env-file supabase/.env.local --no-verify-jwt &
FUNCTIONS_PID=$!

# Wait a moment for functions to start
sleep 2

# Start Vite dev server in foreground
echo -e "${YELLOW}Starting Vite dev server...${NC}"
npm run dev &
VITE_PID=$!

echo -e "${GREEN}All services started!${NC}"
echo -e "  - Supabase: http://127.0.0.1:54321"
echo -e "  - Edge Functions: http://127.0.0.1:54321/functions/v1/"
echo -e "  - Frontend: http://localhost:5173"
echo -e ""
echo -e "${GREEN}E2E test users seeded:${NC}"
echo -e "  - Student:     e2e-student@test.local     / testpass123"
echo -e "  - Instructor:  e2e-instructor@test.local  / testpass123"
echo -e "  - Admin:       e2e-admin@test.local       / testpass123"
echo -e "  - Super Admin: e2e-superadmin@test.local  / testpass123"
echo -e ""
echo -e "\nPress Ctrl+C to stop all services"

# Wait for any process to exit
wait
