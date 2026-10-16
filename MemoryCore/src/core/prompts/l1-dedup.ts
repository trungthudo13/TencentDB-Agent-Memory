/**
 * L1 Conflict Detection Prompt (Batch Mode)
 *
 * Based on Kenty's validated prototype prompt (l1_conflict_detection_prompt.md).
 * Batch-compares multiple new memories against a unified candidate pool,
 * supporting cross-type merge and multi-target operations.
 */

import type { MemoryPromptMode } from "../../config.js";
import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer.js";

// ============================
// System Prompt
// ============================

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a memory conflict detector. Compare multiple [New memories] against existing memories in the [Unified candidate memory pool] in a batch, deciding how to handle each.

**Output language**: \`merged_content\` must use the same language as existing memories in the candidate pool. Keep JSON field names, enum values, record_id, and ISO timestamps in English.

## Core rules

- **Cross-type merging**: memories with different types (persona / episodic / instruction / work_fact / work_task / work_method / work_artifact) **may be merged** if they semantically describe the same fact or event.
- **Many-to-many merging**: one new memory may replace/merge **multiple** existing memories in the pool, specified by target_ids.
- Determine the best resulting type (merged_type).

## Decision logic

1. **Identify memory nature**:
   - **State (persona/instruction)**: preferences, traits, long-term settings, stable facts, behavior rules.
   - **Event (episodic)**: one-time experiences and objective timestamped records. Prefer merging the causes and consequences of the same event.

2. **Identify the same fact or event**:
   - Same subject and topic, nearby timestamps, and similar scene_name.

3. **Choose an action**:
   - "store": add the current memory as new information.
   - "skip": existing memory is better; the new memory adds nothing or is vaguer. Ignore it.
   - "update": the same fact or event with more specific, recent, authoritative, or corrected information. Replace the old memory primarily with the new one, retaining old details that remain correct.
   - "merge": the same fact or event or evolution process with complementary, nonconflicting information. Combine into a more complete memory with minimal redundancy.

4. **Preferred strategies**:
   - State: descriptions of the same preference/trait → merge; no new information → skip; explicit changes → update.
   - Event: causes, consequences, and stages of the same event → merge into one complete narrative; identical information → skip.
   - Cross-type example: episodic "The user started podcasting in 2018" + persona "The user has podcast production experience" → persona or episodic, depending on emphasis.

5. **Timestamp handling**:
   - For merge/update, merged_timestamps must contain the **union of timestamps from all related memories**, deduplicated and sorted.
   - This preserves the complete timeline of events.

## Output format

Output only a JSON array, with one decision for each new memory:

[
  {
    "record_id": "record_id of the new memory",
    "action": "store|update|skip|merge",
    "target_ids": ["record_id 1 of a candidate to delete", "record_id 2"],
    "merged_content": "Merged/updated memory content (required for merge/update)",
    "merged_type": "Best merged type: persona|episodic|instruction|work_fact|work_task|work_method|work_artifact (required for merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["Merged timestamp array: union of all new and old memory timestamps (required for merge/update)"]
  }
]

Field descriptions:
- target_ids: **array** of old memory IDs to delete/replace (one or more). Omit or leave empty for store/skip.
- merged_content: final memory text for merge/update; omit for store/skip.
- merged_type: resulting memory type for merge/update, determined by the substance of the merged content.
- merged_priority: new priority after merge/update (integer 0-100, required for merge/update). More complete and certain information should normally receive an **appropriate increase**. For example, two priority-70 memories may become priority 80. Reference: 80-100 (core traits/important events), 60-79 (general preferences/ordinary activities), <60 (minor information).
- merged_timestamps: collect timestamps from the new memory and all merged old memories, deduplicate, and sort.`;

export const WORK_CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a team work-memory conflict detector. Compare multiple [New memories] against existing memories in the [Unified candidate memory pool] in a batch, deciding how to handle each.

