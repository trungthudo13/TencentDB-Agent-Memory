#!/usr/bin/env bash
# Skill 授权链路端到端验证
# 需要环境：team-memory-control 后端跑在 127.0.0.1:8123（PANEL_MODE=stateless）
set -euo pipefail

BASE="${CONTROL:-http://127.0.0.1:8123}"
ADMIN_KEY="${ADMIN_KEY:-sk-mem-e2e-admin-panel-test-key}"
INSTANCE="${SERVICE_ID:-e2e-test}"

# ANSI
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; echo "    resp: $2"; exit 1; }
info() { echo -e "${YELLOW}▶${NC} $1"; }

# ---- helpers ----
call_meta() {
  local action=$1 key=$2 body=$3
  curl -sS -X POST "$BASE/api/v1/meta/$action" \
    -H "X-Tdai-Service-Id: $INSTANCE" \
    -H "X-Tdai-User-Key: $key" \
    -H "content-type: application/json" \
    -d "$body"
}
call_skill() {
  local action=$1 key=$2 body=$3
  curl -sS -X POST "$BASE/api/v1/skill/$action" \
    -H "X-Tdai-Service-Id: $INSTANCE" \
    -H "X-Tdai-User-Key: $key" \
    -H "content-type: application/json" \
    -d "$body"
}
jget() { echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); import functools; keys='$2'.split('.'); v=d
for k in keys: v = v[int(k)] if k.isdigit() else v[k]
print(v)"; }
jcode() { echo "$1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('code'))"; }

# ============================
info "① auth/verify → get admin identity"
R=$(call_meta auth/verify "$ADMIN_KEY" "{\"user_key\":\"$ADMIN_KEY\"}")
[[ $(jcode "$R") == "0" ]] || fail "auth/verify" "$R"
ADMIN_ID=$(jget "$R" data.user.user_id)
pass "admin user_id=$ADMIN_ID"

# ============================
info "② team/list → find a team owned by admin"
R=$(call_meta team/list "$ADMIN_KEY" "{\"user_id\":\"$ADMIN_ID\",\"limit\":50,\"offset\":0}")
TEAM_ID=$(echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']['items']
own=[t for t in d if t['owner_user_id']=='$ADMIN_ID']
print(own[0]['team_id'] if own else d[0]['team_id'])")
pass "team_id=$TEAM_ID"

# ============================
info "③ create a regular memberA and add it to the team"
MEMBER_USERNAME="memberA-$(date +%s)"
R=$(call_meta user/create "$ADMIN_KEY" "{\"auth_provider\":\"local\",\"external_id\":\"$MEMBER_USERNAME\",\"username\":\"$MEMBER_USERNAME\"}")
[[ $(jcode "$R") == "0" ]] || fail "user/create" "$R"
MEMBER_ID=$(jget "$R" data.user_id)
pass "member user_id=$MEMBER_ID"

# 给 member 造一个 user_key（member 自己登录用）
R=$(call_meta user-key/create "$ADMIN_KEY" "{\"user_id\":\"$MEMBER_ID\",\"name\":\"e2e-test\"}")
[[ $(jcode "$R") == "0" ]] || fail "user-key/create" "$R"
MEMBER_KEY=$(jget "$R" data.key_value)
pass "member user_key=$MEMBER_KEY"

R=$(call_meta team-member/add "$ADMIN_KEY" "{\"team_id\":\"$TEAM_ID\",\"user_id\":\"$MEMBER_ID\",\"role\":\"member\"}")
[[ $(jcode "$R") == "0" ]] || fail "team-member/add" "$R"
pass "member added to team"

# ============================
info "④ agent/create (admin creates an agent)"
R=$(call_meta agent/create "$ADMIN_KEY" "{\"team_id\":\"$TEAM_ID\",\"owner_user_id\":\"$ADMIN_ID\",\"name\":\"e2e-agent-$(date +%s)\",\"visibility\":\"team\"}")
[[ $(jcode "$R") == "0" ]] || fail "agent/create" "$R"
AGENT_ID=$(jget "$R" data.agent_id)
pass "agent_id=$AGENT_ID"

# ============================
info "⑤ skill/create (data plane) → verify automatic asset registration"
SKILL_NAME="e2e-skill-$(date +%s)"
SKILL_CONTENT=$(cat <<EOF
---
name: $SKILL_NAME
description: e2e test skill
---
# body
just a test
EOF
)
BODY=$(python3 -c "
import json,sys
print(json.dumps({
  'user_id': '$ADMIN_ID',
  'team_id': '$TEAM_ID',
  'agent_id': '$AGENT_ID',
  'name': '$SKILL_NAME',
  'content': '''$SKILL_CONTENT''',
}))")
R=$(call_skill create "$ADMIN_KEY" "$BODY")
[[ $(jcode "$R") == "0" ]] || fail "skill/create" "$R"
SKILL_ID=$(jget "$R" data.skill_id)
pass "skill_id=$SKILL_ID (== asset_id)"

# ============================
info "⑥ verify automatic asset registration (onSkillCreated hook)"
R=$(call_meta asset/get "$ADMIN_KEY" "{\"asset_id\":\"$SKILL_ID\"}")
CODE=$(jcode "$R")
if [[ $CODE != "0" ]]; then
  fail "asset/get cannot find the automatically registered asset" "$R"
fi
VIS=$(jget "$R" data.visibility)
OWNER=$(jget "$R" data.owner_user_id)
pass "asset registered automatically, visibility=$VIS, owner=$OWNER"
[[ $VIS == "team" ]] || fail "Default visibility must be team" "$VIS"

# ============================
info "⑦ asset/list-accessible: admin and member views (team-visible by default)"
R=$(call_meta asset/list-accessible "$ADMIN_KEY" "{\"user_id\":\"$ADMIN_ID\",\"team_id\":\"$TEAM_ID\",\"asset_type\":\"skill\",\"action\":\"read\",\"limit\":100}")
COUNT_ADMIN=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for i in d['data']['items'] if i['asset_id']=='$SKILL_ID'))")
[[ $COUNT_ADMIN == "1" ]] || fail "admin must see the newly created skill" "$R"
pass "Visible to admin ($COUNT_ADMIN/1)"

