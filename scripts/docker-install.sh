#!/usr/bin/env bash
# grouter — one-shot Docker installer.
#
# Builds the image, starts the stack, and prints the URLs you need.
# Re-run any time to rebuild + restart. Safe: data lives in ./data.

set -euo pipefail

BOLD="\033[1m"; DIM="\033[2m"
GREEN="\033[32m"; CYAN="\033[36m"; YELLOW="\033[33m"; RED="\033[31m"; GRAY="\033[90m"
RESET="\033[0m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo -e "  ${BOLD}${CYAN}grouter${RESET} — docker installer"
echo -e "  ${GRAY}─────────────────────────────────────────${RESET}"

# ── Docker present? ──────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo -e "  ${RED}✗${RESET}  docker not found. Install from https://docs.docker.com/get-docker/"
  exit 1
fi

# Prefer v2 compose plugin; fall back to docker-compose v1 if present.
if docker compose version &>/dev/null; then
  COMPOSE=(docker compose)
elif command -v docker-compose &>/dev/null; then
  COMPOSE=(docker-compose)
else
  echo -e "  ${RED}✗${RESET}  docker compose plugin not found."
  echo -e "  ${GRAY}   Install: https://docs.docker.com/compose/install/${RESET}"
  exit 1
fi
echo -e "  ${GRAY}docker${RESET}  ${GREEN}✓${RESET} ${GRAY}$(docker --version | awk '{print $3}' | sed 's/,$//')${RESET}"

# ── Data dir on host ─────────────────────────────────────────────────────────
mkdir -p ./data
echo -e "  ${GRAY}data${RESET}    ${GREEN}✓${RESET} ${GRAY}./data (persists across rebuilds)${RESET}"

# ── Build + (re)start ────────────────────────────────────────────────────────
echo -e "  ${GRAY}build${RESET}   ${CYAN}…${RESET} building image"
"${COMPOSE[@]}" build --pull 2>&1 | tail -n 3 | sed 's/^/          /'

echo -e "  ${GRAY}up${RESET}      ${CYAN}…${RESET} starting container"
"${COMPOSE[@]}" up -d 2>&1 | sed 's/^/          /'

# ── Wait for /health ─────────────────────────────────────────────────────────
echo -ne "  ${GRAY}health${RESET}  ${CYAN}…${RESET} waiting for proxy"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3099/health >/dev/null 2>&1; then
    echo -e "\r  ${GRAY}health${RESET}  ${GREEN}✓${RESET} ${GRAY}proxy is up              ${RESET}"
    break
  fi
  sleep 1
  [ "$i" -eq 30 ] && echo -e "\r  ${YELLOW}⚠${RESET}  proxy not responding yet — check: docker compose logs -f grouter"
done

# ── Done ─────────────────────────────────────────────────────────────────────
echo -e "  ${GRAY}─────────────────────────────────────────${RESET}"
echo -e "  ${GREEN}✓${RESET} ${BOLD}grouter is running${RESET}"
echo ""
echo -e "  ${BOLD}Endpoints${RESET}"
echo -e "    ${GRAY}dashboard${RESET}  ${CYAN}http://localhost:3099/dashboard${RESET}"
echo -e "    ${GRAY}openai api${RESET} ${CYAN}http://localhost:3099/v1${RESET}"
echo -e "    ${GRAY}health${RESET}     ${CYAN}http://localhost:3099/health${RESET}"
echo ""
echo -e "  ${BOLD}Next steps${RESET}"
echo -e "    ${CYAN}docker compose exec grouter grouter add${RESET}   ${GRAY}# add a provider (interactive)${RESET}"
echo -e "    ${CYAN}docker compose exec grouter grouter list${RESET}  ${GRAY}# list connections${RESET}"
echo -e "    ${CYAN}docker compose logs -f grouter${RESET}            ${GRAY}# tail logs${RESET}"
echo -e "    ${CYAN}docker compose down${RESET}                       ${GRAY}# stop (data persists)${RESET}"
echo ""
