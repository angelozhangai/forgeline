#!/bin/sh
# Deploy forgeline Cloud to one environment: check, migrate D1, deploy the Worker.
#
#   CLOUDFLARE_ACCOUNT_ID=<32 hex> CLOUDFLARE_API_TOKEN=<token> tools/deploy.sh dev|prod
#
# Why this script instead of a bare `wrangler deploy`:
#  * The account is never in wrangler.jsonc (the repository is public), so it has to come from somewhere at
#    deploy time -- and "somewhere" must never be a default. With `wrangler login`, an OAuth session reaches every
#    account the human can, and wrangler quietly uses the only one or the one it last picked. D8 says the cloud
#    lives in a dedicated account, never inside a product's infrastructure; so this script refuses to run without
#    an explicit CLOUDFLARE_ACCOUNT_ID and an API token (create the token scoped to that one account -- then even a
#    wrong id cannot reach anything else).
#  * The D1 schema must be in place before the code that relies on it, so migrations run first.
#  * Nothing is deployed that has not passed typecheck, the workerd tests and a dry-run build on this checkout.
#
# D1 databases are found by name (`database_name` in wrangler.jsonc); wrangler looks the id up in the account.
# Create them once, without letting wrangler write the id back into the tracked config:
#   npx wrangler d1 create forgeline-dev --update-config=false
set -eu

cd "$(dirname "$0")/.."

target="${1:-}"
case "$target" in
  dev | prod) ;;
  *)
    echo "usage: tools/deploy.sh dev|prod" >&2
    exit 2
    ;;
esac

account="${CLOUDFLARE_ACCOUNT_ID:-}"
if [ -z "$account" ]; then
  echo "CLOUDFLARE_ACCOUNT_ID is not set. Set it to the dedicated forgeline account's id (never a product account); see cloud/README.md." >&2
  exit 1
fi
# A Cloudflare account id is 32 lowercase hex characters. Anything else is a paste error, caught before wrangler
# turns it into a confusing API failure halfway through.
if [ "${#account}" -ne 32 ] || printf '%s' "$account" | grep -q '[^0-9a-f]'; then
  echo "CLOUDFLARE_ACCOUNT_ID does not look like an account id (32 lowercase hex characters)." >&2
  exit 1
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN is not set. Use an API token scoped to the dedicated account only, not a wrangler login session; see cloud/README.md." >&2
  exit 1
fi

npm run --silent ci
npx --no-install wrangler d1 migrations apply DB --remote --env "$target"
npx --no-install wrangler deploy --env "$target"