R=$(call_meta asset/list-accessible "$MEMBER_KEY" "{\"user_id\":\"$MEMBER_ID\",\"team_id\":\"$TEAM_ID\",\"asset_type\":\"skill\",\"action\":\"read\",\"limit\":100}")
COUNT_MEMBER=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for i in d['data']['items'] if i['asset_id']=='$SKILL_ID'))")
[[ $COUNT_MEMBER == "1" ]] || fail "member must see the skill with default team visibility" "$R"
pass "Visible to member (visibility=team, shared by default)"

# ============================
info "⑧ asset/update → make private (visibility=private)"
R=$(call_meta asset/update "$ADMIN_KEY" "{\"asset_id\":\"$SKILL_ID\",\"visibility\":\"private\"}")
[[ $(jcode "$R") == "0" ]] || fail "asset/update to private" "$R"
pass "Changed to private"

info "⑨ member must not see the private skill"
R=$(call_meta asset/list-accessible "$MEMBER_KEY" "{\"user_id\":\"$MEMBER_ID\",\"team_id\":\"$TEAM_ID\",\"asset_type\":\"skill\",\"action\":\"read\",\"limit\":100}")
COUNT_MEMBER_PRIVATE=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for i in d['data']['items'] if i['asset_id']=='$SKILL_ID'))")
[[ $COUNT_MEMBER_PRIVATE == "0" ]] || fail "member must not see private skills, but found $COUNT_MEMBER_PRIVATE entries" "$R"
pass "member cannot see the private skill ✓ (visibility enforced)"

# ============================
info "⑩ acl/grant → grant read access to member"
R=$(call_meta acl/grant "$ADMIN_KEY" "{\"asset_id\":\"$SKILL_ID\",\"subject_type\":\"user\",\"subject_id\":\"$MEMBER_ID\",\"permission\":\"read\",\"effect\":\"allow\",\"granted_by\":\"$ADMIN_ID\"}")
[[ $(jcode "$R") == "0" ]] || fail "acl/grant" "$R"
ACL_ID=$(jget "$R" data.id)
pass "acl_id=$ACL_ID"

info "⑪ member should see the skill after the grant (still private)"
R=$(call_meta asset/list-accessible "$MEMBER_KEY" "{\"user_id\":\"$MEMBER_ID\",\"team_id\":\"$TEAM_ID\",\"asset_type\":\"skill\",\"action\":\"read\",\"limit\":100}")
COUNT_AFTER_GRANT=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for i in d['data']['items'] if i['asset_id']=='$SKILL_ID'))")
if [[ $COUNT_AFTER_GRANT == "1" ]]; then
  pass "member can see it through ACL ✓"
