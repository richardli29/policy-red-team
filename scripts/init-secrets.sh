#!/bin/sh
# Create and fill the app's secret scope, once. Run through the bundle:
#
#   databricks bundle run init_secrets -t <target>
#
# Generates what is missing and leaves what is there alone, so running it again
# never changes a password someone is using or a key the stored settings were
# encrypted with. Nothing generated is printed.
set -eu
scope="${SECRET_SCOPE:?SECRET_SCOPE is not set}"

# Exact name matches on parsed JSON, not a grep: a scope or key whose name
# merely contains another's must not count as it.
listed() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"[]");const rows=Array.isArray(j)?j:(j.scopes??j.secrets??[]);process.exit(rows.some(r=>(r.name??r.key)===process.argv[1])?0:1)})' "$1"
}

# The scope first: the app's resource declarations name it, so it has to exist
# before the first deploy.
if databricks secrets list-scopes -o json | listed "$scope"; then
  echo "scope $scope: exists"
else
  databricks secrets create-scope "$scope"
  echo "scope $scope: created"
fi

has() {
  databricks secrets list-secrets "$scope" -o json | listed "$1"
}

# THE VALUE GOES IN ON STDIN, never as an argument: an argument is readable by
# any other user on this machine through `ps` for as long as the CLI runs. It
# is generated into a variable first so a failure stops the script (an
# assignment's status counts under `set -e`; a substitution inside an
# argument's does not) and checked, so an empty or short value is never stored.
put() {
  printf '%s' "$2" | databricks secrets put-secret "$scope" "$1"
}

if has admin-password; then
  echo "admin-password: already set, left alone"
else
  # Twelve characters is the floor the app enforces; this is twenty-four.
  password=$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-24)
  [ "${#password}" -eq 24 ] || { echo "could not generate the admin password" >&2; exit 1; }
  put admin-password "$password"
  unset password
  echo "admin-password: generated. Read it with: databricks secrets get-secret $scope admin-password"
fi

if has settings-key; then
  echo "settings-key: already set, left alone"
else
  key=$(openssl rand -hex 32)
  [ "${#key}" -eq 64 ] || { echo "could not generate the settings key" >&2; exit 1; }
  put settings-key "$key"
  unset key
  echo "settings-key: generated"
fi
