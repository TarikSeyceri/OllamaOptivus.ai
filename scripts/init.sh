#!/usr/bin/env sh
# Creates .env from .env.example with strong random secrets (never overwrites existing secrets).
# Usage: ./scripts/init.sh
set -eu

cd "$(dirname "$0")/.."

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi
chmod 600 .env

# A secret is kept only if it looks strong: 32+ characters and not a published default.
strong() {
  value="$(grep -E "^$1=" .env | head -n1 | cut -d= -f2- | tr -d '"' | cut -d, -f1)"
  [ "${#value}" -ge 32 ] && [ "${value}" != "mysecrettoken" ]
}

for name in HTTP_BEARER_TOKEN WORKER_TOKEN; do
  if strong "${name}"; then
    echo "${name} already set - kept"
  else
    value="$(random_secret)"
    if grep -Eq "^${name}=" .env; then
      sed -i.bak "s|^${name}=.*|${name}=${value}|" .env && rm -f .env.bak
    else
      printf '%s=%s\n' "${name}" "${value}" >> .env
    fi
    echo "Generated ${name}"
  fi
done

if grep -Eq '^(PROCESSING_VERBOSE|AUDIOS_DIR|ENABLE_PROCESS_LOCK_MECHANISM)=' .env; then
  echo "Note: .env still contains v1 settings - see docs/migration-v1-to-v2.md"
fi

echo
echo "Your API key (send it as 'Authorization: Bearer <key>'):"
grep -E '^HTTP_BEARER_TOKEN=' .env | cut -d= -f2- | tr -d '"' | cut -d, -f1
echo
echo "Next: docker compose up -d --build   (no NVIDIA GPU: add -f compose.yaml -f compose.cpu.yaml)"
