#!/usr/bin/env bash
# End-to-end test: stop.sh adapter -> Python core -> mock HA.
# Exits 0 on success, non-zero on failure.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"; kill $MOCK_PID 2>/dev/null || true' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

# --- 1. Pick a free port and start mock HA.
MOCK_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')

python3 - <<PYEOF >"$WORKDIR/mock.log" 2>&1 &
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a,**k): pass
    def do_POST(self):
        n=int(self.headers.get("Content-Length","0"))
        body=self.rfile.read(n)
        with open("$WORKDIR/last_request.json","w") as f:
            json.dump({"path": self.path, "body": json.loads(body), "auth": self.headers.get("Authorization","")}, f)
        try:
            self.send_response(200)
            self.send_header("Content-Type","application/json")
            self.end_headers()
            self.wfile.write(b"[]")
        except (BrokenPipeError, ConnectionResetError):
            pass
server = http.server.HTTPServer(("127.0.0.1", $MOCK_PORT), H)
server.serve_forever()
PYEOF
MOCK_PID=$!

# Wait for it to come up.
for _ in $(seq 1 60); do
    if python3 -c "import socket,sys; s=socket.socket(); s.settimeout(0.1); s.connect(('127.0.0.1',$MOCK_PORT)); s.close()" 2>/dev/null; then
        break
    fi
    sleep 0.05
done

# --- 2. Build a temp config pointing at the mock.
mkdir -p "$WORKDIR/config" "$WORKDIR/state"
cat > "$WORKDIR/config/config.toml" <<EOF
[ha]
url = "http://127.0.0.1:$MOCK_PORT"
token = "test-token"
verify_ssl = true

[timeouts]
connect_ms = 500
read_ms = 2000

[circuit_breaker]
failure_threshold = 3
open_duration_sec = 300

[[on_stop]]
service = "light.turn_on"
data = { entity_id = "light.test_e2e" }
EOF

export AGENT_HASS_HOOK_CONFIG="$WORKDIR/config/config.toml"
export AGENT_HASS_HOOK_STATE_DIR="$WORKDIR/state"
export AGENT_HASS_HOOK_PYTHON="python3"

# --- 3. Scenario: normal Stop -> HA gets called
rm -f "$WORKDIR/last_request.json"
mkdir -p "$WORKDIR/proj"
echo "{\"cwd\":\"$WORKDIR/proj\",\"session_id\":\"s1\"}" | \
    "$REPO/adapters/claude-code/stop.sh"

[[ -f "$WORKDIR/last_request.json" ]] || fail "scenario 1: no request hit mock HA"
got=$(python3 -c "import json;print(json.load(open('$WORKDIR/last_request.json'))['path'])")
[[ "$got" == "/api/services/light/turn_on" ]] || fail "scenario 1: bad path: $got"
auth=$(python3 -c "import json;print(json.load(open('$WORKDIR/last_request.json'))['auth'])")
[[ "$auth" == "Bearer test-token" ]] || fail "scenario 1: bad auth: $auth"
pass "scenario 1: HA called with correct path and auth"

# --- 4. Scenario: AGENT_HASS_HOOK_DISABLE=1 -> no HA call
rm -f "$WORKDIR/last_request.json"
AGENT_HASS_HOOK_DISABLE=1 "$REPO/adapters/claude-code/stop.sh" \
    <<< "{\"cwd\":\"$WORKDIR/proj\"}"
[[ ! -f "$WORKDIR/last_request.json" ]] || fail "scenario 2: HA was called despite disable env var"
pass "scenario 2: env disable blocks HA call"

# --- 5. Scenario: .no-hass-hook marker -> no HA call, log says project_disabled
rm -f "$WORKDIR/last_request.json"
touch "$WORKDIR/proj/.no-hass-hook"
echo "{\"cwd\":\"$WORKDIR/proj\"}" | "$REPO/adapters/claude-code/stop.sh"
[[ ! -f "$WORKDIR/last_request.json" ]] || fail "scenario 3: HA called despite marker"
grep -q "project_disabled" "$WORKDIR/state/hook.log" || fail "scenario 3: log missing project_disabled"
rm "$WORKDIR/proj/.no-hass-hook"
pass "scenario 3: marker file blocks HA call and logs reason"

# --- 6. Scenario: log file exists and contains a success entry
grep -q '"result":"ok"' "$WORKDIR/state/hook.log" || fail "scenario 4: log missing success entry"
pass "scenario 4: success entries written to log"

# --- 7. Scenario: UserPromptSubmit turns the light OFF
# Rewrite the config with both events, then invoke hook.sh with the event arg.
cat > "$WORKDIR/config/config.toml" <<EOF
[ha]
url = "http://127.0.0.1:$MOCK_PORT"
token = "test-token"
verify_ssl = true

[timeouts]
connect_ms = 500
read_ms = 2000

[circuit_breaker]
failure_threshold = 3
open_duration_sec = 300

[[on_user_prompt_submit]]
service = "light.turn_off"
data = { entity_id = "light.test_e2e" }

[[on_stop]]
service = "light.turn_on"
data = { entity_id = "light.test_e2e" }
EOF

rm -f "$WORKDIR/last_request.json"
echo "{\"cwd\":\"$WORKDIR/proj\",\"session_id\":\"s5\"}" | \
    "$REPO/adapters/claude-code/hook.sh" on_user_prompt_submit

[[ -f "$WORKDIR/last_request.json" ]] || fail "scenario 5: no request hit mock HA"
got=$(python3 -c "import json;print(json.load(open('$WORKDIR/last_request.json'))['path'])")
[[ "$got" == "/api/services/light/turn_off" ]] || fail "scenario 5: bad path: $got"
pass "scenario 5: UserPromptSubmit calls light.turn_off"

echo
echo "All e2e scenarios passed."
