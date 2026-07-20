#!/bin/sh
set -eu

umask 077

mode=${1:-}
component=${2:-}
repository_suffix=${3:-}
case "$component:$repository_suffix" in
  controller:t4-cluster-operator | cluster-server:t4-cluster-server | session-runtime:t4-session-runtime) ;;
  *)
    echo "component and repository suffix do not match the fixed T4 image contract" >&2
    exit 64
    ;;
esac
case "$mode" in
  sbom | vulnerability | provenance) ;;
  *)
    echo "evidence mode must be sbom, vulnerability, or provenance" >&2
    exit 64
    ;;
esac

: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is required}"
: "${HARBOR_REGISTRY:?HARBOR_REGISTRY is required}"
: "${HARBOR_PROJECT:?HARBOR_PROJECT is required}"
: "${HARBOR_USERNAME:?HARBOR_USERNAME is required}"
: "${HARBOR_PASSWORD:?HARBOR_PASSWORD is required}"

artifact_dir="artifacts/cluster-proof/images"
digest=$(cat "$artifact_dir/$component.digest")
case "$digest" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *)
    echo "image digest artifact is malformed" >&2
    exit 65
    ;;
esac
reference="$HARBOR_REGISTRY/$HARBOR_PROJECT/$repository_suffix@$digest"

case "$mode" in
  sbom)
    export SYFT_REGISTRY_AUTH_USERNAME="$HARBOR_USERNAME"
    export SYFT_REGISTRY_AUTH_PASSWORD="$HARBOR_PASSWORD"
    export SYFT_REGISTRY_INSECURE_SKIP_TLS_VERIFY=true
    export SYFT_REGISTRY_INSECURE_USE_HTTP=true
    syft "registry:$reference" -o "spdx-json=$artifact_dir/$component.spdx.json"
    test -s "$artifact_dir/$component.spdx.json"
    ;;
  vulnerability)
    export TRIVY_USERNAME="$HARBOR_USERNAME"
    export TRIVY_PASSWORD="$HARBOR_PASSWORD"
    export TRIVY_INSECURE=true
    trivy image \
      --format json \
      --output "$artifact_dir/$component.trivy.json" \
      --scanners vuln \
      --severity HIGH,CRITICAL \
      --exit-code 1 \
      "$reference"
    test -s "$artifact_dir/$component.trivy.json"
    ;;
  provenance)
    auth_dir=$(mktemp -d)
    trap 'rm -rf "$auth_dir"' EXIT HUP INT TERM
    mkdir -p "$auth_dir/docker"
    auth=$(printf '%s' "$HARBOR_USERNAME:$HARBOR_PASSWORD" | base64 | tr -d '\n')
    printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$HARBOR_REGISTRY" "$auth" > "$auth_dir/docker/config.json"
    unset auth
    export DOCKER_CONFIG="$auth_dir/docker"
    export COSIGN_ALLOW_INSECURE_REGISTRY=1
    cosign download attestation "$reference" > "$artifact_dir/$component.provenance.jsonl"
    test -s "$artifact_dir/$component.provenance.jsonl"
    ;;
esac
