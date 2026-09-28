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

# The scope first: the app's resource declarations name it, so it has to exist
# before the first deploy.
if databricks secrets list-scopes -o json | grep -q "\"name\": *\"$scope\""; then
  echo "scope $scope: exists"
else
  databricks secrets create-scope "$scope"
  echo "scope $scope: created"
fi

has() {
  databricks secrets list-secrets "$scope" -o json | grep -q "\"key\": *\"$1\""
}

if has admin-password; then
  echo "admin-password: already set, left alone"
else
  # Twelve characters is the floor the app enforces; this is twenty-four.
  databricks secrets put-secret "$scope" admin-password \
    --string-value "$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-24)"
  echo "admin-password: generated. Read it with: databricks secrets get-secret $scope admin-password"
fi

if has settings-key; then
  echo "settings-key: already set, left alone"
else
  databricks secrets put-secret "$scope" settings-key --string-value "$(openssl rand -hex 32)"
  echo "settings-key: generated"
fi