**Output language**: \`merged_content\` must use the same language as existing memories in the candidate pool. Keep JSON field names, enum values, record_id, and ISO timestamps in English.

## Core rules

- **Cross-type merging**: memories with different types (work_fact / work_task / work_method / work_artifact) **may be merged** if they semantically describe the same work object, task, method, or asset.
- **Many-to-many merging**: one new memory may replace/merge **multiple** existing memories in the pool, specified by target_ids.
- Determine the best resulting type (merged_type).
- Memories are shared within the project team by default; retain only work-related information.
## Decision logic

1. **Identify memory nature**:
   - **Work facts (work_fact)**: project facts, requirements, decisions, status, risks, constraints, experiment results, customer feedback.
   - **Work tasks (work_task)**: to-dos, owners, deadlines, next steps, task status changes.
   - **Work methods (work_method)**: SOPs, prohibitions, principles, experience, design approaches, criteria, Agent behavior rules.
   - **Work assets (work_artifact)**: documents, PRs, Issues, Prompts, reports, branches, designs, links.

2. **Identify the same work object, task, method, or asset**:
   - Same project, module, requirement, task, risk, decision, method, or asset, with highly similar scene_name or meaning.
   - Different stages of one task, additions to one method, or version/purpose changes to one asset can usually be merged.
   - Do not force-merge different subjects merely because they belong to the same large project.

3. **Choose an action**:
   - "store": add the current memory as new information.
   - "skip": existing memory is better; the new memory adds nothing or is vaguer. Ignore it.
   - "update": the same work object, task, method, or asset with more specific, recent, authoritative, or corrected information. Replace the old memory primarily with the new one, retaining old details that remain correct.
   - "merge": the same work object, task, method, or asset or evolution process with complementary, nonconflicting information. Combine into a more complete memory with minimal redundancy.

4. **Preferred strategies**:
   - work_fact: additions or corrections to the same fact/decision/status → update or merge.
   - work_task: owner/deadline/status changes → update; added dependencies or acceptance criteria → merge.
   - work_method: additions to an SOP/prohibition/principle/experience → merge; clearer general wording → update.
   - work_artifact: purpose/version/link additions to a document/PR/Prompt/report → merge or update.
   - Cross-type example: work_fact "The team decided to keep a few high-level L1 types" + work_method "Avoid overly detailed L1 types, which hinder L2/L3 aggregation" → work_method.

5. **Timestamp handling**:
   - For merge/update, merged_timestamps must contain the **union of timestamps from all related memories**, deduplicated and sorted.
   - This preserves the complete timeline of work facts, tasks, and methods.

## Output format

Output only a JSON array, with one decision for each new memory:

[
  {
    "record_id": "record_id of the new memory",
    "action": "store|update|skip|merge",
    "target_ids": ["record_id 1 of a candidate to delete", "record_id 2"],
    "merged_content": "Merged/updated memory content (required for merge/update)",
    "merged_type": "Best merged type: work_fact|work_task|work_method|work_artifact (required for merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["Merged timestamp array: union of all new and old memory timestamps (required for merge/update)"]
  }
]

Field descriptions:
- target_ids: **array** of old memory IDs to delete/replace (one or more). Omit or leave empty for store/skip.
- merged_content: final memory text for merge/update; omit for store/skip.
- merged_type: resulting memory type for merge/update, determined by the substance of the merged content.
- merged_priority: new priority after merge/update (integer 0-100, required for merge/update). More complete and certain information should normally receive an **appropriate increase**. Reference: 80-100 (key facts, important tasks, core methods, important assets), 60-79 (general work information), <60 (minor information).
- merged_timestamps: collect timestamps from the new memory and all merged old memories, deduplicate, and sort.`;

export function getConflictDetectionSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? WORK_CONFLICT_DETECTION_SYSTEM_PROMPT : CONFLICT_DETECTION_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Candidate search result for a single new memory.
 */
export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
}

/**
 * Format the batch conflict detection prompt using a unified candidate pool.
 *
 * Format (aligned with prototype):
 * 1. Unified candidate pool: de-duplicated list of all existing candidates across all new memories
 * 2. Per new memory: content + list of related candidate IDs from the pool
 *
 * This approach lets the LLM see the global picture and handle cross-memory dedup in one pass.
 *
 * @param matches - Array of new memories with their candidate matches
 */
export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  // Step 1: Build unified candidate pool (de-duplicate across all new memories)
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  // Step 2: Format unified pool as JSON
  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
  }));

  let poolSection: string;
  if (poolList.length === 0) {
    poolSection = "## Unified candidate memory pool\n\n(Empty; no existing memories. Use store for all new memories.)";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## Unified candidate memory pool (${poolList.length} existing memories)\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[] (No similar candidates; use store directly)";

    const memStr = JSON.stringify(
      {
        record_id: m.newMemory.record_id,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.scene_name,
      },
      null,
      2,
    );

    return `### New memory ${idx + 1} (record_id: ${m.newMemory.record_id})\n${memStr}\n\n[Related candidate IDs]${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `**Output language**: \`merged_content\` must use the same language as existing memories in the candidate pool.

${poolSection}

${"═".repeat(50)}

## New memories to evaluate (${matches.length} total)

${newMemoriesText}

Evaluate each memory and output a JSON decision array. If a new memory has no candidates, output action=store for it.`;
}
