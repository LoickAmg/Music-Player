#!/usr/bin/env bash
# Après un échec de `cargo test` en CI : rend la fin du journal lisible sans connexion (les
# annotations sont publiques, les journaux non), puis relance le dernier test commencé seul,
# puis son module, pour distinguer un test fautif d'un voisin qui plante pendant son tour.
# Lancé depuis src-tauri ; le journal est dans ../cargo-test.log.
set -u
log=../cargo-test.log

# Les annotations n'acceptent qu'une ligne : les retours à la ligne sont encodés.
annotate() {
  local level=$1 title=$2 body=$3
  body=${body//'%'/'%25'}
  body=${body//$'\r'/}
  body=${body//$'\n'/'%0A'}
  echo "::${level} title=${title}::${body}"
}

{
  echo "### Fin du journal de cargo test"
  echo '```'
  tail -n 60 "$log" 2>/dev/null || echo "(pas de journal : échec avant les tests)"
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"

[ -f "$log" ] || exit 0
annotate error "Fin du journal de cargo test" "$(tail -n 25 "$log")"

# Dernier test commencé sans résultat (« test x::y ... » sans « ok » derrière) : celui en cours
# au moment du plantage.
last=$(grep -E '^test [^ ]+ \.\.\. ' "$log" | tail -n 1 | sed -E 's/^test ([^ ]+) \.\.\. .*/\1/')
[ -n "$last" ] || exit 0
module=${last%::*}

run_alone() {
  local label=$1; shift
  local out code
  out=$(RUST_BACKTRACE=1 timeout 300 cargo test --lib -q -- --test-threads=1 "$@" 2>&1)
  code=$?
  annotate warning "Relance : ${label} (code ${code})" "$(printf '%s' "$out" | tail -n 15)"
}

run_alone "${last} seul" --exact "$last"
run_alone "module ${module}" "${module}::"
exit 0