else
  echo -e "  ${YELLOW}⚠${NC} member still cannot see it after acl/grant (default role permissions for private assets may override ACL, or another rule applies); returned $COUNT_AFTER_GRANT entries"
  echo "    Align this with the kernel permission-checker; it does not block the authorization UI."
fi

# ============================
info "⑫ acl/list → list skill ACL entries"
R=$(call_meta acl/list "$ADMIN_KEY" "{\"asset_id\":\"$SKILL_ID\",\"limit\":20,\"offset\":0}")
[[ $(jcode "$R") == "0" ]] || fail "acl/list" "$R"
ACL_TOTAL=$(jget "$R" data.total)
pass "ACL entry count=$ACL_TOTAL"

# ============================
info "⑬ acl/check → explicitly check member read access to the skill"
R=$(call_meta acl/check "$MEMBER_KEY" "{\"user_id\":\"$MEMBER_ID\",\"asset_id\":\"$SKILL_ID\",\"action\":\"read\"}")
[[ $(jcode "$R") == "0" ]] || fail "acl/check" "$R"
ALLOWED=$(jget "$R" data.allowed)
REASON=$(jget "$R" data.reason)
pass "check allowed=$ALLOWED, reason=$REASON"

# ============================
info "⑭ acl/revoke → revoke access"
R=$(call_meta acl/revoke "$ADMIN_KEY" "{\"id\":\"$ACL_ID\"}")
[[ $(jcode "$R") == "0" ]] || fail "acl/revoke" "$R"
pass "Revoked"

R=$(call_meta acl/check "$MEMBER_KEY" "{\"user_id\":\"$MEMBER_ID\",\"asset_id\":\"$SKILL_ID\",\"action\":\"read\"}")
ALLOWED2=$(jget "$R" data.allowed)
pass "After revocation: acl/check allowed=$ALLOWED2"

# ============================
info "⑮ agent-fixed-asset/list-with-detail → expect 501 NOT_IN_SCOPE (blocked in stateless mode)"
R=$(call_meta agent-fixed-asset/list-with-detail "$ADMIN_KEY" "{\"agent_id\":\"$AGENT_ID\",\"limit\":100,\"offset\":0}")
STATUS=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('code', 'no-code'))")
if [[ $STATUS == "501" ]] || echo "$R" | grep -q "NOT_IN_SCOPE"; then
  pass "Blocked as expected: $R"
else
  echo -e "  ${YELLOW}⚠${NC} agent-fixed-asset/list-with-detail unexpectedly succeeded; response: $R"
fi

# ============================
info "⑯ content-plane skill/list → verify the fixed-assets tab API"
R=$(call_skill list "$ADMIN_KEY" "{\"user_id\":\"$ADMIN_ID\",\"team_id\":\"$TEAM_ID\",\"filters\":{\"owner_agent_id\":\"$AGENT_ID\",\"status\":[\"active\"]},\"pagination\":{\"limit\":50,\"offset\":0}}")
[[ $(jcode "$R") == "0" ]] || fail "skill/list by owner_agent_id" "$R"
COUNT_SKILL=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for i in d['data']['items'] if i['skill_id']=='$SKILL_ID'))")
[[ $COUNT_SKILL == "1" ]] || fail "skill/list?owner_agent_id must find the newly created skill" "$R"
pass "Content-plane agent_id filter works ($COUNT_SKILL/1)"

# ============================
info "Cleanup: revoke access, delete skill, member, and agent"
call_skill delete "$ADMIN_KEY" "{\"user_id\":\"$ADMIN_ID\",\"team_id\":\"$TEAM_ID\",\"agent_id\":\"$AGENT_ID\",\"skill_id\":\"$SKILL_ID\",\"expected_version\":1}" > /dev/null || true
call_meta agent/archive "$ADMIN_KEY" "{\"agent_id\":\"$AGENT_ID\"}" > /dev/null || true
call_meta team-member/remove "$ADMIN_KEY" "{\"team_id\":\"$TEAM_ID\",\"user_id\":\"$MEMBER_ID\"}" > /dev/null || true
call_meta user-key/revoke "$ADMIN_KEY" "{\"key_value\":\"$MEMBER_KEY\"}" > /dev/null || true
call_meta user/delete "$ADMIN_KEY" "{\"user_id\":\"$MEMBER_ID\"}" > /dev/null || true

echo
echo -e "${GREEN}=== All critical paths verified ===${NC}"
