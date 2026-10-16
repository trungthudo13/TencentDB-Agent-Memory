/**
 * L1 Extraction Prompt: 情境切分 + 记忆提取
 *
 * Based on Kenty's validated prototype prompt (l1_memory_extraction_prompt.md).
 * System prompt handles scene segmentation + memory extraction in a single LLM call.
 * User prompt template fills in previous_scene_name, background_messages, new_messages.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `You are an expert in scene segmentation and memory extraction.
Analyze user conversations, identify scene changes, and extract structured core memories (only persona, episodic, and instruction).

**Output language**: All free-text fields (\`scene_name\`, memory \`content\`) must use the same language as user messages. Keep JSON field names, enum values, and ISO timestamps in English.

### Task 1: Scene Segmentation
Analyze [New messages to extract], using [Previous scene], and determine and output the current conversation scene.
- Inherit: retain the previous scene if there is no clear switch.
- Switch when the user explicitly requests it (such as "change the topic"), changes intent, or introduces an independent goal.
- A conversation may contain one scene or several when topics change repeatedly.
- Naming: "I (AI) am doing xxx (target activity) with xxx (user identity)" (**in the output language above**, about 30-50 characters or equivalent length, one globally unique sentence).

---

### Task 2: Core Memory Extraction
Use the background and current scene, but extract core information only from [New messages to extract].

[General extraction principles]
1. Prefer quality over quantity: filter trivial chat, temporary instructions, and one-off operations (such as "this time" or "this order"); discard unreliable peripheral information.
2. Self-contained: memories must remain valid outside this conversation and understandable without context. Center each extracted statement on "the user (name)" or "AI".
3. Synthesize and merge: combine strongly related or causally linked messages into one complete memory, without fragmentation.

[Three supported memory types] (strictly follow type rules)
> The sentence patterns and trigger words below are structural examples only; **actual \`content\` must use the output language above** (e.g. an English-speaking user → "The user (Maya) is a senior product manager based in Berlin").

1. Personalized memory (type: "persona")
   - Definition: stable user attributes, preferences, skills, values, and habits (such as residence, occupation, dietary restrictions).
   - Pattern: "The user ([name]) likes/is/is skilled at..."
   - Priority: 80-100 (health/restrictions/core traits); 50-70 (general preferences/skills); <50 (vague or minor; may be discarded).
   - Triggers: like, habit, often, I am someone who...

2. Objective event memory (type: "episodic")
   - Definition: objective actions, decisions, plans, or achieved results. Never include purely subjective feelings.
   - Pattern: "The user ([name]) at [preferably an exact absolute time] in [place] [did something, optionally including cause, process, and result]".
   - Time constraints: infer absolute time from the message timestamp where possible. If known, output activity_start_time and activity_end_time in metadata (ISO 8601); omit if uncertain.
   - Priority: 80-100 (important events/plans); 60-70 (ordinary complete activities); <60 (trivial matters; discard).

3. Global instruction memory (type: "instruction")
   - Definition: enduring behavior rules, format preferences, and tone requirements imposed by the user on AI.
   - Pattern: "The user requires/wants AI to respond in future by..."
   - Triggers: always in future, from now on, remember, must.
   - Priority: -1 (extremely strict global commands); 90-100 (core behavior rules); 70-80 (important requirements); <70 (temporary requests; discard).

---

### Content not to extract
- Trivial chat, greetings, or temporary utility requests (such as "translate this for me this time")
- One-off operation instructions (such as "this time" or "this order")
- Duplicate content; the AI assistant's own behavior or output
- Information outside the three types above
- Purely subjective feelings (emotion without an objective event)

---

### Task 3: Output format (JSON)
Return only a valid JSON array. Each item is a scene containing its message range and extracted memories:

[
  {
    "scene_name": "Newly generated or inherited scene name",
    "message_ids": ["List of message IDs belonging to the scene"],
    "memories": [
      {
        "content": "Complete, self-contained memory statement following its type's sentence pattern",
        "type": "persona|episodic|instruction",
        "priority": 80,
        "source_message_ids": ["message_id_1", "message_id_2"],
        "metadata": {}
      }
    ]
  }
]

Metadata field descriptions:
- episodic: if activity times are known, use {"activity_start_time": "ISO8601", "activity_end_time": "ISO8601"}
- Other types or unknown times: output an empty object {}

If the conversation contains no meaningful memories, still output scene segmentation with an empty memories array:
[
  {
    "scene_name": "Scene name",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

Follow the JSON array format strictly. Do not include Markdown code fences (such as \`\`\`json) or explanatory text.`;

export type MemoryPromptMode = "chat" | "code";

export const EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT = `You are an expert in work-scene segmentation and shared team memory extraction.
Analyze work messages from multiple people, identify work-scene changes, and extract structured work memories suitable for sharing within the project team.

This task concerns workplace team collaboration. Focus on project facts, task progress, decisions, methods, SOPs, prohibitions, design approaches, and deliverables with long-term value for collaboration and Agent execution.

**Output language**: All free-text fields (\`scene_name\`, memory \`content\`) must use the dominant language of the messages being processed. Keep JSON field names, enum values, and ISO timestamps in English.

---

### Task 1: Work Scene Segmentation

Analyze [New messages to extract] using [Previous scene] and [Background messages] to determine their work scene.

[Scene definition]
A scene is a group of messages concerning the same project, task, module, requirement, issue, decision, incident, customer scenario, or work goal.

[Inheritance conditions]
Retain the previous scene if new messages continue the same project, task, requirement, issue, or work goal.

[Switching conditions]
Switch or create a new scene when:
1. Discussion shifts to another project, module, requirement, customer, Issue, PR, experiment, incident, or deliverable.
2. The work goal changes clearly, such as from "requirements discussion" to "release scheduling".
3. A new independent task, decision thread, or investigation thread appears.
4. Multiple work topics appear consecutively in one batch; split them into separate scenes.

[Naming rules]
- Name scenes around the work object.
- Suggested format: "The team is advancing [target activity] for [project/module/topic]".
- About 30-50 characters or equivalent length, one globally unique sentence.
- Examples:
  - "The team is designing shared-memory rules for Agent Memory group-chat extraction"
  - "The team is investigating production timeouts in Billing API"
  - "The team is confirming query API requirements for the Andon pilot"

---

### Task 2: Shared Team Work Memory Extraction

Use background and the current scene, but extract shareable core work information only from [New messages to extract].

[General extraction principles]

1. Work collaboration:
   - Memories should help team members or Agents understand project context, continue tasks, reuse experience, or avoid repeated mistakes.
   - Do not extract ordinary greetings, chat, temporary emotions, or one-off tool requests.

2. Team sharing:
   - Extracted content is shared within the project team by default.
   - Extract only work content suitable for team sharing.
   - Do not extract unrelated personal preferences, private life, or sensitive information.

3. Self-contained:
   - Each memory must be understandable outside this conversation.
   - content must include a clear subject, work object, conclusion, status, or method.
   - Avoid context-dependent expressions such as "this", "that", or "as mentioned above".

4. Accurate attribution:
   - An individual's suggestion, concern, or judgment is not a team decision.
   - State a definite conclusion only after explicit confirmation, approval, adoption, or execution arrangements.
   - Express unconfirmed content as "The team is discussing...", "The proposal awaits confirmation...", or "There is a risk of...".

5. Synthesize and merge:
   - Merge strongly related messages into a complete memory.
   - Do not fragment a single work conclusion.
   - Extract different work objects, tasks, or methodologies separately.

6. Extract only from new messages:
   - [Background messages] are only for understanding context, references, and time.
   - Never extract new memories from background messages.
   - source_message_ids must include only message IDs from [New messages to extract].

7. AI / Agent outputs:
   - Do not automatically treat AI suggestions as team facts or decisions.
   - Extract only if human members adopt or confirm them, or the Agent output is an explicit tool result, deliverable, or experiment result.
   - AI drafts, proposals, or analyses explicitly used as future work assets may be extracted as work_artifact or work_method.

---

### Four supported work-memory types

memory \`type\` must be one of these enum values:

1. Work facts (type: "work_fact")

Definition:
Factual information about projects, systems, business, customers, requirements, decisions, status, risks, constraints, and experiment results.

Suitable for extraction:
- Project goals
- Product requirements
- Technical proposals
- Architectural constraints
- Customer feedback
- Decisions
- Current status
- Risks and blockers
- Experiment results
- Terminology definitions
- System facts

Examples:
- "Agent Memory Team uses four layers: L0 Work Event, L1 Work Record, L2 Project Scene Block, and L3 Team Operating Memory."
- "The team decided shared memories should extract only work content and not build personal profiles."
- "The Andon pilot requires memory queries to support project filtering and configurable response fields."
- "Group chats mix work discussion and casual chat, risking extraction of unrelated content."

priority:
- 90-100: key decisions, core requirements, long-term constraints, important risks.
- 70-89: general facts with continuing value for the current project.
- <70: trivial, temporary, low-impact facts; discard.

---

2. Work tasks (type: "work_task")

Definition:
Tasks, action items, and responsibilities requiring future execution, follow-up, confirmation, or delivery.

Suitable for extraction:
- To-do items
- Tasks with a clear owner
- Tasks with a clear deadline
- Issues requiring follow-up
- Blocked items
- Next steps
- Task status changes

Examples:
- "The backend team must design the many-to-many record/event traceability table by Friday."
- "The product team must document permission boundaries for shared team memory."
- "L1 Prompt work-memory types are being consolidated; downstream enums must be updated next."

priority:
- 90-100: tasks blocking delivery, with clear deadlines, or affecting the critical path.
- 70-89: ordinary tasks with a clear owner or next action.
- <70: vague, temporary to-dos without a clear follow-up; discard.

Suggested metadata:
- If the owner is known, use {"owner": "name or ID"}.
- If the deadline is known, use {"deadline": "ISO8601"}.
- If status is known, use {"status": "todo|doing|done|blocked|deferred|cancelled"}.

---

3. Work methods (type: "work_method")

Definition:
Reusable methods, SOPs, processes, principles, prohibitions, design approaches, lessons, criteria, and Agent behavior rules developed by the team.

This is among the most important long-term team memory types. It records not just what happened, but how to handle similar tasks, what to avoid, and which principles to use.

Suitable for extraction:
- SOP
- Collaboration processes
- Design principles
- Technology selection approaches
- Evaluation criteria
- Risk avoidance rules
- Prohibitions and boundaries
- Reusable experience
- Agent execution strategies
- Prompt writing principles
- Project methodologies

Examples:
- "Agent Memory Team L1 extraction should favor a few high-level work types; overly detailed types hinder later aggregation."
- "Shared team memory extraction should prioritize project facts, tasks, methods, and deliverables over ordinary chat."
- "An unconfirmed individual suggestion in a group discussion must not be extracted as a team decision."
- "L1 Prompt should keep its JSON output structure stable, adapting to new scenes primarily through type enums and extraction rules."
- "Work-method memories preserve SOPs, prohibitions, design approaches, and reusable experience for future Agent execution."

priority:
- 90-100: stable core methods reusable across tasks and affecting Agent behavior or team processes.
- 70-89: methods with clear reuse value for later work on the current project.
- <70: overly temporary, vague, or one-off methods; discard.

Suggested metadata:
- If scope is known, use {"scope": "project|team|module|agent|workflow"}.
- If method category is known, use {"method_type": "sop|principle|constraint|anti_pattern|heuristic|evaluation_criterion"}.
- For prohibitions or anti-patterns, use {"method_type": "anti_pattern"}.

---

4. Work assets (type: "work_artifact")

Definition:
Work assets produced, referenced, maintained, or needed later by the team: documents, PRs, Issues, designs, experiment reports, repositories, data tables, meeting notes, Prompts, and draft proposals.

Suitable for extraction:
- Documents
- PR / Issue
- Code branches
- Experiment reports
- Designs
- Meeting notes
- Prompt
- Tables
- Links
- Draft proposals
- Adopted Agent-generated work outputs

Examples:
- "The L1 work-memory extraction Prompt is a core Prompt asset in Agent Memory Team design."
- "The team uses the four-layer work-memory structure as the basis for subsequent L2 and L3 aggregation Prompts."
- "Flowchart versus StateDiagram experiment results can inform the choice of short-term memory compression approaches."

priority:
- 90-100: core documents, key PRs, release assets, important experiment reports.
- 70-89: general work assets that may be reused later.
- <70: temporary files, low-value links, unadopted drafts; discard.

Suggested metadata:
- If asset type is known, use {"artifact_type": "doc|pr|issue|repo|branch|design|report|prompt|dataset|meeting_note"}.
- If a link or identifier is known, use {"artifact_ref": "link, ID, or name"}.

---

### Content not to extract

Generally do not extract:
- Greetings, small talk, jokes, and chat with no work value.
- Temporary one-off requests, such as "fix the formatting this time".
- Unadopted AI suggestions or temporary drafts.
- Details without clear future value.
- Personal preferences, private life, or sensitive information unrelated to team work.

---

### Task 3: Output format (JSON)

Return only a valid JSON array. Each item is a work scene containing its message range and extracted work memories:

[
  {
    "scene_name": "Newly generated or inherited work-scene name",
    "message_ids": ["List of message IDs belonging to the scene"],
    "memories": [
      {
        "content": "Complete, self-contained work-memory statement suitable for team sharing",
        "type": "work_fact|work_task|work_method|work_artifact",
        "priority": 80,
        "source_message_ids": ["message_id_1", "message_id_2"],
        "metadata": {}
      }
    ]
  }
]

Metadata field descriptions:
- All types may use an empty object {}.
- work_task may include owner, deadline, status.
- work_method may include scope, method_type.
- work_artifact may include artifact_type, artifact_ref.
- work_fact may include work_object, status, activity_start_time, activity_end_time.
- Do not include unrelated personal information in metadata.

If the new messages contain no meaningful shared team work memories, still output scene segmentation with an empty memories array:

[
  {
    "scene_name": "Work scene name",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

Follow the JSON array format strictly. Do not include Markdown code fences (such as \`\`\`json) or explanatory text.`;

export function getExtractMemoriesSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT : EXTRACT_MEMORIES_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Format the user prompt for L1 extraction.
 *
 * @param newMessages - Messages to extract memories from (with ids and timestamps)
 * @param backgroundMessages - Previous messages for context only (not for extraction)
 * @param previousSceneName - The last known scene name (for continuity)
 */
export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "None" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
        .join("\n\n")
    : "None";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
    .join("\n\n");

  return `**Output language**: Write \`scene_name\` and memory \`content\` in the dominant language of user messages in [New messages to extract] below.

[Previous scene]:${previousSceneName}

[Background conversation] (only for context, relationships, and time; never extract memories from it):
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[New messages to extract] (use timestamps to infer times; extract memories only from here!):
${newText}`;
}
