/**
 * 生成新面板 (stateless)链路 A OpenAPI 3.0.
 * 运行：pnpm generate:meta-openapi
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  META_ACTIONS,
  META_LIST_ACTIONS,
  isNotInScopeAction,
} from '../src/panel/api/meta-actions.js';

const OUT = join(process.cwd(), 'docs/api/meta-api.openapi.yaml');

const ACTION_TAG: Record<string, string> = {
  user: 'Meta · User',
  'user-key': 'Meta · User Key',
  team: 'Meta · Team',
  'team-member': 'Meta · Team Member',
  agent: 'Meta · Agent',
  task: 'Meta · Task',
  'task-agent': 'Meta · Task Agent',
  asset: 'Meta · Asset',
  'agent-fixed-asset': 'Meta · Agent Fixed Asset',
  acl: 'Meta · ACL',
  auth: 'Meta · Auth',
};

const AUTH_VERIFY = 'auth/verify';

function tagFor(action: string): string {
  const prefix = action.includes('/') ? action.slice(0, action.indexOf('/')) : action;
  if (action.startsWith('team-member')) return ACTION_TAG['team-member'] ?? 'Meta';
  if (action.startsWith('user-key')) return ACTION_TAG['user-key'] ?? 'Meta';
  if (action.startsWith('task-agent')) return ACTION_TAG['task-agent'] ?? 'Meta';
  if (action.startsWith('agent-fixed-asset')) return ACTION_TAG['agent-fixed-asset'] ?? 'Meta';
  return ACTION_TAG[prefix] ?? 'Meta';
}

function yamlQuote(s: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function panelDescription(action: string): string {
  if (isNotInScopeAction(action)) {
    return 'Phase 1 does **not forward** to the kernel; Control returns HTTP 501 with `message=NOT_IN_SCOPE`.';
  }
  if (action === AUTH_VERIFY) {
    return 'Login verification: only `X-Tdai-Service-Id` is required in headers; the body must contain `user_key`. Check `data.valid` for validity (soft validation).';
  }
  if (action === 'user/list') {
    return 'Transparent proxy; only system_admin may omit team_id (instance-level list). Optional user_ids and exact username filters. UserPublic includes username.';
  }
  if (action === 'team-member/list') {
    return 'Paginated list; team_id is required in the body. Items are TeamMemberEntity (username joined at read time, v3.2.2+). Active team members only. Default order: joined_at DESC. Both header credentials are required.';
  }
  if (action === 'team-member/get') {
    return 'Transparent proxy; TeamMemberEntity includes username (v3.2.2+, joined at read time). Active team membership and both header credentials are required.';
  }
  if (action === 'team-member/add') {
    return 'Transparent proxy; team admin only. Cannot add yourself or demote the owner. TeamMemberEntity does **not include** username (v3.2.2+); use team-member/list after adding to obtain display names. v3.2.3+: adding an active member with the same role returns 409 member_already_exists.';
  }
  if (action === 'team-member/remove') {
    return 'Transparent proxy; team admin only. Cannot remove the team owner (403 cannot remove team owner). Permanently deletes the membership row. Both header credentials are required.';
  }
  if (action === 'team/update') {
    return 'Transparent proxy; team owner or admin only. owner_user_id cannot be changed (silently ignored). See 08-metadata-v3-api-reference.md for fields. Both header credentials are required.';
  }
  if (action === 'agent/update') {
    return 'Transparent proxy; agent owner only. owner_user_id cannot be changed (silently ignored). See 08-metadata-v3-api-reference.md for fields. Both header credentials are required.';
  }
  if (action === 'user/create' || action === 'user/delete') {
    return 'Transparent proxy; `X-Tdai-User-Key` must belong to a system_admin. The kernel returns 403 for non-admin users.';
  }
  if (META_LIST_ACTIONS.has(action)) {
    return 'Paginated list; optional limit (default 20, maximum 100) and offset (default 0). Default order: created_at DESC (v3.1.2+; team-member uses joined_at DESC). Both header credentials are required.';
  }
  return 'Transparent proxy to the kernel; see 08-metadata-v3-api-reference.md for fields. Both header credentials are required.';
}

function buildMetaPostPath(action: string): string {
  const lines: string[] = [];
  lines.push(`  /api/v1/meta/${action}:`);
  lines.push('    post:');
  lines.push(`      tags: [${yamlQuote(tagFor(action))}]`);
  lines.push(`      operationId: meta_${action.replace(/\//g, '_')}`);
  lines.push(`      summary: ${action}`);
  lines.push(`      description: ${yamlQuote(panelDescription(action))}`);
  lines.push('      security: []');
  lines.push('      parameters:');
  lines.push("        - $ref: '#/components/parameters/TdaiServiceId'");
  if (action !== AUTH_VERIFY) {
    lines.push("        - $ref: '#/components/parameters/TdaiUserKey'");
  }
  lines.push('      requestBody:');
  lines.push('        required: true');
  lines.push('        content:');
  lines.push('          application/json:');
  lines.push('            schema:');
  lines.push('              type: object');
  lines.push('              additionalProperties: true');
  lines.push('      responses:');
  lines.push("        '200':");
  lines.push('          description: Kernel-style envelope (check body.code for business success)');
  lines.push('          content:');
  lines.push('            application/json:');
  lines.push('              schema:');
  lines.push("                $ref: '#/components/schemas/ApiResponse'");
  if (isNotInScopeAction(action)) {
    lines.push("        '501':");
    lines.push('          $ref: "#/components/responses/NotInScope"');
  }
  lines.push("        '400':");
  lines.push('          $ref: "#/components/responses/ControlBadRequest"');
  lines.push("        '502':");
  lines.push('          $ref: "#/components/responses/KernelUnavailable"');
  lines.push("        '504':");
  lines.push('          $ref: "#/components/responses/KernelTimeout"');
  return lines.join('\n');
}

const header = `openapi: 3.0.3
info:
  title: Team Memory Control — Panel Metadata API (stateless)
  description: |
    Panel Control **stateless proxy**: \`/api/v1/meta/*\` transparently forwards to the memory kernel \`/v3/meta/*\` (v3.1).

    **Authentication (headers, no cookies)**
    - \`X-Tdai-Service-Id\`: Instance ID (from \`GET /meta/instances\`; equals kernel \`x-tdai-service-id\`)
    - \`X-Tdai-User-Key\`: User key \`sk-mem-…\` (\`auth/verify\` excepted; user_key belongs only in the body)

    **Response envelope** \`{ code, message, request_id, data }\`
    - \`code === 0\` → HTTP **200** (Request succeeded)
    - \`code ∈ [400, 599]\` → HTTP status **equals** code
    - Soft validation: \`auth/verify\` checks \`data.valid\` ; \`acl/check\` checks \`data.allowed\`

    Design documentation: [09-new-panel-control-backend-design.md](../architecture/09-new-panel-control-backend-design.md)
    Authoritative kernel fields: [08-metadata-v3-api-reference.md](../architecture/08-metadata-v3-api-reference.md)
  version: 1.3.1
  contact:
    name: team-memory-control

servers:
  - url: http://127.0.0.1:8123
    description: Local Control (\`PANEL_MODE=stateless\` or \`pnpm dev:panel\`)
  - url: https://{controlHost}
    description: Deployment environment
    variables:
      controlHost:
        default: control.example.com

tags:
  - name: Meta · Control
    description: Control helper endpoints
  - name: Meta · User
  - name: Meta · User Key
  - name: Meta · Team
  - name: Meta · Team Member
  - name: Meta · Agent
  - name: Meta · Task
  - name: Meta · Task Agent
  - name: Meta · Asset
  - name: Meta · Agent Fixed Asset
  - name: Meta · ACL
  - name: Meta · Auth

paths:
  /api/v1/meta/instances:
    get:
      tags: [Meta · Control]
      operationId: meta_instances_list
      summary: Memory instance list (before login)
      description: |
        Returns all configured memory instances, **without pagination**.
        Only exposes \`instance_id\`, \`name\` (excluding gateway_endpoint / api_key).
        Configuration: \`METADATA_INSTANCES_CONFIG\` (default \`./config/metadata-instances.json\`).
      security: []
      responses:
        '200':
          description: Public instance list
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/MetadataInstanceListResponse'
              example:
                instances:
                  - instance_id: default
                    name: Community development demo instance
                  - instance_id: sre-platform
                    name: SRE platform instance
`;

const metaPaths = META_ACTIONS.map(buildMetaPostPath).join('\n');

const components = `
components:
  parameters:
    TdaiServiceId:
      name: X-Tdai-Service-Id
      in: header
      required: true
      schema:
        type: string
      description: Memory instance ID (= registry id = kernel x-tdai-service-id)
      example: default
    TdaiUserKey:
      name: X-Tdai-User-Key
      in: header
      required: true
      schema:
        type: string
      description: User API key sk-mem-… (auth/verify does not use this header)
      example: sk-mem-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

  responses:
    ControlBadRequest:
      description: Control validation error (not forwarded to the kernel)
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 400
            message: INVALID_INSTANCE
            request_id: req-example
            data: null
    NotInScope:
      description: Action domains disabled in panel phase 1 (asset / agent-fixed-asset)
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 501
            message: NOT_IN_SCOPE
            request_id: req-example
            data: null
    KernelUnavailable:
      description: Kernel unreachable
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 502
            message: KERNEL_UNAVAILABLE
            request_id: req-example
            data: null
    KernelTimeout:
      description: Kernel timeout
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 504
            message: KERNEL_TIMEOUT
            request_id: req-example
            data: null

  schemas:
    PublicMetadataInstance:
      type: object
      required: [instance_id, name]
      properties:
        instance_id:
          type: string
          description: Memory instance ID (corresponds to kernel x-tdai-service-id)
          example: default
        name:
          type: string
          description: Display name on the login page
          example: Community development demo instance

    MetadataInstanceListResponse:
      type: object
      required: [instances]
      properties:
        instances:
          type: array
          items:
            $ref: '#/components/schemas/PublicMetadataInstance'

    ApiResponse:
      type: object
      required: [code, message, request_id, data]
      properties:
        code:
          type: integer
          description: |
            0 = Request succeeded.
            For codes 400–599, the HTTP status equals code.
            Check code first for business success ; then data.valid / data.allowed for soft validation.
          example: 0
        message:
          type: string
          example: ok
        request_id:
          type: string
          example: req-a1b2c3d4
        data:
          nullable: true
          description: Success payload ; usually null on failure

    PaginatedResult:
      type: object
      required: [items, total, limit, offset]
      properties:
        items:
          type: array
          items:
            type: object
            additionalProperties: true
        total:
          type: integer
        limit:
          type: integer
          minimum: 1
          maximum: 100
        offset:
          type: integer
          minimum: 0

    PaginationInput:
      type: object
      properties:
        limit:
          type: integer
          minimum: 1
          maximum: 100
          default: 20
        offset:
          type: integer
          minimum: 0
          default: 0
`;

const yaml = [header, metaPaths, components].join('\n');
writeFileSync(OUT, yaml, 'utf8');
console.log(`Wrote ${OUT} (${META_ACTIONS.length} POST actions + GET instances)`);
