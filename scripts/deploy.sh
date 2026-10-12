#!/bin/sh
# Deploy the app in one go: secrets, build, upload, restart.
#
#   npm run deploy -- <profile> [target]      from a laptop, with a CLI profile
#   npm run deploy                            from the Databricks web terminal
#   npm run deploy -- - <target>              the web terminal, another target
#
# THE WEB TERMINAL HAS NO PROFILES: its CLI is already signed in as the user,
# through environment variables, and refuses profile flags. With no profile
# given, every command here runs on that sign-in instead.
#
# Safe to repeat. The first time it creates the secret scope, the Lakebase
# project and the app; after that it only uploads the new code and restarts the
# app onto it. Existing secrets are never changed.
set -eu

profile="${1:-}"
[ "$profile" = "-" ] && profile=""
target="${2:-dev}"
case "$profile" in *[!A-Za-z0-9_.-]*) echo "A profile name is letters, digits, dots, dashes and underscores: $profile" >&2; exit 1 ;; esac
if [ -n "$profile" ]; then
  auth="-p $profile"
elif [ -n "${DATABRICKS_HOST:-}" ]; then
  auth=""
else
  echo "usage: npm run deploy -- <profile> [target]" >&2
  echo "(no profile is needed in the Databricks web terminal, which is already signed in)" >&2
  exit 1
fi
# shellcheck disable=SC2086 # $auth is deliberately either empty or two words
bundle() { databricks bundle "$@" -t "$target" $auth; }

# The build runs on this machine, so the tools have to be here.
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22) { console.error(`Node ${process.versions.node} is too old: 22 or newer is needed to build.`); process.exit(1) }'
[ -d node_modules ] || npm ci

echo "==> secrets"
bundle run init_secrets
echo "==> build and upload"
bundle deploy
echo "==> restart onto the new code"
bundle run policy_red_team

name=$(bundle summary -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).resources.apps.policy_red_team.name))')
# shellcheck disable=SC2086
url=$(databricks apps get "$name" $auth -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).url))')

cat <<EOF

Deployed: $url

First time only:
  1. Put the admins in the workspace group named by admin_group
     (policy-red-team-admins unless the target changes it). With SCIM from
     Entra ID, that is an Entra group.
  2. Open $url/admin as one of them and set a token ceiling.
  3. Share it: grant CAN_USE on the app in the Apps UI, ideally to a group.
EOF
