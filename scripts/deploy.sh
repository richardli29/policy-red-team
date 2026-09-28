#!/bin/sh
# Deploy the app in one go: secrets, build, upload, restart.
#
#   npm run deploy -- <profile> [target]
#
# Safe to repeat. The first time it creates the secret scope, the Lakebase
# project and the app; after that it only uploads the new code and restarts the
# app onto it. Existing secrets are never changed.
set -eu

profile="${1:?usage: npm run deploy -- <profile> [target]}"
target="${2:-dev}"
bundle() { databricks bundle "$@" -t "$target" -p "$profile"; }

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
scope=$(bundle validate -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).variables.secret_scope.value))')
url=$(databricks apps get "$name" -p "$profile" -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).url))')

cat <<EOF

Deployed: $url

First time only:
  1. Admin password:  databricks secrets get-secret $scope admin-password -p $profile -o json \\
                        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).value,"base64").toString()))'
  2. Open $url/admin and set a token ceiling.
  3. Share it: grant CAN_USE on the app in the Apps UI.
EOF
